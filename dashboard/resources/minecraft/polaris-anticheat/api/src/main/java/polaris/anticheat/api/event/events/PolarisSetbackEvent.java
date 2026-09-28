package polaris.anticheat.api.event.events;

import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.AbstractEventChannel;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.NotNull;

/**
 * Fired when Polaris executes a setback against a player — the semantic
 * anticheat action, independent of the specific packet type used.
 *
 * <p>Dispatches through two concrete subtypes:
 * <ul>
 *   <li>{@link PolarisPlayerSetbackEvent} — player-on-foot setback, sent as a
 *       {@code ServerPlayerPositionAndLook} / teleport packet.</li>
 *   <li>{@link PolarisVehicleSetbackEvent} — player-in-vehicle setback, sent as
 *       a {@code ServerVehicleMove} packet.</li>
 * </ul>
 *
 * <p>Abstract-level subscribers receive a bridged dispatch for every fire
 * of either concrete child — the hot path goes through the child's channel
 * with no extra indirection. Observational, not cancellable.
 *
 * <p>Fires on the Netty thread associated with the user.
 */
public abstract class PolarisSetbackEvent<CHANNEL extends EventChannel<?, ?>> extends PolarisEvent<CHANNEL> {
    protected PolarisSetbackEvent() {
        super(true); // Async — setbacks are sent from the netty thread
    }

    /**
     * Abstract-level setback handler. Fires for every concrete
     * {@code PolarisSetbackEvent} subtype (player + vehicle) and any addon
     * subtypes that opt into bridging.
     *
     * <p>Carries only the fields both children share: the user and the
     * timestamp at which the setback packet was emitted. Subscribers that
     * need the destination position, teleport id, or packet type should
     * subscribe at the concrete child level.
     */
    @FunctionalInterface
    public interface Handler {
        void onAnySetback(@NotNull PolarisUser user, long timestamp);
    }

    public static final class Channel extends AbstractEventChannel<PolarisSetbackEvent<?>, Handler> {
        @SuppressWarnings({"unchecked", "rawtypes"})
        public Channel() {
            super((Class<PolarisSetbackEvent<?>>) (Class) PolarisSetbackEvent.class, Handler.class);
        }

        public void onAnySetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribeAbstract(handler, ListenerPriority.NORMAL, false, plugin);
        }

        public void onAnySetback(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribeAbstract(handler, priority, false, plugin);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onAnySetback(@NotNull Object pluginContext, @NotNull Handler handler) {
            subscribeAbstractResolving(pluginContext, handler, ListenerPriority.NORMAL, false);
        }

        /** @deprecated see {@link #onAnySetback(Object, Handler)}. */
        @Deprecated
        public void onAnySetback(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            subscribeAbstractResolving(pluginContext, handler, priority, false);
        }
    }
}
