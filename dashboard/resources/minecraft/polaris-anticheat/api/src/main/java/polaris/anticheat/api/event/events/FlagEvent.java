package polaris.anticheat.api.event.events;

import polaris.anticheat.api.AbstractCheck;
import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

public class FlagEvent extends PolarisVerboseCheckEvent<FlagEvent.Channel> {

    /** Pool constructor — fields populated via {@link #init}. */
    public FlagEvent() {
        super();
    }

    public FlagEvent(PolarisUser user, AbstractCheck check, String verbose) {
        super(user, check, verbose);
    }

    public FlagEvent(PolarisUser user, AbstractCheck check, Supplier<String> verboseSupplier) {
        super(user, check, verboseSupplier);
    }

    @ApiStatus.Internal
    @Override
    public void init(PolarisUser user, AbstractCheck check, String verbose) {
        super.init(user, check, verbose);
    }

    @ApiStatus.Internal
    public void init(PolarisUser user, AbstractCheck check, Supplier<String> verboseSupplier) {
        super.init(user, check, verboseSupplier);
    }

    /**
     * Typed flag handler. Returns the new cancelled state — returning
     * {@code true} cancels, {@code false} leaves uncancelled. The last
     * parameter carries the cancelled state threaded through priority-ordered
     * dispatch; a handler registered with {@code ignoreCancelled = true}
     * still runs when a lower-priority handler already cancelled the event.
     *
     */
    @FunctionalInterface
    public interface Handler {
        boolean onFlag(@NotNull PolarisUser user, @NotNull AbstractCheck check,
                       @NotNull String verbose, boolean currentlyCancelled);
    }

    @FunctionalInterface
    public interface SupplierHandler {
        boolean onFlag(@NotNull PolarisUser user, @NotNull AbstractCheck check,
                       @NotNull Supplier<String> verbose, boolean currentlyCancelled);
    }

    public static final class Channel extends EventChannel<FlagEvent, SupplierHandler> {
        private static final AtomicBoolean STRING_HANDLER_WARNING = new AtomicBoolean();
        private final ThreadLocal<FlagEvent> legacyPool = ThreadLocal.withInitial(FlagEvent::new);

        public Channel() {
            super(FlagEvent.class, SupplierHandler.class);
        }

        public void onFlagSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler) {
            subscribe(handler, ListenerPriority.NORMAL, false, plugin, null);
        }

