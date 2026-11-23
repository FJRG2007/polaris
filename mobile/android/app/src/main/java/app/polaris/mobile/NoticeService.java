package app.polaris.mobile;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Messages and calls as notifications while Polaris is not on screen.
 *
 * The page raises a toast only while it runs, and a WebView has no Web Push, so this service keeps one connection
 * open to the instance (`/api/mobile/notices`) and turns each frame into a notification. It needs no Google account
 * and no setup: the instance decides what is news exactly as it does for a browser, and the phone only draws it.
 * Android requires a service like this to show that it is running. Messaging apps that go through Google's push
 * (FCM) need no such service; a self-hosted instance has no push relay of its own, so this connection is the delivery
 * path and the notice is its cost. It is made as small as Android allows and one tap hides it for good (turning the
 * "Connection" channel off does not stop the service), see `onStartCommand`.
 */
public final class NoticeService extends Service {
    private static final String CONNECTION = "connection";
    private static final String MESSAGES = "messages";
    static final String SIGN_IN = "sign_in";
    private static final int RUNNING_ID = 1;
    static final int NOTICE_ID = 2;
    /** What came of an answer to a sign-in, under the request's own tag. */
    static final int RESULT_ID = 3;
    private static final long MAX_BACKOFF_MS = 60_000;

    /** Whether the app is on screen, where the page already says it. */
    static volatile boolean pageVisible;

    private volatile boolean running;
    private Thread worker;
    /** The connection open now, closed when the service stops: another Polaris chosen must not keep this one. */
    private volatile HttpURLConnection current;

    /** Stops listening to the Polaris it was connected to; the next start connects to the one open now. */
    static void restart(Context context) {
        context.stopService(new Intent(context, NoticeService.class));
        start(context);
    }

