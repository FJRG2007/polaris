package app.polaris.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Where a door widget's press lands. Not exported: only the widget's own PendingIntent reaches it, so no other app on
 * the phone can open a door by sending a broadcast.
 */
public final class DoorPress extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!DoorWidget.ACTION_OPEN.equals(intent.getAction())) return;
        DoorWidget.press(context, intent, goAsync());
    }
}
