package app.polaris.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * What the system installer answered for a self-update (`SelfUpdate`). Success needs nothing: the app is replaced and
 * its process ends. A request for the person's confirmation is shown now if the app is open, or offered the next time
 * it is. A failure keeps the downloaded file and turns into the one-tap offer, instead of a silent retry every time
 * the app is left.
 */
public final class UpdateResult extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context context, Intent intent) {
        if (!SelfUpdate.ACTION_RESULT.equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            SelfUpdate.needsConfirmation(context, intent.getParcelableExtra(Intent.EXTRA_INTENT));
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            SelfUpdate.failed(context);
        }
    }
}