    /** Starts it, when there is a Polaris to listen to and Android lets notifications through. */
    static void start(Context context) {
        if (ServerStore.origin(context) == null) return;
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        Intent intent = new Intent(context, NoticeService.class);
        try {
            context.startForegroundService(intent);
        } catch (RuntimeException refused) {
            // Started from the background where Android does not allow it; the next launch starts it.
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels();
        // As quiet as Android lets a running service be: folded at the bottom of the shade, no icon in the status bar,
        // no sound, nothing on the lock screen, and swipeable. Tapping it lands on the switch that hides it for good,
        // whose page says why it is there (the channel's description); messages keep arriving either way.
        Notification connected = new Notification.Builder(this, CONNECTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notices_connected))
                .setContentText(getString(R.string.notices_connected_hide))
                .setContentIntent(hideConnection())
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .setShowWhen(false)
                .setLocalOnly(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(RUNNING_ID, connected, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(RUNNING_ID, connected);
        }
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::listen, "notices");
            worker.start();
        }
        return START_STICKY;
    }

    private void channels() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel connection = new NotificationChannel(CONNECTION, getString(R.string.notices_channel_connection), NotificationManager.IMPORTANCE_MIN);
        connection.setShowBadge(false);
        connection.setDescription(getString(R.string.notices_channel_connection_about));
        connection.setSound(null, null);
        connection.enableVibration(false);
        connection.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(connection);
        manager.createNotificationChannel(new NotificationChannel(MESSAGES, getString(R.string.notices_channel_messages), NotificationManager.IMPORTANCE_HIGH));
        IncomingCall.channel(this);
        manager.createNotificationChannel(new NotificationChannel(SIGN_IN, getString(R.string.notices_channel_sign_in), NotificationManager.IMPORTANCE_HIGH));
    }

    private void listen() {
        long backoff = 2_000;
        while (running) {
            String origin = ServerStore.origin(this);
            if (origin == null) break;
            try {
                int status = read(origin);
                // Signed out on this phone: nothing to listen for until the app is opened again.
                if (status == 401 || status == 403) break;
                backoff = 2_000;
            } catch (IOException dropped) {
                // Offline, the server restarting, a network change: try again, a little later each time.
            }
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException stopped) {
                break;
            }
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
        stopSelf();
    }

    /** One connection, read until it ends. Returns the status when it was refused. */
    private int read(String origin) throws IOException {
        String address = origin + "/api/mobile/notices";
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        current = connection;
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            // Twice the heartbeat: a connection that has gone quiet longer than that is dead.
            connection.setReadTimeout(60_000);
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("User-Agent", AppAgent.of(this));
            String cookie = HostProfiles.cookieFor(this, address);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            int status = connection.getResponseCode();
            if (status != 200) return status;
            try (BufferedReader lines = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder data = new StringBuilder();
                String line;
                while (running && (line = lines.readLine()) != null) {
                    if (line.startsWith("data:")) data.append(line.substring(5).trim());
                    else if (line.isEmpty() && data.length() > 0) {
                        show(origin, data.toString());
                        data.setLength(0);
                    }
                }
            }
            return status;
        } finally {
            connection.disconnect();
        }
    }

    private void show(String origin, String json) {
        try {
            JSONObject notice = new JSONObject(json);
            String kind = notice.optString("kind");
            String tag = notice.optString("tag");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if ("call-ended".equals(kind)) {
                IncomingCall.stop(this, tag);
                return;
            }
            if ("sign-in-ended".equals(kind)) {
                manager.cancel(tag, NOTICE_ID);
                return;
            }
            // Somebody signing in elsewhere, asking this phone: shown even with the app open, the page is elsewhere.
            if ("sign-in".equals(kind)) {
                askSignIn(manager, origin, notice);
                return;
            }
            // On screen, the page already showed it.
            if (pageVisible) return;
            String path = notice.optString("path", "/");
            if (!path.startsWith("/")) path = "/";
            if ("call".equals(kind)) {
                // Rung like a phone call. An instance too old to name the call sends neither field; its ring is the
                // plain notification below, on the same channel.
                String meetingId = notice.optString("meetingId");
                String caller = notice.optString("caller", notice.optString("title"));
                if (IncomingCall.validMeeting(meetingId) && !tag.isEmpty()) {
                    IncomingCall.ring(this, origin, tag, path, meetingId, caller);
                    return;
                }
            }
            Notification.Builder built = new Notification.Builder(this, "call".equals(kind) ? IncomingCall.CHANNEL : MESSAGES)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(notice.optString("title"))
                    .setAutoCancel(true)
                    .setContentIntent(open(Uri.parse(origin + path), tag.hashCode()))
                    .setCategory("call".equals(kind) ? Notification.CATEGORY_CALL : Notification.CATEGORY_MESSAGE);
            String body = notice.optString("body");
            if (!body.isEmpty()) built.setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body));
            manager.notify(tag, NOTICE_ID, built.build());
        } catch (Exception unreadable) {
            // A frame this version does not understand is skipped, never shown half-read.
        }
    }

    /**
     * "Is this you?". Deny is answered from the notification; Approve - and tapping the notification - opens
     * {@link SignInConfirmActivity}, where the number on the sign-in screen is picked and the phone's lock confirms it.
     */
    private void askSignIn(NotificationManager manager, String origin, JSONObject notice) {
        String id = notice.optString("approvalId");
        String tag = notice.optString("tag");
        if (!id.matches("[0-9a-f-]{36}") || tag.isEmpty()) return;
        long expiresAt = notice.optLong("expiresAt", 0);
        long left = expiresAt - System.currentTimeMillis();
        if (left <= 0) return;
        int[] choices = null;
        JSONArray offered = notice.optJSONArray("choices");
        if (offered != null && offered.length() == 3) {
            choices = new int[3];
            for (int index = 0; index < 3; index++) choices[index] = offered.optInt(index, -1);
        }
        Intent confirm = SignInConfirmActivity.intent(this, origin, id, tag, notice.optString("title"),
                notice.optString("body"), choices, expiresAt);
        PendingIntent confirming = PendingIntent.getActivity(this, (id + "confirm").hashCode(), confirm,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Action.Builder approve = new Notification.Action.Builder(
                Icon.createWithResource(this, R.drawable.ic_notification), getString(R.string.sign_in_approve),
                confirming);
        if (Build.VERSION.SDK_INT >= 31) approve.setAuthenticationRequired(true);
        Notification.Builder built = new Notification.Builder(this, SIGN_IN)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(notice.optString("title"))
                .setContentIntent(confirming)
                .setCategory(Notification.CATEGORY_STATUS)
                .setTimeoutAfter(left)
                .addAction(approve.build())
                .addAction(answer(origin, id, tag, "deny", R.string.sign_in_deny));
        String body = notice.optString("body");
        if (!body.isEmpty()) built.setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body));
        manager.notify(tag, NOTICE_ID, built.build());
    }

    private Notification.Action answer(String origin, String id, String tag, String decision, int label) {
        Intent intent = new Intent(this, SignInAnswer.class)
                .setAction(SignInAnswer.ACTION)
                .putExtra(SignInAnswer.EXTRA_ID, id)
                .putExtra(SignInAnswer.EXTRA_DECISION, decision)
                .putExtra(SignInAnswer.EXTRA_ORIGIN, origin)
                .putExtra(SignInAnswer.EXTRA_TAG, tag);
        PendingIntent pending = PendingIntent.getBroadcast(this, (id + decision).hashCode(), intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Action.Builder action = new Notification.Action.Builder(
                Icon.createWithResource(this, R.drawable.ic_notification), getString(label), pending);
        // Unlocked first: nobody answers from a locked phone left on a desk.
        if (Build.VERSION.SDK_INT >= 31) action.setAuthenticationRequired(true);
        return action.build();
    }

    /** The phone's own page for the "Connection" notice, where one switch hides it (part of Android since 8.0). */
    private PendingIntent hideConnection() {
        Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CONNECTION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(this, 1, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent open(Uri page, int request) {
        Intent intent = new Intent(this, HomeActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (page != null) intent.setAction(Intent.ACTION_VIEW).setData(page);
        return PendingIntent.getActivity(this, request, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        HttpURLConnection connection = current;
        if (connection != null) new Thread(connection::disconnect, "notices-close").start();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
