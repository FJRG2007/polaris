package app.polaris.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Decline on a ringing call, from the notification or the answer screen. Not exported: only the app's own
 * PendingIntent reaches it. The ring stops at once; the decline goes to the Polaris the call came from, which stops
 * it on every other device of this account too. The caller is not told, as on the web.
 */
public final class CallDecline extends BroadcastReceiver {
    static final String ACTION = "app.polaris.mobile.CALL_DECLINE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        decline(context, intent);
    }

    /** Stops the ring and tells the Polaris; the answer screen calls this directly. */
    static void decline(Context context, Intent intent) {
        String tag = intent.getStringExtra(IncomingCall.EXTRA_TAG);
        String origin = intent.getStringExtra(IncomingCall.EXTRA_ORIGIN);
        String meetingId = intent.getStringExtra(IncomingCall.EXTRA_MEETING);
        if (tag != null) IncomingCall.stop(context, tag);
        // Sent only to a Polaris still on this phone's list.
        ServerStore.Host host = origin == null ? null : ServerStore.hostFor(context, origin);
        if (host == null || !ServerAddress.sameOrigin(host.origin, origin) || !IncomingCall.validMeeting(meetingId)) return;
        Context app = context.getApplicationContext();
        new Thread(() -> send(app, origin, meetingId), "call-decline").start();
    }

    private static void send(Context context, String origin, String meetingId) {
        String address = origin + "/api/chat/calls/decline";
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setRequestMethod("POST");
                String cookie = HostProfiles.cookieFor(context, address);
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                connection.setRequestProperty("User-Agent", AppAgent.of(context));
                // The route answers only a request from its own origin, as a page of it would send.
                connection.setRequestProperty("Origin", origin);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(("{\"meetingId\":\"" + meetingId + "\"}").getBytes(StandardCharsets.UTF_8));
                }
                connection.getResponseCode();
            } finally {
                connection.disconnect();
            }
        } catch (Exception unreachable) {
            // The ring already stopped here; the caller's side ends on its own, as for a missed call.
        }
    }
}
