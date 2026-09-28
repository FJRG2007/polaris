package polaris.anticheat.predictionengine.predictions.rideable;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.predictionengine.predictions.PredictionEngineWater;
import polaris.anticheat.predictionengine.predictions.input.Input;
import polaris.anticheat.utils.data.VectorData;
import lombok.RequiredArgsConstructor;

import java.util.List;
import java.util.Set;

@RequiredArgsConstructor
public class PredictionEngineRideableWater extends PredictionEngineWater {
    protected final Input movementVector;

    @Override
    public void addJumpsToPossibilities(PolarisPlayer player, Set<VectorData> existingVelocities) {
        PredictionEngineRideableUtils.handleJumps(player, existingVelocities);
    }

    @Override
    public List<VectorData> applyInputsToVelocityPossibilities(PolarisPlayer player, Set<VectorData> possibleVectors, float speed) {
        return PredictionEngineRideableUtils.applyInputsToVelocityPossibilities(movementVector, player, possibleVectors, speed);
    }

}
