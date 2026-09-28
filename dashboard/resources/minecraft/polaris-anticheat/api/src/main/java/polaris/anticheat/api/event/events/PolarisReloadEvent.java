package polaris.anticheat.api.event.events;

import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

public class PolarisReloadEvent extends PolarisEvent<PolarisReloadEvent.Channel> {
    private boolean success;

    /** Pool constructor — fields populated via {@link #init}. */
    public PolarisReloadEvent() {
        super(true); // Async
    }

    public PolarisReloadEvent(boolean success) {
        super(true); // Async
        this.success = success;
    }

    @ApiStatus.Internal
    public void init(boolean success) {
        resetForReuse();
        this.success = success;
    }

    public boolean isSuccess() {
        return success;
    }

    @FunctionalInterface
    public interface Handler {
        void onReload(boolean success);
    }

    public static final class Channel extends EventChannel<PolarisReloadEvent, Handler> {
        private final ThreadLocal<PolarisReloadEvent> legacyPool = ThreadLocal.withInitial(PolarisReloadEvent::new);

        public Channel() {
            super(PolarisReloadEvent.class, Handler.class);
        }

        public void onReload(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onReload(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onReload(@NotNull Object pluginContext, @NotNull Handler handler) {
            onReload(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onReload(Object, Handler)}. */
        @Deprecated
        public void onReload(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onReload(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(boolean success) {
            Entry<Handler>[] entries = entries();
            if (entries.length == 0) return;
            if (!hasLegacy()) {
                for (Entry<Handler> e : entries) {
                    try {
                        e.handler.onReload(success);
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
                return;
            }
            PolarisReloadEvent pooled = legacyPool.get();
            pooled.init(success);
            for (Entry<Handler> e : entries) {
                try {
                    if (e.legacyListener != null) {
                        e.<PolarisReloadEvent>legacyListenerAs().handle(pooled);
                    } else {
                        e.handler.onReload(success);
                    }
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisReloadEvent event, @NotNull Handler handler, boolean cancelled) {
            handler.onReload(event.isSuccess());
            return false;
        }

        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return success -> abstractHandler.onAnyEvent(PolarisReloadEvent.class, false);
        }
    }
}
