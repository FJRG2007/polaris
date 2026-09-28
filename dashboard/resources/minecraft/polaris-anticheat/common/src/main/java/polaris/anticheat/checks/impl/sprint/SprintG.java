package polaris.anticheat.checks.impl.sprint;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.PostPredictionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PredictionComplete;
import com.github.retrooper.packetevents.protocol.entity.type.EntityTypes;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;

@CheckData(name = "SprintG", stableKey = "polarisac.sprint.water", description = "Sprinting while in water", experimental = true)
public class SprintG extends Check implements PostPredictionListener {
    public SprintG(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPredictionComplete(final PredictionComplete predictionComplete) {
        if (player.wasTouchingWater && (player.wasWasTouchingWater || player.getClientVersion() == ClientVersion.V_1_21_4)
                && !player.wasEyeInWater && player.getClientVersion().isNewerThanOrEquals(ClientVersion.V_1_13)
                && player.wasLastPredictionCompleteChecked && predictionComplete.isChecked()
                && !EntityTypes.isTypeInstanceOf(player.getVehicleType(), EntityTypes.CAMEL)
                && !player.isSwimming) {
            if (player.isSprinting) {
                flagWithSetback();
            } else {
                reward();
            }
        }
    }
}
