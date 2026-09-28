package polaris.anticheat.checks.impl.movement;

import polaris.anticheat.checks.PolarisProcessor;
import polaris.anticheat.checks.type.PositionListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PositionUpdate;

public class PredictionRunner extends PolarisProcessor implements PositionListener {

    public PredictionRunner(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void onPositionUpdate(final PositionUpdate positionUpdate) {
        if (!player.inVehicle()) {
            player.movementCheckRunner.processAndCheckMovementPacket(positionUpdate);
        }
    }
}
