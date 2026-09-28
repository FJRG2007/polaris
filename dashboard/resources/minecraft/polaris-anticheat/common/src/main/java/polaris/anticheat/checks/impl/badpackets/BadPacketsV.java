package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.math.PolarisMath;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.util.Vector3d;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientPlayerFlying;

@CheckData(name = "BadPacketsV", stableKey = "polarisac.badpackets.slow_move", description = "Did not move far enough", experimental = true)
public class BadPacketsV extends Check implements PacketReceiveListener {
    private static final Verbose V = Verbose.of("delta={f64}");

    private int noReminderTicks;

    public BadPacketsV(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        if (!player.canSkipTicks() && isTickPacket(event.getPacketType())) {
            if (event.getPacketType() == PacketType.Play.Client.PLAYER_POSITION || event.getPacketType() == PacketType.Play.Client.PLAYER_POSITION_AND_ROTATION) {
                int positionAtLeastEveryNTicks = player.getClientVersion().isOlderThanOrEquals(ClientVersion.V_1_8) ? 20 : 19;

                if (noReminderTicks < positionAtLeastEveryNTicks && !player.uncertaintyHandler.lastTeleportTicks.hasOccurredSince(1)) {
                    final Vector3d position = new WrapperPlayClientPlayerFlying(event).getLocation().getPosition();
                    final double deltaSq = PolarisMath.square(player.lastX - position.x)
                            + PolarisMath.square(player.lastY - position.y)
                            + PolarisMath.square(player.lastZ - position.z);
                    if (deltaSq <= player.getMovementThreshold() * player.getMovementThreshold()) {
                        double delta = Math.sqrt(deltaSq);
                        flag(V.write(verbose()).f64(delta));
                    }
                }

                noReminderTicks = 0;
            } else {
                noReminderTicks++;
            }
        }
    }
}
