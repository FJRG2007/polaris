package polaris.anticheat.utils.blockplace;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockPlace;

public interface BlockPlaceFactory {
    void applyBlockPlaceToWorld(PolarisPlayer player, BlockPlace place);
}
