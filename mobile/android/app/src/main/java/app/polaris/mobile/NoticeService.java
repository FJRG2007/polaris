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
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.webkit.CookieManager;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Messages and calls as notifications while Polaris is not on screen.
 *
 * The page raises a toast only while it runs, and a WebView has no Web Push, so this service keeps one connection
 * open to the instance (`/api/mobile/notices`) and turns each frame into a notification. It needs no Google account
 * and no setup: the instance decides what is news exactly as it does for a browser, and the phone only draws it.
 * Android requires a service like this to show that it is running, which is the quiet "Connected" notification; it
 * can be hidden from the phone's notification settings without stopping anything.
 */
public final class NoticeService extends Service {
    private static final String CONNECTION = "connection";
    private static final String MESSAGES = "messages";
    private static final String CALLS = "calls";
    private static final int RUNNING_ID = 1;
    private static final int NOTICE_ID = 2;
    private static final long MAX_BACKOFF_MS = 60_000;

    /** Whether the app is on screen, where the page already says it. */
    static volatile boolean pageVisible;

    private volatile boolean running;
    private Thread worker;

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
        Notification connected = new Notification.Builder(this, CONNECTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.notices_connected))
                .setContentIntent(open(null, 0))
                .setOngoing(true)
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
        manager.createNotificationChannel(connection);
        manager.createNotificationChannel(new NotificationChannel(MESSAGES, getString(R.string.notices_channel_messages), NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(new NotificationChannel(CALLS, getString(R.string.notices_channel_calls), NotificationManager.IMPORTANCE_HIGH));
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
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15_000);
            // Twice the heartbeat: a connection that has gone quiet longer than that is dead.
            connection.setReadTimeout(60_000);
            connection.setRequestProperty("Accept", "text/event-stream");
            connection.setRequestProperty("User-Agent", "PolarisMobile/" + BuildConfig.VERSION_NAME + " (Android)");
            String cookie = CookieManager.getInstance().getCookie(address);
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
                manager.cancel(tag, NOTICE_ID);
                return;
            }
            // On screen, the page already showed it.
            if (pageVisible) return;
            String path = notice.optString("path", "/");
            if (!path.startsWith("/")) path = "/";
            Notification.Builder built = new Notification.Builder(this, "call".equals(kind) ? CALLS : MESSAGES)
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

    private PendingIntent open(Uri page, int request) {
        Intent intent = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (page != null) intent.setAction(Intent.ACTION_VIEW).setData(page);
        return PendingIntent.getActivity(this, request, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
