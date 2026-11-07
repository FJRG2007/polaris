package app.polaris.tv;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

/**
 * The installer's word on a self-update: the system confirm when Android asks for one, and the result. Reported
 * to Polaris when the update came from there; said on the TV either way.
 */
public final class UpdateStatusReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!SelfUpdateRun.ACTION_STATUS.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, SelfUpdate.STATUS_FAILURE);
        String requestId = intent.getStringExtra(SelfUpdateRun.EXTRA_REQUEST);
        Context app = context.getApplicationContext();
        if (status == SelfUpdate.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try {
                    // Polaris TV is the Home app, which Android lets start an activity from the background.
                    app.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (ActivityNotFoundException | SecurityException blocked) {
                    status = SelfUpdate.STATUS_FAILURE_BLOCKED;
                }
            }
            if (status == SelfUpdate.STATUS_PENDING_USER_ACTION) {
                Toast.makeText(app, R.string.update_confirm_on_tv, Toast.LENGTH_LONG).show();
            }
        } else if (status != SelfUpdate.STATUS_SUCCESS) {
            String why = SelfUpdateRun.why(app, SelfUpdate.failureFor(status));
            Toast.makeText(app, app.getString(R.string.update_failed, why), Toast.LENGTH_LONG).show();
        }
        boolean installed = status == SelfUpdate.STATUS_SUCCESS;
        if (requestId == null && !installed) return;
        int reported = status;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                if (installed) SelfUpdateRun.discardDownload(app);
                if (requestId == null) return;
                SelfUpdate update = SelfUpdateRun.of(app);
                if (update != null) update.onStatus(requestId, reported);
            } finally {
                pending.finish();
            }
        }, "polaris-update-status").start();
    }
}
