package app.polaris.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Whether this TV is linked to a Polaris, so the installer leaves a linked TV alone.
 * {@code adb shell am broadcast -f 32 -n app.polaris.tv/.LinkState}
 */
public class LinkState extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        setResultData("linked=" + PolarisLink.connected(context));
    }
}
