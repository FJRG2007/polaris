package polaris.anticheat.platform.api.entity;

import polaris.anticheat.api.PolarisIdentity;
import polaris.anticheat.platform.api.world.PlatformWorld;
import polaris.anticheat.utils.math.Location;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.CompletableFuture;

public interface PolarisEntity extends PolarisIdentity {
    /**
     * Eject any passenger.
     *
     * @return True if there was a passenger.
     */
    boolean eject();

    CompletableFuture<Boolean> teleportAsync(Location location);

    @NotNull
    Object getNative();

    boolean isDead();

    PlatformWorld getWorld();

    Location getLocation();

    double distanceSquared(double x, double y, double z);
}
