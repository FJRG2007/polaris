package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris receives an inbound response for a transaction packet that
 * it previously sent.
 *
 * <p>Polaris cancels these inbound packets by default, controlled by the
 * {@code disable-pong-cancelling} option in {@code config.yml}. The
 * {@code packetCancelled} parameter reflects whether Polaris cancelled packet
 * handling; it is not an event-cancellation flag (this event is observational
 * and not cancellable).
 *
 * <p>Only fires for transactions initiated by Polaris, on the Netty thread
 * associated with the user.
 */
public final class PolarisTransactionReceivedEvent extends PolarisEvent<PolarisTransactionReceivedEvent.Channel> {
    private PolarisTransactionReceivedEvent() {
        // Never instantiated — exists only as a Class key for bus.get(PolarisTransactionReceivedEvent.class).
    }

    @FunctionalInterface
    public interface Handler {
        void onTransactionReceived(@NotNull PolarisUser user, int transactionId, boolean packetCancelled, long timestamp);
    }

    public static final class Channel extends EventChannel<PolarisTransactionReceivedEvent, Handler> {
        public Channel() {
            super(PolarisTransactionReceivedEvent.class, Handler.class);
        }

        public void onTransactionReceived(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onTransactionReceived(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onTransactionReceived(@NotNull Object pluginContext, @NotNull Handler handler) {
            onTransactionReceived(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onTransactionReceived(Object, Handler)}. */
        @Deprecated
        public void onTransactionReceived(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onTransactionReceived(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user, int transactionId, boolean packetCancelled, long timestamp) {
            Entry<Handler>[] entries = entries();
            for (Entry<Handler> e : entries) {
                try {
                    e.handler.onTransactionReceived(user, transactionId, packetCancelled, timestamp);
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisTransactionReceivedEvent event, @NotNull Handler handler, boolean cancelled) {
            throw new UnsupportedOperationException("PolarisTransactionReceivedEvent has no legacy representation");
        }

        @org.jetbrains.annotations.ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, id, c, ts) -> abstractHandler.onAnyEvent(PolarisTransactionReceivedEvent.class, false);
        }
    }
}
