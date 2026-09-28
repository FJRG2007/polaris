package polaris.anticheat.predictionengine.blockeffects;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.math.Vector3dm;

import java.util.List;

public interface BlockEffectsResolver {

    void applyEffectsFromBlocks(PolarisPlayer player, Vector3dm clientVelocity, boolean onlyApplyVelocity, List<PolarisPlayer.Movement> movements);

}
