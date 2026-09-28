package polaris.anticheat.checks.impl.scaffolding;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.BlockPlaceCheck;
import polaris.anticheat.checks.type.BlockPlaceListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockPlace;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.manager.server.ServerVersion;

@CheckData(name = "InvalidPlaceFace", stableKey = "polarisac.scaffolding.invalid_place_b", description = "Sent impossible block face id")
public class InvalidPlaceFace extends BlockPlaceCheck implements BlockPlaceListener {
    private static final Verbose V = Verbose.of("direction={sint}");

    public InvalidPlaceFace(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockPlace(final BlockPlace place) {
        if (place.getFaceId() == 255 && PacketEvents.getAPI().getServerManager().getVersion().isOlderThanOrEquals(ServerVersion.V_1_8)) {
            return;
        }

        if (place.getFaceId() < 0 || place.getFaceId() > 5) {
            // ban
            int direction = place.getFaceId();
            if (flag(V.write(verbose()).sint(direction)) && shouldModifyPackets() && shouldCancel()) {
                place.resync();
            }
        }
    }
}
