package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris sends a player-in-vehicle setback — the
 * {@code ServerVehicleMove} packet branch of {@link PolarisSetbackEvent}.
 *
 * <p>Unlike {@link PolarisPlayerSetbackEvent}, vehicle-move packets carry no
 * teleport id, so there is nothing for a packet-tracking consumer to
 * correlate against an incoming confirm; this event exists primarily for
 * the semantic "Polaris did a setback" audience (admin tools, stats,
 * anticheat-test harnesses).
 *
 * <p>Fires on the Netty thread associated with the user. Observational,
 * not cancellable.
 */
public final class PolarisVehicleSetbackEvent extends PolarisSetbackEvent<PolarisVehicleSetbackEvent.Channel> {
    private PolarisVehicleSetbackEvent() {
        // Never instantiated — exists only as a Class key for bus.get(PolarisVehicleSetbackEvent.class).
    }

    @FunctionalInterface
    public interface Handler {
        void onVehicleSetback(@NotNull PolarisUser user,
                              double x, double y, double z, long timestamp);
    }

    public static final class Channel extends EventChannel<PolarisVehicleSetbackEvent, Handler> {
        public Channel() {
            super(PolarisVehicleSetbackEvent.class, Handler.class);
        }

        public void onVehicleSetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onVehicleSetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onVehicleSetback(@NotNull Object pluginContext, @NotNull Handler handler) {
            onVehicleSetback(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onVehicleSetback(Object, Handler)}. */
        @Deprecated
        public void onVehicleSetback(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onVehicleSetback(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user,
                         double x, double y, double z, long timestamp) {
            Entry<Handler>[] entries = entries();
            for (Entry<Handler> e : entries) {
                try {
                    e.handler.onVehicleSetback(user, x, y, z, timestamp);
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisVehicleSetbackEvent event, @NotNull Handler handler, boolean cancelled) {
            // Unreachable — no public constructor, so no caller can post() one.
            throw new UnsupportedOperationException("PolarisVehicleSetbackEvent has no legacy representation");
        }

        /** Bridge from {@link PolarisSetbackEvent.Handler} — used by the abstract channel when a setback-level subscriber registers. */
        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromSetback(@NotNull PolarisSetbackEvent.Handler abstractHandler) {
            return (user, x, y, z, ts) -> abstractHandler.onAnySetback(user, ts);
        }

        /** Bridge from root-level {@link polaris.anticheat.api.event.PolarisEvent.Handler}. */
        @ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, x, y, z, ts) -> abstractHandler.onAnyEvent(PolarisVehicleSetbackEvent.class, false);
        }
    }
}
