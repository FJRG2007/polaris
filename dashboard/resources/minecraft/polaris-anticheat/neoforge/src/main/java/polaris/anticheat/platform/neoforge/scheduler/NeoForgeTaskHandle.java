package polaris.anticheat.platform.neoforge.scheduler;

import lombok.Getter;
import polaris.anticheat.platform.api.scheduler.TaskHandle;

public class NeoForgeTaskHandle implements TaskHandle {
    private final Runnable cancellationTask;
    @Getter private boolean cancelled;
    @Getter private final boolean sync;

    public NeoForgeTaskHandle(Runnable cancellationTask, boolean sync) {
        this.cancellationTask = cancellationTask;
        this.sync = sync;
    }

    @Override
    public void cancel() {
        this.cancellationTask.run();
        this.cancelled = true;
    }
}
