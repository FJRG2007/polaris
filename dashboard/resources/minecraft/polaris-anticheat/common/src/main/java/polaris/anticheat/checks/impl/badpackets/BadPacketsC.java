package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PreViaPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientEntityAction;
import org.jetbrains.annotations.NotNull;

@CheckData(name = "BadPacketsC", stableKey = "polarisac.badpackets.wake_not_sleeping", description = "Tried to wake up while not sleeping", experimental = true)
public class BadPacketsC extends Check implements PreViaPacketReceiveListener {
    public BadPacketsC(@NotNull PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPreViaPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.ENTITY_ACTION
                && new WrapperPlayClientEntityAction(event).getAction() == WrapperPlayClientEntityAction.Action.LEAVE_BED
                && !player.isInBed) {
            flag();
        }
    }
}
