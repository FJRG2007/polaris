package polaris.anticheat.api.event.events;

import polaris.anticheat.api.AbstractCheck;
import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.event.AbstractEventChannel;
import polaris.anticheat.api.event.EventChannel;
import polaris.anticheat.api.event.ListenerPriority;
import polaris.anticheat.api.plugin.PolarisPlugin;
import org.jetbrains.annotations.ApiStatus;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

public abstract class PolarisVerboseCheckEvent<CHANNEL extends EventChannel<?, ?>>
        extends PolarisCheckEvent<CHANNEL> {
    private Supplier<String> verboseSupplier = () -> "";

    /** Pool constructor — fields populated via {@link #init(PolarisUser, AbstractCheck, String)}. */
    protected PolarisVerboseCheckEvent() {
        super();
    }

    public PolarisVerboseCheckEvent(PolarisUser user, AbstractCheck check, String verbose) {
        super(user, check);
        setVerboseSupplier(VerboseSuppliers.constant(verbose));
    }

    public PolarisVerboseCheckEvent(PolarisUser user, AbstractCheck check, Supplier<String> verboseSupplier) {
        super(user, check);
        setVerboseSupplier(verboseSupplier);
    }

    @ApiStatus.Internal
    protected void init(PolarisUser user, AbstractCheck check, String verbose) {
        init(user, check, VerboseSuppliers.constant(verbose));
    }

    @ApiStatus.Internal
    protected void init(PolarisUser user, AbstractCheck check, Supplier<String> verboseSupplier) {
        super.init(user, check);
        setVerboseSupplier(verboseSupplier);
    }

    /** Returns the human verbose string, rendering it lazily on first use. */
    public @NotNull String getVerbose() {
        return verboseSupplier.get();
    }

    @ApiStatus.Internal
    final @NotNull Supplier<String> verboseSupplier() {
        return verboseSupplier;
    }

    private void setVerboseSupplier(Supplier<String> verboseSupplier) {
        this.verboseSupplier = VerboseSuppliers.memoize(verboseSupplier);
    }

    /**
     * Abstract-level verbose-check handler. Fires for every concrete
     * {@code PolarisVerboseCheckEvent} subtype — FlagEvent and
     * CommandExecuteEvent out of the box, plus any addon subtypes that
     * opt into bridging. Does not fire for
     * {@link CompletePredictionEvent}, which extends {@link PolarisCheckEvent}
     * directly and has no verbose field.
     */
    @FunctionalInterface
    public interface Handler {
        boolean onVerboseCheck(@NotNull PolarisUser user, @NotNull AbstractCheck check,
                               @NotNull String verbose, boolean currentlyCancelled);
    }

    @FunctionalInterface
    public interface SupplierHandler {
        boolean onVerboseCheck(@NotNull PolarisUser user, @NotNull AbstractCheck check,
                               @NotNull Supplier<String> verbose, boolean currentlyCancelled);
    }

    public static final class Channel extends AbstractEventChannel<PolarisVerboseCheckEvent<?>, SupplierHandler> {
        private static final AtomicBoolean STRING_HANDLER_WARNING = new AtomicBoolean();

        @SuppressWarnings({"unchecked", "rawtypes"})
        public Channel() {
            super((Class<PolarisVerboseCheckEvent<?>>) (Class) PolarisVerboseCheckEvent.class, SupplierHandler.class);
        }

        public void onVerboseCheckSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler) {
            subscribeAbstract(handler, ListenerPriority.NORMAL, false, plugin);
        }

        public void onVerboseCheckSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler, int priority) {
            subscribeAbstract(handler, priority, false, plugin);
        }

        public void onVerboseCheckSupplier(@NotNull PolarisPlugin plugin, @NotNull SupplierHandler handler, int priority, boolean ignoreCancelled) {
            subscribeAbstract(handler, priority, ignoreCancelled, plugin);
        }

        /**
         * @deprecated Prefer {@link #onVerboseCheckSupplier(PolarisPlugin, SupplierHandler)}.
         */
        @Deprecated
        public void onVerboseCheck(@NotNull PolarisPlugin plugin, @NotNull Handler handler) {
            warnStringHandler(plugin);
            onVerboseCheckSupplier(plugin, adapt(handler));
        }

        /**
         * @deprecated Prefer {@link #onVerboseCheckSupplier(PolarisPlugin, SupplierHandler, int)}.
         */
        @Deprecated
        public void onVerboseCheck(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority) {
            warnStringHandler(plugin);
            onVerboseCheckSupplier(plugin, adapt(handler), priority);
        }

        /**
         * @deprecated Prefer {@link #onVerboseCheckSupplier(PolarisPlugin, SupplierHandler, int, boolean)}.
         */
        @Deprecated
        public void onVerboseCheck(@NotNull PolarisPlugin plugin, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            warnStringHandler(plugin);
            onVerboseCheckSupplier(plugin, adapt(handler), priority, ignoreCancelled);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onVerboseCheckSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler) {
            subscribeAbstractResolving(pluginContext, handler, ListenerPriority.NORMAL, false);
        }

        /** @deprecated see {@link #onVerboseCheckSupplier(Object, SupplierHandler)}. */
        @Deprecated
        public void onVerboseCheckSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler, int priority) {
            subscribeAbstractResolving(pluginContext, handler, priority, false);
        }

        /** @deprecated see {@link #onVerboseCheckSupplier(Object, SupplierHandler)}. */
        @Deprecated
        public void onVerboseCheckSupplier(@NotNull Object pluginContext, @NotNull SupplierHandler handler, int priority, boolean ignoreCancelled) {
            subscribeAbstractResolving(pluginContext, handler, priority, ignoreCancelled);
        }

        /** @deprecated resolve your context once at plugin enable — {@code api.getPolarisPlugin(this)} — and call the {@link PolarisPlugin}-taking overload. */
        @Deprecated
        public void onVerboseCheck(@NotNull Object pluginContext, @NotNull Handler handler) {
            PolarisPlugin plugin = resolvePlugin(pluginContext);
            onVerboseCheck(plugin, handler);
        }

        /** @deprecated see {@link #onVerboseCheck(Object, Handler)}. */
        @Deprecated
        public void onVerboseCheck(@NotNull Object pluginContext, @NotNull Handler handler, int priority) {
            PolarisPlugin plugin = resolvePlugin(pluginContext);
            onVerboseCheck(plugin, handler, priority);
        }

        /** @deprecated see {@link #onVerboseCheck(Object, Handler)}. */
        @Deprecated
        public void onVerboseCheck(@NotNull Object pluginContext, @NotNull Handler handler, int priority, boolean ignoreCancelled) {
            PolarisPlugin plugin = resolvePlugin(pluginContext);
            onVerboseCheck(plugin, handler, priority, ignoreCancelled);
        }

        private static @NotNull SupplierHandler adapt(@NotNull Handler handler) {
            return (user, check, verbose, cancelled) -> handler.onVerboseCheck(user, check, verbose.get(), cancelled);
        }

        private static void warnStringHandler(@NotNull PolarisPlugin plugin) {
            if (STRING_HANDLER_WARNING.compareAndSet(false, true)) {
                plugin.getLogger().warning("Deprecated Polaris verbose string listener registered; use the Supplier<String> verbose handler and call verbose.get() only when text is needed.");
            }
        }
    }
}
