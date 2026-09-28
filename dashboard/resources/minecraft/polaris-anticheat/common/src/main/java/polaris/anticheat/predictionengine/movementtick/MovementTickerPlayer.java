package polaris.anticheat.predictionengine.movementtick;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.predictionengine.predictions.PredictionEngineLava;
import polaris.anticheat.predictionengine.predictions.PredictionEngineNormal;
import polaris.anticheat.predictionengine.predictions.PredictionEngineWater;
import polaris.anticheat.predictionengine.predictions.PredictionEngineWaterLegacy;
import polaris.anticheat.utils.nmsutil.BlockProperties;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;

public class MovementTickerPlayer extends MovementTicker {
    public MovementTickerPlayer(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void doWaterMove(float swimSpeed, boolean isFalling, float swimFriction) {
        if (player.getClientVersion().isNewerThanOrEquals(ClientVersion.V_1_13)) {
            new PredictionEngineWater().guessBestMovement(swimSpeed, player, isFalling, player.gravity, swimFriction);
        } else {
            new PredictionEngineWaterLegacy().guessBestMovement(swimSpeed, player, swimFriction);
        }
    }

    @Override
    public void doLavaMove() {
        new PredictionEngineLava().guessBestMovement(0.02F, player);
    }

    @Override
    public void doNormalMove(float blockFriction) {
        new PredictionEngineNormal().guessBestMovement(BlockProperties.getFrictionInfluencedSpeed(blockFriction, player), player);
    }
}
