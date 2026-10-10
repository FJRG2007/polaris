package polaris.anticheat.platform.neoforge.scheduler;

import org.jetbrains.annotations.NotNull;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.entity.PolarisEntity;
import polaris.anticheat.platform.api.scheduler.AsyncScheduler;
import polaris.anticheat.platform.api.scheduler.EntityScheduler;
import polaris.anticheat.platform.api.scheduler.GlobalRegionScheduler;
import polaris.anticheat.platform.api.scheduler.PlatformScheduler;
import polaris.anticheat.platform.api.scheduler.RegionScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;
import polaris.anticheat.platform.api.world.PlatformWorld;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.math.Location;

import java.util.Iterator;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.IntSupplier;

/**
 * The upstream Fabric platform's scheduler: one server thread, so the global, region
 * and entity schedulers are the same tick queue, run at the end of every server tick.
 */
public final class NeoForgePlatformScheduler implements PlatformScheduler {

    private final NeoForgeAsyncScheduler asyncScheduler = new NeoForgeAsyncScheduler();
    private final Queue<ScheduledTask> tasks = new ConcurrentLinkedQueue<>();
    private final IntSupplier tickCount;
    private final GlobalRegionScheduler global = new Global();
    private final RegionScheduler region = new Region();
    private final EntityScheduler entity = new Entity();

    public NeoForgePlatformScheduler(IntSupplier tickCount) {
        this.tickCount = tickCount;
    }

    /** Called by the mod at the end of every server tick. */
    public void tick() {
        Iterator<ScheduledTask> iterator = tasks.iterator();
        int now = tickCount.getAsInt();
        while (iterator.hasNext()) {
            ScheduledTask task = iterator.next();
            if (now < task.nextRunTick) continue;
            try {
                task.task.run();
            } catch (Exception e) {
                LogUtil.error("Error executing scheduled task ", e);
            }
            if (task.periodic) {
                task.nextRunTick = now + Math.max(1, task.period);
            } else {
                iterator.remove();
            }
        }
    }

    private TaskHandle schedule(PolarisPlugin plugin, Runnable task, long delay, long period, boolean periodic) {
        ScheduledTask scheduled = new ScheduledTask(task, tickCount.getAsInt() + delay, period, periodic, plugin);
        tasks.add(scheduled);
        return new NeoForgeTaskHandle(() -> tasks.remove(scheduled), true);
    }

    private void cancel(PolarisPlugin plugin) {
        tasks.removeIf(task -> task.plugin.equals(plugin));
    }

    public void shutdown() {
        asyncScheduler.cancelAll();
        tasks.clear();
    }

    @Override
    public @NotNull AsyncScheduler getAsyncScheduler() {
        return asyncScheduler;
    }

    @Override
    public @NotNull GlobalRegionScheduler getGlobalRegionScheduler() {
        return global;
    }

    @Override
    public @NotNull EntityScheduler getEntityScheduler() {
        return entity;
    }

    @Override
    public @NotNull RegionScheduler getRegionScheduler() {
        return region;
    }

    private static final class ScheduledTask {
        final Runnable task;
        final long period;
        final boolean periodic;
        final PolarisPlugin plugin;
        long nextRunTick;

        ScheduledTask(Runnable task, long nextRunTick, long period, boolean periodic, PolarisPlugin plugin) {
            this.task = task;
            this.nextRunTick = nextRunTick;
            this.period = period;
            this.periodic = periodic;
            this.plugin = plugin;
        }
    }

    private final class Global implements GlobalRegionScheduler {
        @Override
        public void execute(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
            run(plugin, task);
        }

        @Override
        public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
            return runDelayed(plugin, task, 0);
        }

        @Override
        public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay) {
            return schedule(plugin, task, delay, 0, false);
        }

        @Override
        public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
            return schedule(plugin, task, initialDelayTicks, periodTicks, true);
        }

        @Override
        public void cancel(@NotNull PolarisPlugin plugin) {
            NeoForgePlatformScheduler.this.cancel(plugin);
        }
    }

    private final class Region implements RegionScheduler {
        @Override
        public void execute(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task) {
            schedule(plugin, task, 0, 0, false);
        }

        @Override
        public void execute(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task) {
            schedule(plugin, task, 0, 0, false);
        }

        @Override
        public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task) {
            return schedule(plugin, task, 0, 0, false);
        }

        @Override
        public TaskHandle run(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task) {
            return schedule(plugin, task, 0, 0, false);
        }

        @Override
        public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task, long delayTicks) {
            return schedule(plugin, task, delayTicks, 0, false);
        }

        @Override
        public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task, long delayTicks) {
            return schedule(plugin, task, delayTicks, 0, false);
        }

        @Override
        public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull PlatformWorld world, int chunkX, int chunkZ, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
            return schedule(plugin, task, initialDelayTicks, periodTicks, true);
        }

        @Override
        public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Location location, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
            return schedule(plugin, task, initialDelayTicks, periodTicks, true);
        }
    }

    private final class Entity implements EntityScheduler {
        private Runnable withRetired(PolarisEntity entity, Runnable task, Runnable retired) {
            return () -> {
                task.run();
                if (retired != null && entity.isDead()) retired.run();
            };
        }

        @Override
        public void execute(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable run, Runnable retired, long delay) {
            runDelayed(entity, plugin, run, retired, delay);
        }

        @Override
        public TaskHandle run(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, Runnable retired) {
            return runDelayed(entity, plugin, task, retired, 0);
        }

        @Override
        public TaskHandle runDelayed(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, Runnable retired, long delayTicks) {
            return schedule(plugin, withRetired(entity, task, retired), delayTicks, 0, false);
        }

        @Override
        public TaskHandle runAtFixedRate(@NotNull PolarisEntity entity, @NotNull PolarisPlugin plugin, @NotNull Runnable task, Runnable retired, long initialDelayTicks, long periodTicks) {
            return schedule(plugin, withRetired(entity, task, retired), initialDelayTicks, periodTicks, true);
        }
    }
}
