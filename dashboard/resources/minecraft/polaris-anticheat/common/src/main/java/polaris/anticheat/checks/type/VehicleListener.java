package polaris.anticheat.checks.type;

import polaris.anticheat.utils.anticheat.update.VehiclePositionUpdate;

public interface VehicleListener {
    void process(final VehiclePositionUpdate vehicleUpdate);
}
