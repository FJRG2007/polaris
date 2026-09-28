package polaris.anticheat.checks.impl.vehicle;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "VehicleC", stableKey = "polarisac.vehicle.vehicle_control", description = "Moved a vehicle in a way that did not match predicted vehicle control")
public class VehicleC extends Check {
    public VehicleC(PolarisPlayer player) {
        super(player);
    }
}
