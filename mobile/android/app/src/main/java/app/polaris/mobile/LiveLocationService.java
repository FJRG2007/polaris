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
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Live location for Polaris Chat, kept moving with the screen off: a foreground service of type location (the kind
 * Android requires for this, with its ongoing notification) that reads the position from the platform's
 * LocationManager - no Play services needed - and sends it to the instance's /api/chat/location/live, signed in with the
 * page's own cookie. The page starts it when a share starts; it stops at the latest share's end, when the server
 * answers that nothing is running any more, or from the notification's Stop.
 *
 * The server refuses moves after a share ends whatever this does, so a service left running cannot keep publishing.
 */
public final class LiveLocationService extends Service implements LocationListener {
    private static final String CHANNEL = "live-location";
    private static final int RUNNING_ID = 41;
    private static final String EXTRA_UNTIL = "until";
    private static final String ACTION_STOP = "app.polaris.mobile.LIVE_LOCATION_STOP";
    private static final long EVERY_MS = 10_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private long until;
    private boolean listening;

    /** Starts or extends the share. Answers false when Android would refuse it (no location permission yet). */
    static boolean start(Context context, long untilMs) {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        Intent intent = new Intent(context, LiveLocationService.class).putExtra(EXTRA_UNTIL, untilMs);
        try {
            context.startForegroundService(intent);
            return true;
        } catch (RuntimeException refused) {
            return false;
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, LiveLocationService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopNow(true);
            return START_NOT_STICKY;
        }
        long asked = intent == null ? 0 : intent.getLongExtra(EXTRA_UNTIL, 0);
        if (asked <= System.currentTimeMillis()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        until = Math.max(until, asked);
        Notification shown = notification();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(RUNNING_ID, shown, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(RUNNING_ID, shown);
        } catch (RuntimeException refused) {
            stopSelf();
            return START_NOT_STICKY;
        }
        listen();
        main.removeCallbacksAndMessages(null);
        main.postDelayed(() -> stopNow(false), Math.max(0, until - System.currentTimeMillis()) + 1_000);
        return START_NOT_STICKY;
    }

    private void listen() {
        if (listening) return;
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (manager == null) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopNow(false);
            return;
        }
        try {
            String[] providers = Build.VERSION.SDK_INT >= 31
                    ? new String[] {LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}
                    : new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};
            for (String provider : providers) {
                if (!manager.isProviderEnabled(provider)) continue;
                manager.requestLocationUpdates(provider, EVERY_MS, 10f, this, Looper.getMainLooper());
                listening = true;
                // One provider is enough when the fused one is there; it already mixes the others.
                if (LocationManager.FUSED_PROVIDER.equals(provider)) break;
            }
        } catch (SecurityException | IllegalArgumentException refused) {
            stopNow(false);
        }
    }

    private long lastSent;

    @Override
    public void onLocationChanged(Location location) {
        long now = System.currentTimeMillis();
        if (now >= until) {
            stopNow(false);
            return;
        }
        if (now - lastSent < EVERY_MS) return;
        lastSent = now;
        String origin = ServerStore.origin(this);
        if (origin == null) return;
        final String body;
        try {
            JSONObject point = new JSONObject()
                    .put("latitude", location.getLatitude())
                    .put("longitude", location.getLongitude());
            if (location.hasAccuracy()) point.put("accuracy", Math.round(location.getAccuracy()));
            body = point.toString();
        } catch (Exception broken) {
            return;
        }
        sender.execute(() -> {
            try {
                PolarisHttp.Answer answer = PolarisHttp.request(this, origin + "/api/chat/location/live", "POST", body, 4096);
                if (answer.status == 200 && answer.json().optInt("running", 1) == 0) main.post(() -> stopNow(false));
                if (answer.status == 401) main.post(() -> stopNow(false));
            } catch (Exception offline) {
                // The next position tries again.
            }
        });
    }

    /** Stops sending; from the notification it also ends every share on the server, as the page's Stop all does. */
    private void stopNow(boolean endShares) {
        if (endShares) {
            String origin = ServerStore.origin(this);
            if (origin != null) {
                sender.execute(() -> {
                    try {
                        PolarisHttp.request(this, origin + "/api/chat/location/live", "DELETE", "{}", 4096);
                    } catch (Exception offline) {
                        // The share still ends at its own time.
                    }
                });
            }
        }
        stopSelf();
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, getString(R.string.live_location_channel), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, HomeActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, LiveLocationService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.live_location_title))
                .setContentText(getString(R.string.live_location_text))
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, getString(R.string.live_location_stop), stop).build())
                .build();
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (manager != null) manager.removeUpdates(this);
        listening = false;
        sender.shutdown();
        super.onDestroy();
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
