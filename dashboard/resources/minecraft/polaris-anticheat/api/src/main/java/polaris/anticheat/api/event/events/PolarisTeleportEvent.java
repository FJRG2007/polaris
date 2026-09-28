package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris sends a teleport packet to the client.
 *
 * <p>Exists to help maintain compatibility with packet-based plugins and other
 * anticheats that track inbound/outbound teleport packets to build a
 * pending-teleport deque.
 *
 * <p>Fires on the Netty thread associated with the PacketEvents user.
 * Observational, not cancellable.
 */
public final class PolarisTeleportEvent extends PolarisEvent<PolarisTeleportEvent.Channel> {
    private PolarisTeleportEvent() {
        // Never instantiated — exists only as a Class key for bus.get(PolarisTeleportEvent.class).
    }

    @FunctionalInterface
    public interface Handler {
        void onTeleport(@NotNull PolarisUser user, int teleportId, long timestamp);
    }

    public static final class Channel extends EventChannel<PolarisTeleportEvent, Handler> {
        public Channel() {
            super(PolarisTeleportEvent.class, Handler.class);
        }

        public void onTeleport(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onTeleport(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onTeleport(@NotNull Object pluginContext, @NotNull Handler handler) {
            onTeleport(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onTeleport(Object, Handler)}. */
        @Deprecated
        public void onTeleport(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onTeleport(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user, int teleportId, long timestamp) {
            Entry<Handler>[] entries = entries();
            for (Entry<Handler> e : entries) {
                try {
                    e.handler.onTeleport(user, teleportId, timestamp);
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisTeleportEvent event, @NotNull Handler handler, boolean cancelled) {
            // Unreachable — PolarisTeleportEvent has no public constructor, so no caller can post() one.
            throw new UnsupportedOperationException("PolarisTeleportEvent has no legacy representation");
        }

        @org.jetbrains.annotations.ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, id, ts) -> abstractHandler.onAnyEvent(PolarisTeleportEvent.class, false);
        }
    }
}
