package polaris.anticheat.internal.event;

import polaris.anticheat.api.event.EventBus;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.PolarisEvent;
import polaris.anticheat.api.event.PolarisEventHandler;
import polaris.anticheat.api.event.PolarisEventListener;
import polaris.anticheat.api.event.events.CommandExecuteEvent;
import polaris.anticheat.api.event.events.CompletePredictionEvent;
import polaris.anticheat.api.event.events.FlagEvent;
import polaris.anticheat.api.event.events.PolarisCheckEvent;
import polaris.anticheat.api.event.events.PolarisJoinEvent;
import polaris.anticheat.api.event.events.PolarisPlayerSetbackEvent;
import polaris.anticheat.api.event.events.PolarisQuitEvent;
import polaris.anticheat.api.event.events.PolarisReloadEvent;
import polaris.anticheat.api.event.events.PolarisSetbackEvent;
import polaris.anticheat.api.event.events.PolarisTeleportEvent;
import polaris.anticheat.api.event.events.PolarisTransactionReceivedEvent;
import polaris.anticheat.api.event.events.PolarisTransactionSendEvent;
import polaris.anticheat.api.event.events.PolarisVehicleSetbackEvent;
import polaris.anticheat.api.event.events.PolarisVerboseCheckEvent;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.internal.plugin.resolver.PolarisExtensionManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Channel-backed event bus implementation.
 *
 * <p>All Polaris built-in channels are registered explicitly at construction
 * time — no reflection, obfuscation-safe. Addons with their own events can
 * register via {@link #register(Class, EventChannel)}.
 *
 * <p>Legacy APIs ({@link #post(PolarisEvent)}, class-keyed {@code subscribe},
 * reflective {@code registerAnnotatedListeners}) are retained for source
 * compatibility with 1.2.4.0 callers. All three route through the same
 * channel objects as {@link #get(Class)} + the channel's typed
 * {@code on…(…)} methods — a single post therefore reaches typed handlers
 * as well as legacy listeners via each channel's
 * {@link EventChannel#dispatchLegacy(PolarisEvent)}.
 */
public class OptimizedEventBus implements EventBus {
    private final MethodHandles.Lookup lookup = MethodHandles.lookup();
    private final PolarisExtensionManager extensionManager;
    private final ConcurrentMap<Class<?>, EventChannel<?, ?>> channels = new ConcurrentHashMap<>();

    /**
     * Side map of reflective/class-keyed registrations keyed by identity of
     * (pluginContext, listenerInstanceOrClass). Used by
     * {@link #unregisterListeners(Object, Object)} and friends to find the
     * specific entries to remove — Entry itself doesn't carry the originating
     * listener instance. Modifications are guarded by {@code this}.
     */
    private final Map<Object, Map<Object, List<Registration>>> instanceRegistrations = new IdentityHashMap<>();

    @SuppressWarnings({"unchecked", "rawtypes"})
    public OptimizedEventBus(PolarisExtensionManager extensionManager) {
        this.extensionManager = extensionManager;
        // Built-in channels — direct compile-time references.
        // Renaming any event's nested Channel breaks these lines immediately.

        // Concrete channels.
        FlagEvent.Channel flagCh                           = new FlagEvent.Channel();
        CommandExecuteEvent.Channel commandCh              = new CommandExecuteEvent.Channel();
        CompletePredictionEvent.Channel completeCh         = new CompletePredictionEvent.Channel();
        PolarisJoinEvent.Channel joinCh                       = new PolarisJoinEvent.Channel();
        PolarisQuitEvent.Channel quitCh                       = new PolarisQuitEvent.Channel();
        PolarisReloadEvent.Channel reloadCh                   = new PolarisReloadEvent.Channel();
        PolarisTeleportEvent.Channel teleportCh               = new PolarisTeleportEvent.Channel();
        PolarisTransactionSendEvent.Channel txSendCh          = new PolarisTransactionSendEvent.Channel();
        PolarisTransactionReceivedEvent.Channel txRecvCh      = new PolarisTransactionReceivedEvent.Channel();
        PolarisPlayerSetbackEvent.Channel playerSetbackCh     = new PolarisPlayerSetbackEvent.Channel();
        PolarisVehicleSetbackEvent.Channel vehicleSetbackCh   = new PolarisVehicleSetbackEvent.Channel();
        installChannel(FlagEvent.class,                    flagCh);
        installChannel(CommandExecuteEvent.class,          commandCh);
        installChannel(CompletePredictionEvent.class,      completeCh);
        installChannel(PolarisJoinEvent.class,                joinCh);
        installChannel(PolarisQuitEvent.class,                quitCh);
        installChannel(PolarisReloadEvent.class,              reloadCh);
        installChannel(PolarisTeleportEvent.class,            teleportCh);
        installChannel(PolarisTransactionSendEvent.class,     txSendCh);
        installChannel(PolarisTransactionReceivedEvent.class, txRecvCh);
        installChannel(PolarisPlayerSetbackEvent.class,       playerSetbackCh);
        installChannel(PolarisVehicleSetbackEvent.class,      vehicleSetbackCh);

        // Abstract channels. Their Class<PolarisCheckEvent<?>> keys are raw-cast
        // because PolarisCheckEvent's CHANNEL type parameter is erased at .class.
        PolarisEvent.Channel anyCh                            = new PolarisEvent.Channel();
        PolarisCheckEvent.Channel checkCh                     = new PolarisCheckEvent.Channel();
        PolarisVerboseCheckEvent.Channel verboseCheckCh       = new PolarisVerboseCheckEvent.Channel();
        PolarisSetbackEvent.Channel setbackCh                 = new PolarisSetbackEvent.Channel();
        installAbstractChannel(PolarisEvent.class,             anyCh);
        installAbstractChannel(PolarisCheckEvent.class,        checkCh);
        installAbstractChannel(PolarisVerboseCheckEvent.class, verboseCheckCh);
        installAbstractChannel(PolarisSetbackEvent.class,      setbackCh);

        // Bridge wiring: every concrete subtype registers with every abstract
        // parent it can bridge to. Order matters only when abstract subscribes
        // land before registerSubtype — in that case registerSubtype walks the
        // subscriber list. We wire after installing both channels, so at
        // construction time the subscriber list is empty and the install is
        // just bookkeeping.
        checkCh.registerSubtype(FlagEvent.class,                flagCh,     FlagEvent.Channel::bridgeFromCheck);
        checkCh.registerSubtype(CommandExecuteEvent.class,      commandCh,  CommandExecuteEvent.Channel::bridgeFromCheck);
        checkCh.registerSubtype(CompletePredictionEvent.class,  completeCh, CompletePredictionEvent.Channel::bridgeFromCheck);

        verboseCheckCh.registerSubtype(FlagEvent.class,            flagCh,    FlagEvent.Channel::bridgeFromVerboseCheck);
        verboseCheckCh.registerSubtype(CommandExecuteEvent.class,  commandCh, CommandExecuteEvent.Channel::bridgeFromVerboseCheck);

        setbackCh.registerSubtype(PolarisPlayerSetbackEvent.class,   playerSetbackCh,  PolarisPlayerSetbackEvent.Channel::bridgeFromSetback);
        setbackCh.registerSubtype(PolarisVehicleSetbackEvent.class,  vehicleSetbackCh, PolarisVehicleSetbackEvent.Channel::bridgeFromSetback);

        anyCh.registerSubtype(FlagEvent.class,                    flagCh,           FlagEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(CommandExecuteEvent.class,          commandCh,        CommandExecuteEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(CompletePredictionEvent.class,      completeCh,       CompletePredictionEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisJoinEvent.class,                joinCh,           PolarisJoinEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisQuitEvent.class,                quitCh,           PolarisQuitEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisReloadEvent.class,              reloadCh,         PolarisReloadEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisTeleportEvent.class,            teleportCh,       PolarisTeleportEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisTransactionSendEvent.class,     txSendCh,         PolarisTransactionSendEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisTransactionReceivedEvent.class, txRecvCh,         PolarisTransactionReceivedEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisPlayerSetbackEvent.class,       playerSetbackCh,  PolarisPlayerSetbackEvent.Channel::bridgeFromAny);
        anyCh.registerSubtype(PolarisVehicleSetbackEvent.class,      vehicleSetbackCh, PolarisVehicleSetbackEvent.Channel::bridgeFromAny);
    }

    private <E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>> void installChannel(Class<E> eventClass, C channel) {
        channel.setPluginResolver(extensionManager::getPlugin);
        channels.put(eventClass, channel);
    }

    /**
     * Abstract-channel variant of {@link #installChannel}. Abstract events
     * (PolarisEvent, PolarisCheckEvent, PolarisVerboseCheckEvent) are generic on
     * {@code CHANNEL}, which makes the tight
     * {@code E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>}
     * constraint unsolvable when you pass the raw parent class with a
     * concrete abstract-channel. Loosen the E binding here; the abstract
     * channels are exhaustively listed in the constructor, so the looser
     * type safety is contained.
     */
    private <E, C extends EventChannel<?, ?>> void installAbstractChannel(Class<E> eventClass, C channel) {
        channel.setPluginResolver(extensionManager::getPlugin);
        channels.put(eventClass, channel);
    }

    // ───── Typed channel API ───────────────────────────────────────────────

    @Override
    @SuppressWarnings("unchecked")
    public <E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>> @NotNull C get(@NotNull Class<E> eventClass) {
        EventChannel<?, ?> ch = channels.get(eventClass);
        if (ch == null) {
            throw new IllegalArgumentException("No EventChannel registered for " + eventClass.getName()
                    + " — addons must call EventBus.register(Class, Channel) before first use.");
        }
        return (C) ch;
    }

    @Override
    public <E extends PolarisEvent<C>, C extends EventChannel<? extends E, ?>> void register(@NotNull Class<E> eventClass, @NotNull C channel) {
        channel.setPluginResolver(extensionManager::getPlugin);
        channels.put(eventClass, channel);
    }

    // ───── Reflective annotated-method registration ────────────────────────

    @Override
    public void registerAnnotatedListeners(@NotNull Object pluginContext, @NotNull Object listener) {
        PolarisPlugin plugin = extensionManager.getPlugin(pluginContext);
        registerAnnotatedListeners(plugin, listener);
    }

    @Override
    public void registerAnnotatedListeners(@NotNull PolarisPlugin plugin, @NotNull Object listener) {
        registerMethods(plugin, listener, listener.getClass(), listener);
    }

    @Override
    public void registerStaticAnnotatedListeners(@NotNull Object pluginContext, @NotNull Class<?> clazz) {
        PolarisPlugin plugin = extensionManager.getPlugin(pluginContext);
        registerStaticAnnotatedListeners(plugin, clazz);
    }

    @Override
    public void registerStaticAnnotatedListeners(@NotNull PolarisPlugin plugin, @NotNull Class<?> clazz) {
        registerMethods(plugin, null, clazz, clazz);
    }

    private void registerMethods(@NotNull PolarisPlugin plugin, @Nullable Object instance, @NotNull Class<?> clazz, @NotNull Object registrationKey) {
        for (Method method : clazz.getDeclaredMethods()) {
            PolarisEventHandler annotation = method.getAnnotation(PolarisEventHandler.class);
            if (annotation == null || method.getParameterCount() != 1) continue;
            Class<?> paramType = method.getParameterTypes()[0];
            if (!PolarisEvent.class.isAssignableFrom(paramType)) continue;
            if (instance == null && !Modifier.isStatic(method.getModifiers())) continue;

            @SuppressWarnings("unchecked")
            Class<? extends PolarisEvent<?>> eventClass = (Class<? extends PolarisEvent<?>>) (Class<?>) paramType;
            EventChannel<?, ?> channel = channels.get(eventClass);
            if (channel == null) continue; // no channel for this event — ignore silently (matches old behavior)

            try {
                method.setAccessible(true);
                MethodHandle handle = lookup.unreflect(method);
                PolarisEventListener<PolarisEvent<?>> listener = buildListener(instance, handle);
                subscribeLegacyInternal(plugin, channel, eventClass, listener,
                        annotation.priority(), annotation.ignoreCancelled(), method.getDeclaringClass(), registrationKey);
            } catch (IllegalAccessException e) {
                e.printStackTrace();
            }
        }
    }

    /** Wrap a reflected method + instance as a PolarisEventListener. */
    private static PolarisEventListener<PolarisEvent<?>> buildListener(@Nullable Object instance, MethodHandle handle) {
        if (instance != null) {
            return event -> {
                try {
                    handle.invoke(instance, event);
                } catch (Throwable t) {
                    throw new RuntimeException("Failed to invoke listener for " + event.getClass().getName(), t);
                }
            };
        }
        return event -> {
            try {
                handle.invoke(event);
            } catch (Throwable t) {
                throw new RuntimeException("Failed to invoke listener for " + event.getClass().getName(), t);
            }
        };
    }

    // ───── Class-keyed explicit subscribe ──────────────────────────────────

    @Override
    public <T extends PolarisEvent<?>> void subscribe(@NotNull Object pluginContext, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled, @NotNull Class<?> declaringClass) {
        PolarisPlugin plugin = extensionManager.getPlugin(pluginContext);
        subscribe(plugin, eventType, listener, priority, ignoreCancelled, declaringClass);
    }

    @Override
    public <T extends PolarisEvent<?>> void subscribe(@NotNull PolarisPlugin plugin, @NotNull Class<T> eventType, @NotNull PolarisEventListener<T> listener, int priority, boolean ignoreCancelled, @NotNull Class<?> declaringClass) {
        EventChannel<?, ?> channel = channels.get(eventType);
        if (channel == null) {
            throw new IllegalArgumentException("No EventChannel registered for " + eventType.getName());
        }
        subscribeLegacyInternal(plugin, channel, eventType, listener, priority, ignoreCancelled, declaringClass, listener);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private void subscribeLegacyInternal(
            @NotNull PolarisPlugin plugin,
            @NotNull EventChannel<?, ?> channel,
            @NotNull Class<? extends PolarisEvent<?>> eventClass,
            @NotNull PolarisEventListener<?> listener,
            int priority, boolean ignoreCancelled,
            @NotNull Class<?> declaringClass,
            @NotNull Object registrationKey) {
        ((EventChannel) channel).subscribeLegacy(listener, eventClass, priority, ignoreCancelled, plugin, declaringClass);
        synchronized (this) {
            Map<Object, List<Registration>> byPlugin = instanceRegistrations.computeIfAbsent(plugin, p -> new IdentityHashMap<>());
            byPlugin.computeIfAbsent(registrationKey, k -> new ArrayList<>()).add(new Registration(channel, listener));
        }
    }

    // ───── Unregister ──────────────────────────────────────────────────────

    @Override
    public void unregisterListeners(@NotNull Object pluginContext, @NotNull Object listener) {
        unregisterListeners(extensionManager.getPlugin(pluginContext), listener);
    }

    @Override
    public void unregisterListeners(@NotNull PolarisPlugin plugin, @NotNull Object listener) {
        removeInstanceRegistrations(plugin, listener);
    }

    @Override
    public void unregisterStaticListeners(@NotNull Object pluginContext, @NotNull Class<?> clazz) {
        unregisterStaticListeners(extensionManager.getPlugin(pluginContext), clazz);
    }

    @Override
    public void unregisterStaticListeners(@NotNull PolarisPlugin plugin, @NotNull Class<?> clazz) {
        removeInstanceRegistrations(plugin, clazz);
    }

    @Override
    public void unregisterAllListeners(@NotNull Object pluginContext) {
        unregisterAllListeners(extensionManager.getPlugin(pluginContext));
    }

    @Override
    public void unregisterAllListeners(@NotNull PolarisPlugin plugin) {
        List<Registration> all = new ArrayList<>();
        synchronized (this) {
            Map<Object, List<Registration>> byPlugin = instanceRegistrations.remove(plugin);
            if (byPlugin != null) {
                for (List<Registration> regs : byPlugin.values()) all.addAll(regs);
            }
        }
        for (Registration r : all) r.channel.unsubscribeLegacy(r.listener);
        for (EventChannel<?, ?> ch : channels.values()) ch.unsubscribeAllFromPlugin(plugin);
    }

    @Override
    public void unregisterListener(@NotNull Object pluginContext, @NotNull PolarisEventListener<?> listener) {
        unregisterListener(extensionManager.getPlugin(pluginContext), listener);
    }

    @Override
    public void unregisterListener(@NotNull PolarisPlugin plugin, @NotNull PolarisEventListener<?> listener) {
        for (EventChannel<?, ?> ch : channels.values()) ch.unsubscribeLegacy(listener);
        synchronized (this) {
            Map<Object, List<Registration>> byPlugin = instanceRegistrations.get(plugin);
            if (byPlugin != null) {
                for (List<Registration> regs : byPlugin.values()) {
                    regs.removeIf(r -> r.listener == listener);
                }
            }
        }
    }

    private void removeInstanceRegistrations(@NotNull PolarisPlugin plugin, @NotNull Object key) {
        List<Registration> toRemove;
        synchronized (this) {
            Map<Object, List<Registration>> byPlugin = instanceRegistrations.get(plugin);
            if (byPlugin == null) return;
            List<Registration> regs = byPlugin.remove(key);
            if (regs == null) return;
            toRemove = regs;
        }
        for (Registration r : toRemove) r.channel.unsubscribeLegacy(r.listener);
    }

    // ───── Legacy post ─────────────────────────────────────────────────────

    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    public void post(@NotNull PolarisEvent<?> event) {
        // Route to the concrete-class channel. Walks the superclass chain so a
        // hypothetical abstract-event subscriber (via addon-registered channel)
        // still receives the event.
        Class<?> c = event.getClass();
        while (c != null && PolarisEvent.class.isAssignableFrom(c)) {
            EventChannel<?, ?> ch = channels.get(c);
            if (ch != null) {
                ((EventChannel) ch).dispatchLegacy(event);
            }
            c = c.getSuperclass();
        }
    }

    /** Reflective-registration bookkeeping entry. */
    private static final class Registration {
        final EventChannel<?, ?> channel;
        final PolarisEventListener<?> listener;

        Registration(EventChannel<?, ?> channel, PolarisEventListener<?> listener) {
            this.channel = channel;
            this.listener = listener;
        }
    }
}
