package polaris.anticheat.checks.impl.scaffolding;

import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.BlockPlaceCheck;
import polaris.anticheat.checks.type.BlockPlaceListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockPlace;
import com.github.retrooper.packetevents.util.Vector3f;

@CheckData(name = "InvalidPlaceCursor", stableKey = "polarisac.scaffolding.invalid_place_a", description = "Sent invalid cursor position")
public class InvalidPlaceCursor extends BlockPlaceCheck implements BlockPlaceListener {
    public InvalidPlaceCursor(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockPlace(final BlockPlace place) {
        Vector3f cursor = place.cursor;
        if (cursor == null) return;
        if (!Float.isFinite(cursor.x) || !Float.isFinite(cursor.y) || !Float.isFinite(cursor.z)) {
            if (flag() && shouldModifyPackets() && shouldCancel()) {
                place.resync();
            }
        }
    }
}
