package polaris.anticheat.api.event;

import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

/**
 * Polaris's event bus.
 *
 * <h2>Recommended use — channel-based subscribe and fire</h2>
 * {@link #get(Class) bus.get(EventClass.class)} returns the event's typed
 * {@link EventChannel}. Subscribe through the channel's fluent {@code onX(...)}
 * methods and fire (internally) through its {@code fire(...)} method — dispatch
 * is zero-allocation on the hot path and invokes handlers in priority order.
 *
 * <pre>{@code
 * // Subscribe
 * EventBus bus = PolarisAPIProvider.getAPI().getEventBus();
 * bus.get(FlagEvent.class).onFlagSupplier(plugin, (user, check, verbose, cancelled) -> {
 *     getLogger().info("flag " + check.getClass().getSimpleName());
 *     return cancelled;
 * });
 *
 * // Hot-path: cache the channel in a static final
 * private static final FlagEvent.Channel FLAG =
 *     PolarisAPI.INSTANCE.getEventBus().get(FlagEvent.class);
 * // then FLAG.fire(user, check, verbose);
 * }</pre>
 *
 * <h2>Legacy API (deprecated)</h2>
 * The class-keyed {@code subscribe(...)}, {@code post(...)}, and reflective
 * {@code registerAnnotatedListeners(...)} methods are preserved for source
 * compatibility with pre-1.3 callers. Internally they route through the same
 * {@link EventChannel}s as the typed API — a {@code post(legacyEvent)} reaches
 * both legacy-registered listeners AND typed handlers (via the channel's
 * unpack path).
 */
public interface EventBus {

    // ───── Typed channel API (recommended) ─────────────────────────────────

    /**
     * Returns the {@link EventChannel} for the given event class. Callers
     * should cache the returned reference (e.g. in a {@code static final}
     * field) so the hot-path fire/subscribe call is a direct virtual dispatch
     * rather than a registry lookup.
     *
     * <p>The returned channel is stable for the life of the bus.
     *
     * @param eventClass the event's own {@code Class} object
     * @param <E>        the event type
     * @param <C>        the channel subclass associated with {@code E}, inferred via {@code E extends PolarisEvent<C>}
     */
    <E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>> @NotNull C get(@NotNull Class<E> eventClass);

    /**
     * Registers a channel for an event type not known at bus construction
     * time. Addons that define their own {@link PolarisEvent} subclass with a
     * nested {@link EventChannel} must call this once at startup so
     * {@link #get(Class)} can find their channel.
     *
     * <p>Calling {@code register} twice for the same event class replaces
     * the previous channel (any subscribers on the old channel are lost).
     *
     * @param eventClass the event's {@code Class} object
     * @param channel    the addon's channel instance
     */
    <E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>> void register(@NotNull Class<E> eventClass, @NotNull C channel);

    // ───── Reflective annotated-method registration (deprecated) ───────────

    /**
     * @deprecated Prefer {@code bus.get(EventClass.class).onX((...) -> ...)}.
     * Typed subscribes avoid the reflection pass, the per-invocation pooled
     * event instance, and the indirection through {@link PolarisEventListener}.
     * This method is retained for source compatibility with 1.2.4.0 callers;
     * annotated methods are registered as legacy listeners on the matching
     * event's channel.
     */
    @Deprecated
    void registerAnnotatedListeners(@NotNull Object pluginContext, @NotNull Object listener);

    /**
     * @deprecated See {@link #registerAnnotatedListeners(Object, Object)}.
     */
    @Deprecated
    void registerAnnotatedListeners(@NotNull PolarisPlugin plugin, @NotNull Object listener);

    /**
     * @deprecated See {@link #registerAnnotatedListeners(Object, Object)}.
     */
    @Deprecated
    void registerStaticAnnotatedListeners(@NotNull Object pluginContext, @NotNull Class<?> clazz);

    /**
     * @deprecated See {@link #registerAnnotatedListeners(Object, Object)}.
     */
    @Deprecated
    void registerStaticAnnotatedListeners(@NotNull PolarisPlugin plugin, @NotNull Class<?> clazz);

    /**
     * @deprecated Use the handle returned from the channel's
     * {@code onX(...)} subscribe to unsubscribe, or cache the handler lambda
     * and call {@code channel.unsubscribe(lambda)}.
     */
    @Deprecated
    void unregisterListeners(@NotNull Object pluginContext, @NotNull Object listener);

    /**
     * @deprecated See {@link #unregisterListeners(Object, Object)}.
     */
    @Deprecated
    void unregisterListeners(@NotNull PolarisPlugin plugin, @NotNull Object listener);

