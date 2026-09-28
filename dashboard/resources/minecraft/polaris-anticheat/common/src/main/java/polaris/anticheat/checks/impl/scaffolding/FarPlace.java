package polaris.anticheat.checks.impl.scaffolding;

import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.BlockPlaceCheck;
import polaris.anticheat.checks.type.BlockPlaceListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockPlace;
import polaris.anticheat.utils.collisions.datatypes.SimpleCollisionBox;
import polaris.anticheat.utils.math.Vector3dm;
import polaris.anticheat.utils.math.VectorUtils;
import com.github.retrooper.packetevents.protocol.attribute.Attributes;
import com.github.retrooper.packetevents.protocol.world.states.type.StateTypes;
import com.github.retrooper.packetevents.util.Vector3i;

@CheckData(name = "FarPlace", stableKey = "polarisac.scaffolding.far_place", description = "Placing blocks from too far away")
public class FarPlace extends BlockPlaceCheck implements BlockPlaceListener {
    public FarPlace(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockPlace(final BlockPlace place) {
        if (!player.cameraEntity.isSelf() || player.inVehicle()) return;

        Vector3i blockPos = place.position;

        if (place.material == StateTypes.SCAFFOLDING) return;

        double min = Double.MAX_VALUE;
        final double[] possibleEyeHeights = player.getPossibleEyeHeights();
        for (double d : possibleEyeHeights) {
            SimpleCollisionBox box = new SimpleCollisionBox(blockPos);
            Vector3dm best = VectorUtils.cutBoxToVector(player.x, player.y + d, player.z, box);
            min = Math.min(min, best.distanceSquared(player.x, player.y + d, player.z));
        }

        // getPickRange() determines this?
        // With 1.20.5+ the new attribute determines creative mode reach using a modifier
        double maxReach = player.compensatedEntities.self.getAttributeValue(Attributes.BLOCK_INTERACTION_RANGE);
        double threshold = player.getMovementThreshold();
        maxReach += Math.hypot(threshold, threshold);

        if (min > maxReach * maxReach) { // fail
            if (flag() && shouldModifyPackets() && shouldCancel()) {
                place.resync();
            }
        }
    }
}
