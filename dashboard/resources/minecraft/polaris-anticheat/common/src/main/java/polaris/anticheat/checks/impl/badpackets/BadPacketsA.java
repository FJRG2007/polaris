package polaris.anticheat.checks.impl.badpackets;

import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PreViaPacketReceiveListener;
import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientHeldItemChange;

@CheckData(name = "BadPacketsA", stableKey = "polarisac.badpackets.duplicate_slot", description = "Sent duplicate slot id")
public class BadPacketsA extends Check implements PreViaPacketReceiveListener {
    private static final Verbose V = Verbose.of("slot={sint}");

    private int lastSlot = -1;

    public BadPacketsA(final PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPreViaPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.HELD_ITEM_CHANGE) {
            final int slot = new WrapperPlayClientHeldItemChange(event).getSlot();

            if (slot == lastSlot && flag(V.write(verbose()).sint(slot)) && shouldModifyPackets()) {
                event.setCancelled(true);
                player.onPacketCancel();
            }

            lastSlot = slot;
        }
    }
}
