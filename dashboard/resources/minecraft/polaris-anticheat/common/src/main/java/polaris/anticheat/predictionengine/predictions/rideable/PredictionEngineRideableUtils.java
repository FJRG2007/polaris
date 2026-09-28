package polaris.anticheat.predictionengine.predictions.rideable;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.predictionengine.predictions.PredictionEngineNormal;
import polaris.anticheat.predictionengine.predictions.input.Input;
import polaris.anticheat.predictionengine.predictions.input.InputTransformer;
import polaris.anticheat.utils.data.IndexedVector3d;
import polaris.anticheat.utils.data.IntToObjectPair;
import polaris.anticheat.utils.data.VectorData;
import polaris.anticheat.utils.data.packetentity.JumpableEntity;
import polaris.anticheat.utils.math.Vector3dm;
import polaris.anticheat.utils.nmsutil.StuckSpeed;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import lombok.experimental.UtilityClass;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@UtilityClass
public final class PredictionEngineRideableUtils {

    public static Set<VectorData> handleJumps(PolarisPlayer player, Set<VectorData> possibleVectors) {
        if (!(player.compensatedEntities.self.getRiding() instanceof JumpableEntity jumpable))
            return possibleVectors;

        // TODO: onGround can desync if it's first riding tick
        jumpable.executeJump(player, possibleVectors);

        // More jumping stuff
        boolean legacyJumpingMechanics = player.getClientVersion().isOlderThanOrEquals(ClientVersion.V_1_19_3);
        boolean onGround = legacyJumpingMechanics
                ? player.clientControlledVerticalCollision
                : player.lastOnGround;
        if (onGround) {
            if (legacyJumpingMechanics) {
                jumpable.setJumpPower(0.0F);
            }

            jumpable.setJumping(false);
        }

        return possibleVectors;
    }

    public static List<VectorData> applyInputsToVelocityPossibilities(Input movementVector, PolarisPlayer player, Set<VectorData> possibleVectors, float speed) {
        List<VectorData> returnVectors = new ArrayList<>();

        InputTransformer<?> inputTransformer = InputTransformer.getTransformer(player);
        for (VectorData possibleLastTickOutput : possibleVectors) {
            VectorData result = new VectorData(possibleLastTickOutput.vector.clone().add(inputTransformer.getMovementResultFromInput(player, movementVector, speed, player.yaw)), possibleLastTickOutput, VectorData.VectorType.InputResult);
            result.input = new Vector3dm(player.vehicleData.vehicleForward, 0, player.vehicleData.vehicleHorizontal);
            addStuckSpeedResults(player, returnVectors, result);

            // This is the laziest way to reduce false positives such as horse rearing
            // No bypasses can ever be derived from this, so why not?
            result = new VectorData(possibleLastTickOutput.vector.clone(), possibleLastTickOutput, VectorData.VectorType.InputResult);
            result.input = new Vector3dm(player.vehicleData.vehicleForward, 0, player.vehicleData.vehicleHorizontal);
            addStuckSpeedResults(player, returnVectors, result);
        }

        return returnVectors;
    }

    private static void addStuckSpeedResults(PolarisPlayer player, List<VectorData> returnVectors, VectorData result) {
        if (player.uncertaintyHandler.shouldSimulateStuckSpeed) {
            // only simulate no stuck speed if player is leaving
            if (player.uncertaintyHandler.stuckSpeedMultiplierMask == 0 || !player.isForceStuckSpeed())
                addStuckSpeedResult(player, returnVectors, result, null);
            addStuckSpeedResult(player, returnVectors, result, player.stuckSpeedMultiplier);
            addPossibleStuckSpeedResults(player, returnVectors, result);
        } else {
            for (int applyStuckSpeed = 1; applyStuckSpeed >= 0; applyStuckSpeed--) {
                if (applyStuckSpeed == 0 && player.isForceStuckSpeed()) break;

                addStuckSpeedResult(player, returnVectors, result, applyStuckSpeed != 0 ? player.stuckSpeedMultiplier : null);
            }
        }
    }

    private static void addPossibleStuckSpeedResults(PolarisPlayer player, List<VectorData> returnVectors, VectorData result) {
        int possibleStuckSpeedMultipliers = player.uncertaintyHandler.stuckSpeedMultiplierMask;
        for (IndexedVector3d stuckSpeedMultiplier : StuckSpeed.POSSIBILITIES) {
            if ((possibleStuckSpeedMultipliers & stuckSpeedMultiplier.getIndex()) != 0 && stuckSpeedMultiplier.getIndex() != player.stuckSpeedMultiplier.getIndex()) {
                addStuckSpeedResult(player, returnVectors, result, stuckSpeedMultiplier);
            }
        }
    }

    private static void addStuckSpeedResult(PolarisPlayer player, List<VectorData> returnVectors, VectorData result, IndexedVector3d stuckSpeedMultiplier) {
        if (stuckSpeedMultiplier != null) {
            result = result.returnNewModified(result.vector.clone().multiply(stuckSpeedMultiplier), VectorData.VectorType.StuckMultiplier);
        }
        result.stuckSpeedMultiplier = stuckSpeedMultiplier == null ? StuckSpeed.NONE : stuckSpeedMultiplier;

        result = result.returnNewModified(new PredictionEngineNormal().handleOnClimbable(result.vector.clone(), player), VectorData.VectorType.Climbable);
        returnVectors.add(result);
    }

    public static void applyPendingJumps(PolarisPlayer player) {
        IntToObjectPair<JumpableEntity> pendingJump;
        while ((pendingJump = player.vehicleData.pendingJumps.poll()) != null) {
            JumpableEntity jumpable = pendingJump.second();
            if (jumpable.canPlayerJump(player)) {
                int jumpBoost = pendingJump.first();
                if (jumpBoost < 0) jumpBoost = 0;
                if (jumpBoost >= 90) {
                    jumpable.setJumpPower(1);
                } else {
                    jumpable.setJumpPower(0.4F + 0.4F * jumpBoost / 90.0F);
                }
            }
        }
    }

}
