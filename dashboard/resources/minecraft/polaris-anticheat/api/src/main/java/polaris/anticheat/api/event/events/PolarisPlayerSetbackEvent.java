package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris sends a player-on-foot setback — the
 * {@code ServerPlayerPositionAndLook} / teleport packet branch of
 * {@link PolarisSetbackEvent}.
 *
 * <p>Carries the outbound teleport id so packet-tracking consumers
 * (e.g. sibling anticheats that need to dedupe the teleport-confirm the
 * client will emit in response) can correlate on id. See
 * {@link PolarisTeleportEvent} for the complementary
 * "every outbound teleport packet" signal — that event fires at this
 * site as well so either subscription sees the setback teleport.
 *
 * <p>Fires on the Netty thread associated with the user. Observational,
 * not cancellable.
 */
public final class PolarisPlayerSetbackEvent extends PolarisSetbackEvent<PolarisPlayerSetbackEvent.Channel> {
    private PolarisPlayerSetbackEvent() {
        // Never instantiated — exists only as a Class key for bus.get(PolarisPlayerSetbackEvent.class).
    }

    @FunctionalInterface
    public interface Handler {
        void onPlayerSetback(@NotNull PolarisUser user, int teleportId,
                             double x, double y, double z, long timestamp);
    }

    public static final class Channel extends EventChannel<PolarisPlayerSetbackEvent, Handler> {
        public Channel() {
            super(PolarisPlayerSetbackEvent.class, Handler.class);
        }

        public void onPlayerSetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onPlayerSetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onPlayerSetback(@NotNull Object pluginContext, @NotNull Handler handler) {
            onPlayerSetback(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onPlayerSetback(Object, Handler)}. */
        @Deprecated
        public void onPlayerSetback(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onPlayerSetback(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user, int teleportId,
                         double x, double y, double z, long timestamp) {
            Entry<Handler>[] entries = entries();
            for (Entry<Handler> e : entries) {
                try {
                    e.handler.onPlayerSetback(user, teleportId, x, y, z, timestamp);
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisPlayerSetbackEvent event, @NotNull Handler handler, boolean cancelled) {
            // Unreachable — no public constructor, so no caller can post() one.
            throw new UnsupportedOperationException("PolarisPlayerSetbackEvent has no legacy representation");
        }

        /** Bridge from {@link PolarisSetbackEvent.Handler} — used by the abstract channel when a setback-level subscriber registers. */
        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromSetback(@NotNull PolarisSetbackEvent.Handler abstractHandler) {
            return (user, id, x, y, z, ts) -> abstractHandler.onAnySetback(user, ts);
        }

        /** Bridge from root-level {@link polaris.anticheat.api.event.PolarisEvent.Handler}. */
        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, id, x, y, z, ts) -> abstractHandler.onAnyEvent(PolarisPlayerSetbackEvent.class, false);
        }
    }
}
