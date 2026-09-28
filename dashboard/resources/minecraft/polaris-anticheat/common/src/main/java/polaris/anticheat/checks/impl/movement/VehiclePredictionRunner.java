package polaris.anticheat.checks.impl.movement;

import polaris.anticheat.checks.PolarisProcessor;
import polaris.anticheat.checks.type.VehicleListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.PositionUpdate;
import polaris.anticheat.utils.anticheat.update.VehiclePositionUpdate;

public class VehiclePredictionRunner extends PolarisProcessor implements VehicleListener {
    public VehiclePredictionRunner(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void process(final VehiclePositionUpdate vehicleUpdate) {
        // Vehicle onGround = false always
        // We don't do vehicle setbacks because vehicle netcode sucks.
        player.movementCheckRunner.processAndCheckMovementPacket(new PositionUpdate(vehicleUpdate.from(), vehicleUpdate.to(), false, null, null, vehicleUpdate.isTeleport()));
    }
}