    /**
     * @deprecated See {@link #unregisterListeners(Object, Object)}.
     */
    @Deprecated
    void unregisterStaticListeners(@NotNull Object pluginContext, @NotNull Class<?> clazz);

    /**
     * @deprecated See {@link #unregisterListeners(Object, Object)}.
     */
    @Deprecated
    void unregisterStaticListeners(@NotNull PolarisPlugin plugin, @NotNull Class<?> clazz);

    /**
     * Unregisters every subscriber — typed OR legacy — bound to the given
     * plugin context. Called automatically by PolarisAC on plugin disable; plugin
     * authors shouldn't normally need this.
     */
    void unregisterAllListeners(@NotNull Object pluginContext);

    /**
     * See {@link #unregisterAllListeners(Object)}.
     */
    void unregisterAllListeners(@NotNull PolarisPlugin plugin);

    /**
     * @deprecated See {@link #unregisterListeners(Object, Object)}.
     */
    @Deprecated
    void unregisterListener(@NotNull Object pluginContext, @NotNull PolarisEventListener<?> listener);

    /**
     * @deprecated See {@link #unregisterListener(Object, PolarisEventListener)}.
     */
    @Deprecated
    void unregisterListener(@NotNull PolarisPlugin plugin, @NotNull PolarisEventListener<?> listener);

    // ───── Class-keyed post + subscribe (deprecated) ───────────────────────

    /**
     * Posts a {@link PolarisEvent} through the bus. Invokes both legacy-registered
     * listeners (via {@link PolarisEventListener#handle(PolarisEvent)}) and typed
     * handlers (by unpacking the event's fields into the Handler's positional
     * params) in ascending priority order — lower-priority subscribers fire
     * first, higher-priority subscribers get the final say on cancellation.
     * This is the Bukkit / Paper convention and a direction flip relative to
     * pre-1.3 Polaris, which sorted highest-first. Callers that set explicit
     * priority numbers should re-evaluate them when moving from 1.2.x to 1.3+.
     *
     * @deprecated Internal Polaris firings should use the channel's typed
     * {@code fire(...)} directly — it avoids the caller-side event instance
     * allocation. This method is retained for source compatibility with
     * 1.2.4.0 callers that build event instances themselves.
     */
    @ApiStatus.Internal
    @Deprecated
    void post(@NotNull PolarisEvent<?> event);

    /**
     * @deprecated Prefer {@code bus.get(EventClass.class).onX(...)} — it
     * subscribes a typed handler directly, avoiding the per-dispatch pooled
     * event instance and the class-keyed lookup on every {@code post(...)}.
     */
    @Deprecated
    <T extends PolarisEvent<?>> void subscribe(@NotNull Object pluginContext, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled, @NotNull Class<?> declaringClass);

    /**
     * @deprecated See {@link #subscribe(Object, Class, PolarisEventListener, int, boolean, Class)}.
     */
    @Deprecated
    <T extends PolarisEvent<?>> void subscribe(@NotNull PolarisPlugin plugin, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled, @NotNull Class<?> declaringClass);

    /**
     * @deprecated See {@link #subscribe(Object, Class, PolarisEventListener, int, boolean, Class)}.
     */
    @Deprecated
    default <T extends PolarisEvent<?>> void subscribe(@NotNull Object pluginContext, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled) {
        subscribe(pluginContext, eventType, listener, priority, ignoreCancelled, listener.getClass());
    }

    /**
     * @deprecated See {@link #subscribe(Object, Class, PolarisEventListener, int, boolean, Class)}.
     */
    @Deprecated
    default <T extends PolarisEvent<?>> void subscribe(@NotNull PolarisPlugin plugin, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled) {
        subscribe(plugin, eventType, listener, priority, ignoreCancelled, listener.getClass());
    }

    /**
     * @deprecated See {@link #subscribe(Object, Class, PolarisEventListener, int, boolean, Class)}.
     */
    @Deprecated
    default <T extends PolarisEvent<?>> void subscribe(@NotNull Object pluginContext, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener) {
        subscribe(pluginContext, eventType, listener, ListenerPriority.NORMAL, false);
    }

    /**
     * @deprecated See {@link #subscribe(Object, Class, PolarisEventListener, int, boolean, Class)}.
     */
    @Deprecated
    default <T extends PolarisEvent<?>> void subscribe(@NotNull PolarisPlugin plugin, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener) {
        subscribe(plugin, eventType, listener, ListenerPriority.NORMAL, false);
    }
}
