package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris sends a transaction packet to the client.
 *
 * <p>Plugins can use this event to track transaction ids issued by Polaris and
 * correlate them with the matching {@link PolarisTransactionReceivedEvent} once a
 * response is received.
 *
 * <p>Fires on the Netty thread associated with the user. Observational, not
 * cancellable.
 */
public final class PolarisTransactionSendEvent extends PolarisEvent<PolarisTransactionSendEvent.Channel> {
    private PolarisTransactionSendEvent() {
        // Never instantiated — exists only as a Class key for bus.get(PolarisTransactionSendEvent.class).
    }

    @FunctionalInterface
    public interface Handler {
        void onTransactionSend(@NotNull PolarisUser user, int transactionId, long timestamp);
    }

    public static final class Channel extends EventChannel<PolarisTransactionSendEvent, Handler> {
        public Channel() {
            super(PolarisTransactionSendEvent.class, Handler.class);
        }

        public void onTransactionSend(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onTransactionSend(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onTransactionSend(@NotNull Object pluginContext, @NotNull Handler handler) {
            onTransactionSend(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onTransactionSend(Object, Handler)}. */
        @Deprecated
        public void onTransactionSend(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onTransactionSend(resolvePlugin(pluginContext), handler, priority);
        }

        public void fire(@NotNull PolarisUser user, int transactionId, long timestamp) {
            Entry<Handler>[] entries = entries();
            for (Entry<Handler> e : entries) {
                try {
                    e.handler.onTransactionSend(user, transactionId, timestamp);
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull PolarisTransactionSendEvent event, @NotNull Handler handler, boolean cancelled) {
            throw new UnsupportedOperationException("PolarisTransactionSendEvent has no legacy representation");
        }

        @org.jetbrains.annotations.ApiStatus.Internal
        public static @NotNull Handler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, id, ts) -> abstractHandler.onAnyEvent(PolarisTransactionSendEvent.class, false);
        }
    }
}
