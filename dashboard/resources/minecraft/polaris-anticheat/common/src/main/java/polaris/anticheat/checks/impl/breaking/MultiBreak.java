package polaris.anticheat.checks.impl.breaking;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.impl.verbose.VerboseCodecs;
import polaris.anticheat.checks.type.BlockBreakListener;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.checks.type.PreViaPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockBreak;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.player.DiggingAction;
import com.github.retrooper.packetevents.protocol.world.BlockFace;
import com.github.retrooper.packetevents.util.Vector3i;

import java.util.ArrayList;
import java.util.List;

@CheckData(name = "MultiBreak", stableKey = "polarisac.breaking.multi_break", description = "Tried to break multiple different blocks in the same movement tick", experimental = true)
public class MultiBreak extends Check implements BlockBreakListener, PreViaPacketReceiveListener, PostPredictionListener {
    private static final Verbose V =
            Verbose.of("face={face}, lastFace={face}, pos={mcpos}, lastPos={mcpos}");

    private final List<FlagData> flags = new ArrayList<>();
    private boolean hasBroken;
    private BlockFace lastFace;
    private Vector3i lastPos;

    public MultiBreak(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockBreak(BlockBreak blockBreak) {
        if (blockBreak.action == DiggingAction.CANCELLED_DIGGING) {
            return;
        }

        if (hasBroken && (blockBreak.face != lastFace || !blockBreak.position.equals(lastPos))) {
            final int face = VerboseCodecs.enumId(blockBreak.face);
            final int previousFace = VerboseCodecs.enumId(lastFace);
            if (!player.canSkipTicks()) {
                var buf = V.write(verbose()).uint(face).uint(previousFace)
                        .mcPos(blockBreak.position.x, blockBreak.position.y, blockBreak.position.z)
                        .mcPos(lastPos.x, lastPos.y, lastPos.z);
                if (flag(buf) && shouldModifyPackets()) {
                    blockBreak.cancel();
                }
            } else {
                flags.add(new FlagData(face, previousFace, blockBreak.position, lastPos));
            }
        }

        lastFace = blockBreak.face;
        lastPos = blockBreak.position;
        hasBroken = true;
    }

    @Override
    public void onPreViaPacketReceive(PacketReceiveEvent event) {
        if (!player.cameraEntity.isSelf() || isTickPacket(event.getPacketType())) {
            hasBroken = false;
        }
    }

    @Override
    public void onPredictionComplete(PredictionComplete predictionComplete) {
        if (!player.canSkipTicks()) return;

        if (player.isTickingReliablyFor(3)) {
            for (FlagData data : flags) {
                flag(V.write(verbose()).uint(data.face()).uint(data.previousFace())
                        .mcPos(data.pos().x, data.pos().y, data.pos().z)
                        .mcPos(data.previousPos().x, data.previousPos().y, data.previousPos().z));
            }
        }

        flags.clear();
    }

    private record FlagData(int face, int previousFace, Vector3i pos, Vector3i previousPos) {}
}
