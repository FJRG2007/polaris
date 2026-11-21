package app.polaris.mobile;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.widget.Toast;

/**
 * The VPN in Quick Settings: one tap connects to the last place, another disconnects. When there is nothing it can do
 * on its own - no place picked yet, Android's VPN permission not given, signed out - it opens the VPN page instead,
 * where each of those is put right.
 */
public final class VpnTile extends TileService {
    private final VpnTunnel.Listener listener = this::draw;
    private boolean working;

    @Override
    public void onStartListening() {
        VpnTunnel.get(this).listen(listener);
        draw();
    }

    @Override
    public void onStopListening() {
        VpnTunnel.get(this).unlisten(listener);
    }

    @Override
    public void onClick() {
        if (working) return;
        if (isSecure() && isLocked()) {
            unlockAndRun(this::toggle);
            return;
        }
        toggle();
    }

    private void toggle() {
        VpnTunnel tunnel = VpnTunnel.get(this);
        if (tunnel.nodeId() != null) {
            working = true;
            draw();
            tunnel.down(error -> settle(null));
            return;
        }
        if (!tunnel.hasLast()) {
            openPage();
            return;
        }
        working = true;
        draw();
        tunnel.reconnect(this::settle);
    }

    private void settle(String error) {
        working = false;
        draw();
        if (error == null) return;
        if (error.equals(VpnTunnel.DENIED) || error.equals(VpnTunnel.SIGN_IN) || error.equals(VpnTunnel.NO_PLACE)) {
            openPage();
            return;
        }
        Toast.makeText(this, VpnWords.of(this, error), Toast.LENGTH_LONG).show();
    }

    private void draw() {
        Tile tile = getQsTile();
        if (tile == null) return;
        boolean up = VpnTunnel.get(this).nodeId() != null;
        tile.setLabel(getString(R.string.vpn_tile));
        tile.setState(working ? Tile.STATE_UNAVAILABLE : up ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(getString(working ? R.string.vpn_working : up ? R.string.vpn_on : R.string.vpn_off));
        }
        tile.updateTile();
    }

    /** The VPN page of this phone's Polaris, with the shade out of the way. */
    // The Intent form only below Android 14, where the PendingIntent one does not exist.
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @SuppressWarnings("deprecation")
    private void openPage() {
        String origin = ServerStore.origin(this);
        Intent open = new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (origin != null) open.setAction(Intent.ACTION_VIEW).setData(Uri.parse(origin + "/vpn"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(open);
        }
    }
}