        public void onFlagSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler, int priority) {
            subscribe(handler, priority, false, plugin, null);
        }

        public void onFlagSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler, int priority, boolean ignoreCancelled) {
            subscribe(handler, priority, ignoreCancelled, plugin, null);
        }

        /**
         * @deprecated Prefer {@link #onFlagSupplier(PolarisPlugin, SupplierHandler)}.
         */
        @Deprecated
        public void onFlag(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            warnStringHandler(plugin);
            onFlagSupplier(plugin, adapt(handler));
        }

        /**
         * @deprecated Prefer {@link #onFlagSupplier(PolarisPlugin, SupplierHandler, int)}.
         */
        @Deprecated
        public void onFlag(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            warnStringHandler(plugin);
            onFlagSupplier(plugin, adapt(handler), priority);
        }

        /**
         * @deprecated Prefer {@link #onFlagSupplier(PolarisPlugin, SupplierHandler, int, boolean)}.
         */
        @Deprecated
        public void onFlag(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            warnStringHandler(plugin);
            onFlagSupplier(plugin, adapt(handler), priority, ignoreCancelled);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onFlagSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler) {
            onFlagSupplier(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onFlagSupplier(Object, SupplierHandler)}. */
        @Deprecated
        public void onFlagSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler, int priority) {
            onFlagSupplier(resolvePlugin(pluginContext), handler, priority);
        }

        /** @deprecated see {@link #onFlagSupplier(Object, SupplierHandler)}. */
        @Deprecated
        public void onFlagSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler, int priority, boolean ignoreCancelled) {
            onFlagSupplier(resolvePlugin(pluginContext), handler, priority, ignoreCancelled);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onFlag(@NotNull Object pluginContext, @NotNull Handler handler) {
            onFlag(resolvePlugin(pluginContext), handler);
        }

        /** @deprecated see {@link #onFlag(Object, Handler)}. */
        @Deprecated
        public void onFlag(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            onFlag(resolvePlugin(pluginContext), handler, priority);
        }

        /** @deprecated see {@link #onFlag(Object, Handler)}. */
        @Deprecated
        public void onFlag(@NotNull Object pluginContext, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            onFlag(resolvePlugin(pluginContext), handler, priority, ignoreCancelled);
        }

        /** Dispatches the event. Returns the final cancelled state after all handlers run. */
        public boolean fire(@NotNull PolarisUser user, @NotNull AbstractCheck check, @NotNull String verbose) {
            return fire(user, check, VerboseSuppliers.constant(verbose));
        }

        /** Dispatches the event. Returns the final cancelled state after all handlers run. */
        public boolean fire(@NotNull PolarisUser user, @NotNull AbstractCheck check, @NotNull Supplier<String> verboseSupplier) {
            Entry<SupplierHandler>[] entries = entries();
            if (entries.length == 0) return false;

            Supplier<String> verbose = VerboseSuppliers.memoize(verboseSupplier);
            boolean cancelled = false;
            if (!hasLegacy()) {
                for (Entry<SupplierHandler> e : entries) {
                    if (cancelled && !e.ignoreCancelled) continue;
                    try {
                        cancelled = e.handler.onFlag(user, check, verbose, cancelled);
                    } catch (Throwable t) {
                        t.printStackTrace();
                    }
                }
                return cancelled;
            }

            FlagEvent pooled = legacyPool.get();
            pooled.init(user, check, verbose);
            for (Entry<SupplierHandler> e : entries) {
                if (cancelled && !e.ignoreCancelled) continue;
                try {
                    if (e.legacyListener != null) {
                        pooled.setCancelled(cancelled);
                        e.<FlagEvent>legacyListenerAs().handle(pooled);
                        cancelled = pooled.isCancelled();
                    } else {
                        cancelled = e.handler.onFlag(user, check, verbose, cancelled);
                    }
                } catch (Throwable t) {
                    t.printStackTrace();
                }
            }
            return cancelled;
        }

        @Override
        protected boolean dispatchTypedFromLegacy(@NotNull FlagEvent event, @NotNull SupplierHandler handler, boolean cancelled) {
            return handler.onFlag(event.getUser(), event.getCheck(), event.verboseSupplier(), cancelled);
        }

        /** Bridge from {@link PolarisCheckEvent.Handler} — used by the abstract channel when a check-level subscriber registers. */
        @ApiStatus.Internal
        public static @NotNull SupplierHandler bridgeFromCheck(@NotNull PolarisCheckEvent.Handler abstractHandler) {
            return (user, check, verbose, cancelled) -> abstractHandler.onCheck(user, check, cancelled);
        }

        /** Bridge from {@link PolarisVerboseCheckEvent.Handler}. */
        @ApiStatus.Internal
        public static @NotNull SupplierHandler bridgeFromVerboseCheck(@NotNull PolarisVerboseCheckEvent.SupplierHandler abstractHandler) {
            return (user, check, verbose, cancelled) -> abstractHandler.onVerboseCheck(user, check, verbose, cancelled);
        }

        /** Bridge from root-level {@link polaris.anticheat.api.event.PolarisEvent.Handler} — observational only, cancelled is passed through unchanged. */
        @ApiStatus.Internal
        public static @NotNull SupplierHandler bridgeFromAny(@NotNull polaris.anticheat.api.event.PolarisEvent.Handler abstractHandler) {
            return (user, check, verbose, cancelled) -> {
                abstractHandler.onAnyEvent(FlagEvent.class, cancelled);
                return cancelled;
            };
        }

        private static @NotNull SupplierHandler adapt(@NotNull Handler handler) {
            return (user, check, verbose, cancelled) -> handler.onFlag(user, check, verbose.get(), cancelled);
        }

        private static void warnStringHandler(@NotNull PolarisPlugin plugin) {
            if (STRING_HANDLER_WARNING.compareAndSet(false, true)) {
                plugin.getLogger().warning("Deprecated Polaris flag string listener registered; use the Supplier<String> verbose handler and call verbose.get() only when text is needed.");
            }
        }
    }
}
