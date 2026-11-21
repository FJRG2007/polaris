package app.polaris.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

/**
 * A call ringing on the phone the way a phone call does: the ringtone on repeat, the full-screen answer screen over
 * the lock screen, and Answer and Decline on the notification itself.
 *
 * The ring lives on the notification ({@link Notification#FLAG_INSISTENT} over a channel whose sound is the phone's
 * ringtone), so everything that ends it - answering, declining, the call ending, the person declining on another
 * device - is one {@link #stop}. A channel's sound cannot change once created, so the ring has a channel of its own
 * and the older plain "calls" channel is removed on every phone that still has it.
 */
final class IncomingCall {
    static final String CHANNEL = "calls_ring";
    private static final String OLD_CHANNEL = "calls";
    static final String EXTRA_TAG = "tag";
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_PATH = "path";
    static final String EXTRA_MEETING = "meetingId";
    static final String EXTRA_CALLER = "caller";
    /** As long as a caller waits before the call gives up, so a ring whose end never arrived stops by itself. */
    private static final long RING_MS = 60_000;
    private static final long[] VIBRATION = {0, 1000, 1000};

    private IncomingCall() {}

    static void channel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.deleteNotificationChannel(OLD_CHANNEL);
        NotificationChannel ring = new NotificationChannel(CHANNEL, context.getString(R.string.notices_channel_calls),
                NotificationManager.IMPORTANCE_HIGH);
        ring.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ring.enableVibration(true);
        ring.setVibrationPattern(VIBRATION);
        ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(ring);
    }

    /** Whether a meeting id is one the server could have sent: it goes into a request path's body. */
    static boolean validMeeting(String id) {
        return id != null && id.matches("[0-9a-f-]{36}");
    }

    static void ring(Context context, String origin, String tag, String path, String meetingId, String caller) {
        Intent details = new Intent()
                .putExtra(EXTRA_TAG, tag)
                .putExtra(EXTRA_ORIGIN, origin)
                .putExtra(EXTRA_PATH, path)
                .putExtra(EXTRA_MEETING, meetingId)
                .putExtra(EXTRA_CALLER, caller);
        int request = tag.hashCode();
        PendingIntent screen = PendingIntent.getActivity(context, request,
                new Intent(details).setClass(context, IncomingCallActivity.class)
                        .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent answer = PendingIntent.getActivity(context, request + 1,
                new Intent(details).setClass(context, IncomingCallActivity.class)
                        .setAction(IncomingCallActivity.ACTION_ANSWER)
                        .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent decline = PendingIntent.getBroadcast(context, request + 2,
                new Intent(details).setClass(context, CallDecline.class).setAction(CallDecline.ACTION),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder built = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(caller)
                .setContentText(context.getString(R.string.call_incoming))
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setTimeoutAfter(RING_MS)
                .setContentIntent(screen)
                .setFullScreenIntent(screen, true);
        if (Build.VERSION.SDK_INT >= 31) {
            Person who = new Person.Builder().setName(caller).setImportant(true).build();
            built.setStyle(Notification.CallStyle.forIncomingCall(who, decline, answer));
        } else {
            Icon icon = Icon.createWithResource(context, R.drawable.ic_notification);
            built.addAction(new Notification.Action.Builder(icon, context.getString(R.string.call_decline), decline).build())
                    .addAction(new Notification.Action.Builder(icon, context.getString(R.string.call_answer), answer).build());
        }
        Notification notification = built.build();
        notification.flags |= Notification.FLAG_INSISTENT;
        context.getSystemService(NotificationManager.class).notify(tag, NoticeService.NOTICE_ID, notification);
    }

    /** The ring ends, wherever it was ended: the notification and its sound, and the answer screen if it is up. */
    static void stop(Context context, String tag) {
        context.getSystemService(NotificationManager.class).cancel(tag, NoticeService.NOTICE_ID);
        IncomingCallActivity.closeFor(tag);
    }
}
