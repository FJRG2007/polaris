package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

public class PolarisJoinEvent extends PolarisEvent<PolarisJoinEvent.Channel> implements PolarisUserEvent {
    private PolarisUser user;

    /** Pool constructor — fields populated via {@link #init}. */
    public PolarisJoinEvent() {
        super(true); // Async
    }

    public PolarisJoinEvent(PolarisUser user) {
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
        void onJoin(@NotNull PolarisUser user);
    }

    public static final class Channel extends EventChannel<PolarisJoinEvent, Handler> {
        private final ThreadLocal<PolarisJoinEvent> legacyPool = ThreadLocal.withInitial(PolarisJoinEvent::new);

        public Channel() {
            super(PolarisJoinEvent.class, Handler.class);
        }

        public void onJoin(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onJoin(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onJoin(@NotNull Object pluginContext, @NotNull Handler handler) {
            onJoin(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onJoin(Object, Handler)}. */
        @Deprecated
        public void onJoin(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onJoin(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user) {
            Entry<Handler>[] entries = entries();
            if (entries.length == 0) return;
            if (!hasLegacy()) {
                for (Entry<Handler> e : entries) {
                    try {
                        e.handler.onJoin(user);
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
                return;
            }
            PolarisJoinEvent pooled = legacyPool.get();
            pooled.init(user);
            for (Entry<Handler> e : entries) {
                try {
                    if (e.legacyListener != null) {
                        e.<PolarisJoinEvent>legacyListenerAs().handle(pooled);
                    } else {
                        e.handler.onJoin(user);
                    }
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisJoinEvent event, @NotNull Handler handler, boolean cancelled) {
            handler.onJoin(event.getUser());
            return false;
        }

        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return user -> abstractHandler.onAnyEvent(PolarisJoinEvent.class, false);
        }
    }
}
