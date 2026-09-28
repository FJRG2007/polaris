package polaris.anticheat.platform.bukkit.scheduler.bukkit;

import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.scheduler.RegionScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;
import polaris.anticheat.platform.api.world.PlatformWorld;
import polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin;
import polaris.anticheat.utils.math.Location;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitScheduler;
import org.jetbrains.annotations.NotNull;

public class BukkitRegionScheduler implements RegionScheduler {

    private final BukkitScheduler bukkitScheduler = Bukkit.getScheduler();

    @Override
    public void execute(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task) {
        bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task);
    }

    @Override
    public void execute(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task) {
        bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task);
    }

    @Override
    public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task) {
        return new BukkitTaskHandle(bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task));
    }

    @Override
    public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task) {
        return new BukkitTaskHandle(bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task));
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task, long delayTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskLater(PolarisACBukkitLoaderPlugin.LOADER, task, delayTicks));
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task, long delayTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskLater(PolarisACBukkitLoaderPlugin.LOADER, task, delayTicks));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskTimer(PolarisACBukkitLoaderPlugin.LOADER, task, initialDelayTicks, periodTicks));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskTimer(PolarisACBukkitLoaderPlugin.LOADER, task, initialDelayTicks, periodTicks));
    }
}
