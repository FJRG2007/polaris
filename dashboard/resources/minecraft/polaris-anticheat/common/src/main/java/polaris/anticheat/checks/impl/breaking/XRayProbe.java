package polaris.anticheat.checks.impl.breaking;

import polaris.anticheat.antixray.AntiXray;
import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.BlockBreakListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockBreak;
import polaris.anticheat.utils.collisions.datatypes.SimpleCollisionBox;
import polaris.anticheat.utils.math.Vector3dm;
import polaris.anticheat.utils.math.VectorUtils;
import com.github.retrooper.packetevents.protocol.attribute.Attributes;
import com.github.retrooper.packetevents.util.Vector3i;

/**
 * Digging at an ore the anti-xray hid, where the client cannot have seen it.
 *
 * The client was sent rock there, and every face of it touches opaque blocks, so
 * nothing a player looks at can land on it - unless the client knows what is
 * really in the ground. That is how X-Ray tools that "see through" an anti-xray
 * work: they start or cancel digging at guessed positions to make the server
 * answer with the real block. The anti-xray already answers with rock; this says
 * who is asking.
 *
 * Only positions still hidden count, and only when every side is closed in the
 * world as the client has it or the position is out of reach, so digging into an
 * ore right after mining the block in front of it is never counted.
 */
@CheckData(name = "XRayProbe", stableKey = "polarisac.breaking.xray_probe", description = "Dug at buried ore it could not see")
public class XRayProbe extends Check implements BlockBreakListener {
    private static final Verbose V = Verbose.of("x={sint} y={sint} z={sint} {str}");

    private long lastPosition = Long.MIN_VALUE;

    public XRayProbe(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockBreak(BlockBreak blockBreak) {
        AntiXray engine = AntiXray.running();
        if (engine == null) return;
        Vector3i at = blockBreak.position;
        if (!player.antiXray.isHidden(at.x, at.y, at.z)) return;

        boolean far = isOutOfReach(at);
        if (!far && !isClosedIn(engine, at)) return;

        // START, then CANCEL or FINISH, at one position is one probe, not two.
        long position = ((long) (at.x & 0x3FFFFFF) << 38) | ((long) (at.z & 0x3FFFFFF) << 12) | (at.y & 0xFFF);
        if (position == lastPosition) return;
        lastPosition = position;

        flag(V.write(verbose()).sint(at.x).sint(at.y).sint(at.z).str(far ? "out of reach" : "closed in"));
    }

    private boolean isClosedIn(AntiXray engine, Vector3i at) {
        return covers(engine, at.x + 1, at.y, at.z) && covers(engine, at.x - 1, at.y, at.z)
                && covers(engine, at.x, at.y + 1, at.z) && covers(engine, at.x, at.y - 1, at.z)
                && covers(engine, at.x, at.y, at.z + 1) && covers(engine, at.x, at.y, at.z - 1);
    }

    private boolean covers(AntiXray engine, int x, int y, int z) {
        return engine.blocks().isOccluding(player.compensatedWorld.getBlockStateId(x, y, z));
    }

    /** Further than the player can reach, with room for a movement they have not sent yet. */
    private boolean isOutOfReach(Vector3i at) {
        double min = Double.MAX_VALUE;
        SimpleCollisionBox box = new SimpleCollisionBox(at);
        for (double eye : player.getPossibleEyeHeights()) {
            Vector3dm nearest = VectorUtils.cutBoxToVector(player.x, player.y + eye, player.z, box);
            min = Math.min(min, nearest.distanceSquared(player.x, player.y + eye, player.z));
        }
        double reach = player.compensatedEntities.self.getAttributeValue(Attributes.BLOCK_INTERACTION_RANGE) + 2.0;
        return min > reach * reach;
    }
}
