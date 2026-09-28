package polaris.anticheat.checks.impl.aim;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.checks.type.RotationListener;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.update.RotationUpdate;

// Based on Kauri AimA,
// I also discovered this flaw before open source Kauri, but did not want to open source its detection.
// It works on clients who % 360 their rotation.
@CheckData(name = "AimModulo360", stableKey = "polarisac.aim.modulo_360", description = "Sent a large yaw snap", decay = 0.005)
public class AimModulo360 extends Check implements RotationListener {

    private float lastDeltaYaw;

    public AimModulo360(PolarisPlayer player) {
        super(player);
    }

    @Override
    public void process(final RotationUpdate rotationUpdate) {
        // Exempt for teleport, entering a vehicle due to rotation reset or
        // after forced, client-sided rotation change after interacting with a horse (not necessarily mounting it)
        if (player.packetStateData.lastPacketWasTeleport || player.vehicleData.wasVehicleSwitch
                || player.packetStateData.horseInteractCausedForcedRotation) {
            lastDeltaYaw = rotationUpdate.deltaYaw();
            return;
        }

        if (player.yaw < 360 && player.yaw > -360 && Math.abs(rotationUpdate.deltaYaw()) > 320 && Math.abs(lastDeltaYaw) < 30) {
            flag();
        } else {
            reward();
        }

        lastDeltaYaw = rotationUpdate.deltaYaw();
    }
}
