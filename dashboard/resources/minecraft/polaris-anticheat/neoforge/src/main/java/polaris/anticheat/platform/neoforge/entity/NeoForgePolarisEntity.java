package polaris.anticheat.platform.neoforge.entity;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Relative;
import org.jetbrains.annotations.NotNull;
import polaris.anticheat.platform.api.entity.PolarisEntity;
import polaris.anticheat.platform.api.world.PlatformWorld;
import polaris.anticheat.platform.neoforge.NeoForgeServer;
import polaris.anticheat.platform.neoforge.world.NeoForgePlatformWorld;
import polaris.anticheat.utils.math.Location;

import java.util.EnumSet;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

public class NeoForgePolarisEntity<T extends Entity> implements PolarisEntity {

    protected volatile T entity;

    public NeoForgePolarisEntity(T entity) {
        this.entity = Objects.requireNonNull(entity, "entity");
    }

    protected void setNativeEntity(T entity) {
        this.entity = Objects.requireNonNull(entity, "entity");
    }

    @Override
    public UUID getUniqueId() {
        return entity.getUUID();
    }

    @Override
    public boolean eject() {
        if (entity.isVehicle()) {
            entity.ejectPassengers();
            return true;
        }
        return false;
    }

    @Override
    public CompletableFuture<Boolean> teleportAsync(Location location) {
        return NeoForgeServer.supplySync(() -> {
            if (!(location.getWorld() instanceof NeoForgePlatformWorld world)) return false;
            ServerLevel level = world.level();
            return entity.teleportTo(level, location.getX(), location.getY(), location.getZ(),
                    EnumSet.noneOf(Relative.class), location.getYaw(), location.getPitch(), true);
        });
    }

    @Override
    public @NotNull T getNative() {
        return entity;
    }

    @Override
    public boolean isDead() {
        return entity instanceof LivingEntity living ? living.isDeadOrDying() : entity.isRemoved();
    }

    @Override
    public PlatformWorld getWorld() {
        return entity.level() instanceof ServerLevel level ? NeoForgePlatformWorld.of(level) : null;
    }

    @Override
    public Location getLocation() {
        return new Location(getWorld(), entity.getX(), entity.getY(), entity.getZ(),
                entity.getViewYRot(1.0F), entity.getViewXRot(1.0F));
    }

    @Override
    public double distanceSquared(double x, double y, double z) {
        double dx = entity.getX() - x;
        double dy = entity.getY() - y;
        double dz = entity.getZ() - z;
        return dx * dx + dy * dy + dz * dz;
    }
}
