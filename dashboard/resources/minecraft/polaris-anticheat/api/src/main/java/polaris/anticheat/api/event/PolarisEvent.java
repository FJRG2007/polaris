package polaris.anticheat.api.event;

import polaris.anticheat.api.plugin.PolarisPlugin;
import lombok.Getter;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

/**
 * Base class for all Polaris events.
 *
 * <p>The {@code CHANNEL} type parameter classifies each event with its
 * {@link EventChannel} subclass so that {@link EventBus#get(Class)} can return
 * the correct channel type without a cast at the call site.
 *
 * <p>External code should prefer subscribing via
 * {@code bus.get(SomeEvent.class).onSomething(...)} — the legacy
 * {@link EventBus#post(PolarisEvent)} / class-keyed {@code subscribe} methods
 * remain for source compatibility with pre-1.3 callers and internally route
 * through the same {@code EventChannel}.
 *
 * @param <CHANNEL> the {@link EventChannel} subclass that dispatches this event
 */
public abstract class PolarisEvent<CHANNEL extends EventChannel<?, ?>> {
    private @Getter boolean cancelled = false;
    private final boolean async;

    protected PolarisEvent() {
        this(false); // Default to sync
    }

    protected PolarisEvent(boolean async) {
        this.async = async;
    }

    public void setCancelled(boolean cancelled) {
        if (!isCancellable()) {
            throw new IllegalStateException("Event " + getEventName() + " is not cancellable");
        }
        this.cancelled = cancelled;
    }

    public boolean isCancellable() {
        return false; // Override in cancellable events
    }

    public String getEventName() {
        return getClass().getSimpleName();
    }

    /**
     * Clears transient event state so a pooled instance can be reused for a
     * fresh dispatch. Subclasses holding additional mutable fields should
     * override and call {@code super.resetForReuse()} first.
     *
     * <p>Invoked by channel dispatch on a per-thread pooled legacy event
     * before it is re-populated. Not intended for direct caller use.
     */
    @ApiStatus.Internal
    protected void resetForReuse() {
        this.cancelled = false;
    }

    /**
     * Root-level event handler. Fires for every concrete event channel —
     * intended for debug / metrics consumers that want to count, categorise,
     * or observe cancellation state across all events without caring about
     * specific fields.
     *
     * <p>For cancellable events {@code currentlyCancelled} is the threaded
     * state at the point this handler runs; for non-cancellable events it's
     * always {@code false}. Return type is {@code void} because root-level
     * observers shouldn't affect cancellation — bridges thread the cancelled
     * state through priority-ordered dispatch unchanged.
     *
     * <p>Plugins that need positional fields for a specific event family
     * should subscribe at a narrower level — {@code PolarisCheckEvent.Handler}
     * for cancellable check events, or the concrete event's own
     * {@code on…(...)} for full field access.
     */
    @FunctionalInterface
    public interface Handler {
        void onAnyEvent(@NotNull Class<? extends PolarisEvent<?>> eventClass, boolean currentlyCancelled);
    }

    public static final class Channel extends AbstractEventChannel<PolarisEvent<?>, Handler> {
        @SuppressWarnings({"unchecked", "rawtypes"})
        public Channel() {
            super((Class<PolarisEvent<?>>) (Class) PolarisEvent.class, Handler.class);
        }

        public void onAnyEvent(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            subscribeAbstract(handler, ListenerPriority.NORMAL, false, plugin);
        }

        public void onAnyEvent(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            subscribeAbstract(handler, priority, false, plugin);
        }

        public void onAnyEvent(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            subscribeAbstract(handler, priority, ignoreCancelled, plugin);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onAnyEvent(@NotNull Object pluginContext, @NotNull Handler handler) {
            subscribeAbstractResolving(pluginContext, handler, ListenerPriority.NORMAL, false);
        }

        /** @deprecated see {@link #onAnyEvent(Object, Handler)}. */
        @Deprecated
        public void onAnyEvent(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            subscribeAbstractResolving(pluginContext, handler, priority, false);
        }

        /** @deprecated see {@link #onAnyEvent(Object, Handler)}. */
        @Deprecated
        public void onAnyEvent(@NotNull Object pluginContext, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            subscribeAbstractResolving(pluginContext, handler, priority, ignoreCancelled);
        }
    }
}
