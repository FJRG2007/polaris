package polaris.anticheat.checks.impl.packetorder;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PacketReceiveListener;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.event.PacketReceiveEvent;
import com.github.retrooper.packetevents.protocol.packettype.PacketType;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientClickWindow;
import com.github.retrooper.packetevents.wrapper.play.client.WrapperPlayClientClickWindow.WindowClickType;

@CheckData(name = "PacketOrderA", stableKey = "polarisac.packetorder.window_click_order", description = "Sent pickup and quick-move inventory clicks in an invalid order", experimental = true)
public class PacketOrderA extends Check implements PacketReceiveListener, PostPredictionListener {
    public PacketOrderA(final PolarisPlayer player) {
        super(player);
    }

    @Override
    public boolean isApplicable() {
        // before 1.13, keyboard and mouse input were handled on tick.
        // Keyboard input was always handled after mouse input, which is why this works,
        // but after 1.13, keyboard and mouse input are handled in the order they occur, breaking this check.
        return player.getClientVersion().isOlderThanOrEquals(ClientVersion.V_1_12_2);
    }

    private int invalid;

    @Override
    public void onPacketReceive(PacketReceiveEvent event) {
        if (event.getPacketType() == PacketType.Play.Client.CLICK_WINDOW) {
            final WindowClickType clickType = new WrapperPlayClientClickWindow(event).getWindowClickType();

            if ((clickType == WindowClickType.PICKUP || clickType == WindowClickType.PICKUP_ALL) && player.packetOrderProcessor.isQuickMoveClicking()
                    || clickType == WindowClickType.QUICK_MOVE && player.packetOrderProcessor.isPickUpClicking()) {
                if (!player.canSkipTicks()) {
                    if (flag() && shouldModifyPackets()) {
                        event.setCancelled(true);
                        player.onPacketCancel();
                    }
                } else {
                    invalid++;
                }
            }
        }
    }

    @Override
    public void onPredictionComplete(PredictionComplete predictionComplete) {
        if (!player.canSkipTicks()) return;

        if (player.isTickingReliablyFor(3)) {
            for (; invalid >= 1; invalid--) {
                flag();
            }
        }

        invalid = 0;
    }
}
