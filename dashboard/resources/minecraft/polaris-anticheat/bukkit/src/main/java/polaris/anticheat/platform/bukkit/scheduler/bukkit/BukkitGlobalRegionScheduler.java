package polaris.anticheat.platform.bukkit.scheduler.bukkit;

import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.scheduler.GlobalRegionScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;
import polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitScheduler;
import org.jetbrains.annotations.NotNull;

public class BukkitGlobalRegionScheduler implements GlobalRegionScheduler {

    private final BukkitScheduler bukkitScheduler = Bukkit.getScheduler();

    @Override
    public void execute(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
        bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task);
    }

    @Override
    public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
        return new BukkitTaskHandle(bukkitScheduler.runTask(PolarisACBukkitLoaderPlugin.LOADER, task));
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskLater(PolarisACBukkitLoaderPlugin.LOADER, task, delay));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskTimer(PolarisACBukkitLoaderPlugin.LOADER, task, initialDelayTicks, periodTicks));
    }

    @Override
    public void cancel(@NotNull PolarisPlugin plugin) {
        bukkitScheduler.cancelTasks(PolarisACBukkitLoaderPlugin.LOADER);
    }
}
