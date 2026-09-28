package polaris.anticheat.predictionengine.predictions.input.impl;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.predictionengine.predictions.input.FloatInput;
import polaris.anticheat.predictionengine.predictions.input.Input;
import polaris.anticheat.predictionengine.predictions.input.InputTransformer;
import polaris.anticheat.utils.math.PolarisMath;
import polaris.anticheat.utils.math.Vector3dm;

public class FloatInputTransformer implements InputTransformer<FloatInput> { // 1.7 - 1.13.2
    @Override
    public FloatInput transformInputsToVector(PolarisPlayer player, int sideways, int vertical, int forward) {
        float bestPossibleX;
        float bestPossibleZ;

        if (player.isSlowMovement) {
            bestPossibleX = sideways * player.sneakingSpeedMultiplier;
            bestPossibleZ = forward * player.sneakingSpeedMultiplier;
        } else {
            bestPossibleX = PolarisMath.clamp(sideways, -1, 1);
            bestPossibleZ = PolarisMath.clamp(forward, -1, 1);
        }

        if (player.packetStateData.isSlowedByUsingItem()) {
            bestPossibleX *= 0.2F;
            bestPossibleZ *= 0.2F;
        }

        bestPossibleX *= 0.98F;
        bestPossibleZ *= 0.98F;
        return new FloatInput(bestPossibleX, 0.0F, bestPossibleZ);
    }

    @Override
    public Vector3dm getMovementResultFromInput(PolarisPlayer player, Input inputVector, float speed, float yaw) {
        if (!(inputVector instanceof FloatInput input)) {
            throw new IllegalStateException("Expected input vector of type FloatInput, but got " + inputVector.getClass().getSimpleName());
        }

        float forward = input.forward(), sideways = input.sideways(), vertical = input.vertical();
        float lengthSquared = sideways * sideways + vertical * vertical + forward * forward;

        if (lengthSquared >= 1.0E-4F) {
            lengthSquared = PolarisMath.sqrt(lengthSquared);

            if (lengthSquared < 1.0F) {
                lengthSquared = 1.0F;
            }

            lengthSquared = speed / lengthSquared;
            sideways *= lengthSquared;
            vertical *= lengthSquared;
            forward *= lengthSquared;

            float yawRadians = PolarisMath.radians(yaw);
            float sin = player.trigHandler.sin(yawRadians);
            float cos = player.trigHandler.cos(yawRadians);
            return new Vector3dm(sideways * cos - forward * sin, vertical, forward * cos + sideways * sin);
        }

        return new Vector3dm();
    }
}
