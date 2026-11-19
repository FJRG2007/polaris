package app.polaris.mobile;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Where Approve or Deny on an "Is this you?" notification lands. Not exported: only the notification's own
 * PendingIntent reaches it. The answer is signed with this phone's key ({@link PolarisHttp#signed}), so the session
 * cookie alone - which a browser tab also holds - is never enough to let somebody in.
 */
public final class SignInAnswer extends BroadcastReceiver {
    static final String ACTION = "app.polaris.mobile.SIGN_IN_ANSWER";
    static final String EXTRA_ID = "approvalId";
    static final String EXTRA_DECISION = "decision";
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_TAG = "tag";
    private static final long RESULT_SHOWN_MS = 10_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_ID);
        String decision = intent.getStringExtra(EXTRA_DECISION);
        String origin = intent.getStringExtra(EXTRA_ORIGIN);
        String tag = intent.getStringExtra(EXTRA_TAG);
        // Answered only to a Polaris still on this phone's list.
        ServerStore.Host host = origin == null ? null : ServerStore.hostFor(context, origin);
        boolean known = host != null && ServerAddress.sameOrigin(host.origin, origin);
        if (id == null || !id.matches("[0-9a-f-]{36}") || tag == null || !known
                || !("approve".equals(decision) || "deny".equals(decision))) {
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.cancel(tag, NoticeService.NOTICE_ID);
        Context app = context.getApplicationContext();
        PendingResult pending = goAsync();
        new Thread(() -> {
            String said;
            try {
                PolarisHttp.Answer answer = PolarisHttp.signed(app, origin,
                        origin + "/api/mobile/sign-in-approvals/" + id + "/" + decision, "sign-in-approval",
                        id + ":" + decision, app.getString(R.string.sign_in_failed), 64 * 1024);
                said = answer.json().optString("text", app.getString(
                        "approve".equals(decision) ? R.string.sign_in_approved : R.string.sign_in_denied));
            } catch (PolarisHttp.Refused refused) {
                said = refused.status == 401 ? app.getString(R.string.door_signed_out) : refused.getMessage();
            } catch (Exception failed) {
                said = app.getString(R.string.sign_in_failed);
            }
            Notification result = new Notification.Builder(app, NoticeService.SIGN_IN)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(said)
                    .setAutoCancel(true)
                    .setTimeoutAfter(RESULT_SHOWN_MS)
                    .build();
            manager.notify(tag, NoticeService.RESULT_ID, result);
            pending.finish();
        }, "sign-in-answer").start();
    }
}
