package polaris.anticheat.platform.bukkit.scheduler.folia;

import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.entity.PolarisEntity;
import polaris.anticheat.platform.api.scheduler.EntityScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;
import polaris.anticheat.platform.bukkit.PolarisACBukkitLoaderPlugin;
import polaris.anticheat.platform.bukkit.entity.BukkitPolarisEntity;
import io.papermc.paper.threadedregions.scheduler.ScheduledTask;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class FoliaEntityScheduler implements EntityScheduler {

    @Override
    public void execute(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, @Nullable Runnable retired, long delay) {
        ((BukkitPolarisEntity) entity).getBukkitEntity().getScheduler().execute(PolarisACBukkitLoaderPlugin.LOADER, task, retired, delay);
    }

    @Override
    public TaskHandle run(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, @Nullable Runnable retired) {
        ScheduledTask scheduled = ((BukkitPolarisEntity) entity).getBukkitEntity().getScheduler().run(
                PolarisACBukkitLoaderPlugin.LOADER,
                ignored -> task.run(),
                retired
        );

        return scheduled == null ? null : new FoliaTaskHandle(scheduled);
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, @Nullable Runnable retired, long delayTicks) {
        ScheduledTask scheduled = ((BukkitPolarisEntity) entity).getBukkitEntity().getScheduler().runDelayed(
                PolarisACBukkitLoaderPlugin.LOADER,
                ignored -> task.run(),
                retired,
                delayTicks
        );

        return scheduled == null ? null : new FoliaTaskHandle(scheduled);
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, @Nullable Runnable retired, long initialDelayTicks, long periodTicks) {
        ScheduledTask scheduled = ((BukkitPolarisEntity) entity).getBukkitEntity().getScheduler().runAtFixedRate(
                PolarisACBukkitLoaderPlugin.LOADER,
                ignored -> task.run(),
                retired,
                initialDelayTicks,
                periodTicks
        );

        return scheduled == null ? null : new FoliaTaskHandle(scheduled);
    }
}
