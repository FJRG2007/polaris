package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

public class PolarisQuitEvent extends PolarisEvent<PolarisQuitEvent.Channel> implements PolarisUserEvent {
    private PolarisUser user;

    /** Pool constructor — fields populated via {@link #init}. */
    public PolarisQuitEvent() {
        super(true); // Async
    }

    public PolarisQuitEvent(PolarisUser user) {
        super(true); // Async
        this.user = user;
    }

    @ApiStatus.Internal
    public void init(PolarisUser user) {
        resetForReuse();
        this.user = user;
    }

    @Override
    public PolarisUser getUser() {
        return user;
    }

    @FunctionalInterface
    public interface Handler {
        void onQuit(@NotNull PolarisUser user);
    }

    public static final class Channel extends EventChannel<PolarisQuitEvent, Handler> {
        private final ThreadLocal<PolarisQuitEvent> legacyPool = ThreadLocal.withInitial(PolarisQuitEvent::new);

        public Channel() {
            super(PolarisQuitEvent.class, Handler.class);
        }

        public void onQuit(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onQuit(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onQuit(@NotNull Object pluginContext, @NotNull Handler handler) {
            onQuit(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onQuit(Object, Handler)}. */
        @Deprecated
        public void onQuit(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onQuit(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user) {
            Entry<Handler>[] entries = entries();
            if (entries.length == 0) return;
            if (!hasLegacy()) {
                for (Entry<Handler> e : entries) {
                    try {
                        e.handler.onQuit(user);
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
                return;
            }
            PolarisQuitEvent pooled = legacyPool.get();
            pooled.init(user);
            for (Entry<Handler> e : entries) {
                try {
                    if (e.legacyListener != null) {
                        e.<PolarisQuitEvent>legacyListenerAs().handle(pooled);
                    } else {
                        e.handler.onQuit(user);
                    }
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisQuitEvent event, @NotNull Handler handler, boolean cancelled) {
            handler.onQuit(event.getUser());
            return false;
        }

        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return user -> abstractHandler.onAnyEvent(PolarisQuitEvent.class, false);
        }
    }
}
