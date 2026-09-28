package polaris.anticheat.events.packets;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.connection.ConnectionUtils;
import polaris.anticheat.utils.data.RotationData;
import polaris.anticheat.utils.math.PolarisMath;
import com.github.retrooper.packetevents.event.PacketListenerAbstract;
import com.github.retrooper.packetevents.event.PacketListenerPriority;
import com.github.retrooper.packetevents.event.PacketSendEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerBundle;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerPlayerRotation;

public class PacketServerPlayerRotation extends PacketListenerAbstract {

    public PacketServerPlayerRotation() {
        super(PacketListenerPriority.LOW);
    }

    @Override
    public void onPacketSend(PacketSendEvent event) {
        if (event.getPacketType() == PacketType.Play.Server.PLAYER_ROTATION) {
            PolarisPlayer player = PolarisAPI.INSTANCE.getPlayerDataManager().getPlayer(event.getUser());
            if (player == null) return;

            WrapperPlayServerPlayerRotation packet = new WrapperPlayServerPlayerRotation(event);

            // I don't want to deal with this, so we'll prevent it
            if (!Float.isFinite(packet.getPitch())) {
                packet.setPitch(0);
                event.markForReEncode(true);
            }
            if (!Float.isFinite(packet.getYaw())) {
                packet.setYaw(0);
                event.markForReEncode(true);
            }

            if (!player.packetStateData.sendingBundlePacket) {
                ConnectionUtils.sendPacketPreVia(player, new WrapperPlayServerBundle());
                event.getTasksAfterSend().add(() -> ConnectionUtils.sendPacketPreVia(player, new WrapperPlayServerBundle()));
            }
            player.sendTransaction();
            player.pendingRotations.add(new RotationData(
                    packet.getYaw(),
                    packet.isRelativePitch() ? packet.getPitch() : PolarisMath.clamp(packet.getPitch() % 360F, -90F, 90F),
                    packet.isRelativeYaw(),
                    packet.isRelativePitch(),
                    player.getLastTransactionSent()
            ));
        }
    }
}
