package polaris.anticheat.checks.impl.multiactions;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.BlockBreakListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.BlockBreak;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.player.InteractionHand;

@CheckData(name = "MultiActionsB", stableKey = "polarisac.multiactions.break_while_using", description = "Breaking blocks while using an item", experimental = true)
public class MultiActionsB extends Check implements BlockBreakListener {
    public MultiActionsB(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onBlockBreak(BlockBreak blockBreak) {
        if (player.packetStateData.isSlowedByUsingItem() && (player.packetStateData.lastSlotSelected == player.packetStateData.getSlowedByUsingItemSlot() || player.packetStateData.itemInUseHand == InteractionHand.OFF_HAND)) {
            // this is vanilla on 1.7
            if (player.getClientVersion().isOlderThanOrEquals(ClientVersion.V_1_7_10)) {
                return;
            }

            if (flag() && shouldModifyPackets()) {
                blockBreak.cancel();
            }
        }
    }
}
