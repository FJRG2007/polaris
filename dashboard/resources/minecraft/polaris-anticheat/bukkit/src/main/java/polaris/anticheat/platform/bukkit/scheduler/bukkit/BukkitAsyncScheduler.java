package polaris.anticheat.platform.bukkit.scheduler.bukkit;

import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.scheduler.AsyncScheduler;
import polaris.anticheat.platform.api.scheduler.PlatformScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;
import polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitScheduler;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.TimeUnit;

public class BukkitAsyncScheduler implements AsyncScheduler {

    private final BukkitScheduler bukkitScheduler = Bukkit.getScheduler();

    @Override
    public TaskHandle runNow(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskAsynchronously(PolarisACBukkitLoaderPlugin.LOADER, task));
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay, @NotNull TimeUnit timeUnit) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskLaterAsynchronously(
                PolarisACBukkitLoaderPlugin.LOADER,
                task,
                PlatformScheduler.convertTimeToTicks(delay, timeUnit)
        ));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay, long period, @NotNull TimeUnit timeUnit) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskTimerAsynchronously(
                PolarisACBukkitLoaderPlugin.LOADER,
                task,
                PlatformScheduler.convertTimeToTicks(delay, timeUnit),
                PlatformScheduler.convertTimeToTicks(period, timeUnit)
        ));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
        return new BukkitTaskHandle(bukkitScheduler.runTaskTimerAsynchronously(
                PolarisACBukkitLoaderPlugin.LOADER,
                task,
                initialDelayTicks,
                periodTicks
        ));
    }

    @Override
    public void cancel(@NotNull PolarisPlugin plugin) {
        bukkitScheduler.cancelTasks(PolarisACBukkitLoaderPlugin.LOADER);
    }
}
