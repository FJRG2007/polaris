package polaris.anticheat.checks.impl.sprint;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;

@CheckData(name = "SprintC", stableKey = "polarisac.sprint.using_item", description = "Sprinting while using an item", setback = 5, experimental = true)
public class SprintC extends Check implements PostPredictionListener {
    private boolean flaggedLastTick = false;

    public SprintC(PolarisPlayer player) {
        super(player);
    }


    @Override
    public boolean isApplicable() {
        // https://bugs.mojang.com/browse/MC-152728
        return player.getClientVersion().isOlderThan(ClientVersion.V_1_14_2) || player.getClientVersion() == ClientVersion.V_1_21_4;
    }

    @Override
    public void onPredictionComplete(final PredictionComplete predictionComplete) {
        if (player.packetStateData.isSlowedByUsingItem()) {
            if (!player.wasTouchingWater || player.getClientVersion().isOlderThan(ClientVersion.V_1_13)) {
                flaggedLastTick = false;
                return;
            }

            if (player.isSprinting) {
                if (flaggedLastTick) flagWithSetback();
                flaggedLastTick = true;
            } else {
                reward();
                flaggedLastTick = false;
            }
        }
    }
}
