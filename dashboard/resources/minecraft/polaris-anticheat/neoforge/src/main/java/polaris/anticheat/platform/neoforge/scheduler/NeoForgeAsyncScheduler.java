package polaris.anticheat.platform.neoforge.scheduler;

import org.jetbrains.annotations.NotNull;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.platform.api.scheduler.AsyncScheduler;
import polaris.anticheat.platform.api.scheduler.PlatformScheduler;
import polaris.anticheat.platform.api.scheduler.TaskHandle;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/** The upstream Fabric platform's: a small daemon pool, off the server thread. */
final class NeoForgeAsyncScheduler implements AsyncScheduler {

    private final ScheduledExecutorService executor;
    private final Map<Object, Tracked> tasks = new ConcurrentHashMap<>();

    private static final class Tracked {
        private final PolarisPlugin plugin;
        private volatile Future<?> future;

        private Tracked(PolarisPlugin plugin) {
            this.plugin = plugin;
        }
    }

    NeoForgeAsyncScheduler() {
        AtomicInteger threadCount = new AtomicInteger();
        this.executor = Executors.newScheduledThreadPool(
                Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() / 2)),
                runnable -> {
                    Thread thread = new Thread(runnable, "PolarisAC-Async-" + threadCount.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                });
    }

    @Override
    public TaskHandle runNow(@NotNull PolarisPlugin plugin, @NotNull Runnable task) {
        return schedule(plugin, task, true, executor::submit);
    }

    @Override
    public TaskHandle runDelayed(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay, @NotNull TimeUnit timeUnit) {
        return schedule(plugin, task, true, body -> executor.schedule(body, delay, timeUnit));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long delay, long period, @NotNull TimeUnit timeUnit) {
        return schedule(plugin, task, false, body -> executor.scheduleAtFixedRate(body, delay, Math.max(1, period), timeUnit));
    }

    @Override
    public TaskHandle runAtFixedRate(@NotNull PolarisPlugin plugin, @NotNull Runnable task, long initialDelayTicks, long periodTicks) {
        return runAtFixedRate(plugin, task,
                PlatformScheduler.convertTicksToTime(initialDelayTicks, TimeUnit.MILLISECONDS),
                PlatformScheduler.convertTicksToTime(periodTicks, TimeUnit.MILLISECONDS),
                TimeUnit.MILLISECONDS);
    }

    private TaskHandle schedule(PolarisPlugin plugin, Runnable task, boolean oneShot, Function<Runnable, Future<?>> submit) {
        Object token = new Object();
        Tracked tracked = new Tracked(plugin);
        tasks.put(token, tracked);
        Runnable body = oneShot ? () -> {
            try {
                task.run();
            } finally {
                tasks.remove(token);
            }
        } : task;
        tracked.future = submit.apply(body);
        return new NeoForgeTaskHandle(() -> {
            Tracked removed = tasks.remove(token);
            if (removed != null && removed.future != null) removed.future.cancel(true);
        }, false);
    }

    @Override
    public void cancel(@NotNull PolarisPlugin plugin) {
        tasks.values().removeIf(tracked -> {
            if (!tracked.plugin.equals(plugin)) return false;
            Future<?> future = tracked.future;
            if (future != null) future.cancel(true);
            return true;
        });
    }

    void cancelAll() {
        tasks.values().forEach(tracked -> {
            Future<?> future = tracked.future;
            if (future != null) future.cancel(true);
        });
        tasks.clear();
    }
}
