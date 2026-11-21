package polaris.anticheat.platform.forge.scheduler;

import lombok.Getter;
import polaris.anticheat.platform.api.scheduler.TaskHandle;

public class ForgeTaskHandle implements TaskHandle {
    private final Runnable cancellationTask;
    @Getter private boolean cancelled;
    @Getter private final boolean sync;

    public ForgeTaskHandle(Runnable cancellationTask, boolean sync) {
        this.cancellationTask = cancellationTask;
        this.sync = sync;
    }

    @Override
    public void cancel() {
        this.cancellationTask.run();
        this.cancelled = true;
    }
}
