package polaris.anticheat.predictionengine.movementtick;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.predictionengine.predictions.input.Input;
import polaris.anticheat.predictionengine.predictions.rideable.PredictionEngineRideableLava;
import polaris.anticheat.predictionengine.predictions.rideable.PredictionEngineRideableNormal;
import polaris.anticheat.predictionengine.predictions.rideable.PredictionEngineRideableWater;
import polaris.anticheat.predictionengine.predictions.rideable.PredictionEngineRideableWaterLegacy;
import polaris.anticheat.utils.nmsutil.BlockProperties;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;

public class MovementTickerLivingVehicle extends MovementTicker {
    protected Input movementInput;

    public MovementTickerLivingVehicle(PolarisPlayer player) {
        super(player);
        this.movementInput = Input.createInput(player, 0, 0, 0);
    }

    @Override
    public void doWaterMove(float swimSpeed, boolean isFalling, float swimFriction) {
        if (player.getClientVersion().isNewerThanOrEquals(ClientVersion.V_1_13)) {
            new PredictionEngineRideableWater(movementInput).guessBestMovement(swimSpeed, player, isFalling, player.gravity, swimFriction);
        } else {
            new PredictionEngineRideableWaterLegacy(movementInput).guessBestMovement(swimSpeed, player, swimFriction);
        }
    }

    @Override
    public void doLavaMove() {
        new PredictionEngineRideableLava(movementInput).guessBestMovement(0.02F, player);
    }

    @Override
    public void doNormalMove(float blockFriction) {
        new PredictionEngineRideableNormal(movementInput).guessBestMovement(BlockProperties.getFrictionInfluencedSpeed(blockFriction, player), player);
    }
}
