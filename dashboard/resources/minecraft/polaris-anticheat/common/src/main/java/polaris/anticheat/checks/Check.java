package polaris.anticheat.checks;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.api.AbstractCheck;
import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.event.events.FlagEvent;
import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.api.storage.verbose.VerboseBuf;
import polaris.anticheat.api.storage.verbose.VerboseRenderContext;
import polaris.anticheat.internal.storage.verbose.VerboseRegistry;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.ModdedContent;
import lombok.Getter;
import lombok.Setter;
import org.checkerframework.checker.nullness.qual.MonotonicNonNull;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Objects;
import java.util.function.Supplier;

// Class from https://github.com/Tecnio/AntiCheatBase/blob/master/src/main/java/me/tecnio/anticheat/check/Check.java
@Getter
public class Check extends PolarisProcessor implements AbstractCheck {
    private static final FlagEvent.Channel FLAG_CHANNEL = PolarisAPI.INSTANCE.getEventBus().get(FlagEvent.class);
    private static final ThreadLocal<VerboseBuf> VERBOSE = ThreadLocal.withInitial(VerboseBuf::new);

    // violations
    public double violations;
    private long lastViolationTime;
    private boolean lastFlagStoredBinaryVerbose;
    private final VerboseBuf verbose = VERBOSE.get();

    // check data
    private final @Nullable String checkName;
    private final @Nullable String configName;
    private final @Nullable String alternativeName;
    private final @NotNull String stableKey;
    private final boolean experimental;
    private final @NotNull String defaultDescription;
    private final double defaultDecay;
    private final double defaultSetbackVL;

    // configurable
    private @MonotonicNonNull String displayName;
    private @MonotonicNonNull String description;
    private double decay;
    private double setbackVL;
    @Setter private boolean isEnabled;

    // permissions
    private boolean exemptPermission;
    private boolean noSetbackPermission;
    private boolean noModifyPacketPermission;

    public Check(final @NotNull PolarisPlayer player) {
        super(player, false);

        final CheckData checkData = this.getClass().getAnnotation(CheckData.class);
        if (checkData != null) {
            this.checkName = checkData.name();
            this.configName = checkData.configName().equals("DEFAULT")
                    ? this.checkName
                    : checkData.configName();
            this.defaultDecay = checkData.decay();
            this.defaultSetbackVL = checkData.setback();
            this.alternativeName = checkData.alternativeName();
            this.experimental = checkData.experimental();
            this.defaultDescription = checkData.description();
            this.stableKey = checkData.stableKey();
            this.displayName = this.checkName;
        } else {
            this.defaultDescription = CheckData.DEFAULT_DESCRIPTION;
            this.defaultDecay = CheckData.DEFAULT_DECAY;
            this.defaultSetbackVL = CheckData.DEFAULT_SETBACK;
            this.stableKey = "";
            this.alternativeName = null;
            this.checkName = null;
            this.configName = null;
            this.experimental = false;
        }

        reload();
    }

    public boolean shouldModifyPackets() {
        // A modded server: the simulation knows its blocks, tools and items only
        // through vanilla stand-ins, so a check acting on them cancelled honest
        // players' digging and placing (cobblestone took "ten seconds" to break and
        // never did). There the checks flag and leave the packets alone, as the
        // setbacks do (SetbackTeleportUtil).
        return isEnabled
                && !ModdedContent.isModdedServer()
                && !player.disablePolaris
                && !player.noModifyPacketPermission
                && !noModifyPacketPermission
                && !exemptPermission;
    }

    /**
     * Evaluated once when CheckManager builds the dispatch arrays.
     * Implementations must only depend on immutable connection properties.
     */
    public boolean isApplicable() {
        return true;
    }

    public final void updatePermissions() {
        if (getConfigName() == null) return;
        final String id = getConfigName().toLowerCase();
        exemptPermission = player.hasPermission("polarisac.exempt." + id);
        noSetbackPermission = player.hasPermission("polarisac.nosetback." + id);
        noModifyPacketPermission = player.hasPermission("polarisac.nomodifypacket." + id);
    }

    public final boolean flag() {
        return flag("");
    }

    public final boolean flag(String verbose) {
        Supplier<String> alertText = constant(verbose);
        if (recordFlag(alertText)) {
            alert(alertText);
            return true;
        }
        return false;
    }

    public final boolean flag(@NotNull Verbose.Writer verbose) {
        BinaryVerbose binary = lazyVerbose(verbose);
        if (recordFlag(binary)) {
            alert(binary.rendered());
            return true;
        }
        return false;
    }

    public final boolean flag(@NotNull Verbose.Writer verbose, @NotNull Supplier<String> alertText) {
        BinaryVerbose binary = lazyVerbose(verbose);
        if (recordFlag(binary)) {
            alert(memoize(Objects.requireNonNull(alertText, "alertText")));
            return true;
        }
        return false;
    }

    private boolean recordFlag(@NotNull Supplier<String> verbose) {
        if (player.disablePolaris || (experimental && !player.isExperimentalChecks()) || exemptPermission)
            return false; // Avoid calling event if disabled

        if (FLAG_CHANNEL.fire(player, this, verbose)) return false;

        lastFlagStoredBinaryVerbose = false;
        player.punishmentManager.handleViolation(this);
        lastViolationTime = System.currentTimeMillis();
        violations++;
        return true;
    }

    private boolean recordFlag(@NotNull BinaryVerbose verbose) {
        Supplier<String> rendered = verbose.rendered();
        byte[] verboseData = verbose.data();

        if (player.disablePolaris || (experimental && !player.isExperimentalChecks()) || exemptPermission)
            return false; // Avoid calling event if disabled

        if (FLAG_CHANNEL.fire(player, this, rendered)) return false;

        lastFlagStoredBinaryVerbose = true;
        player.punishmentManager.handleViolation(this);
        lastViolationTime = System.currentTimeMillis();
        violations++;
        PolarisAPI.INSTANCE.getDataStoreLifecycle().liveWriteHooks()
                .recordFlagDataFromCheck(player, this, violations, verboseData);
        return true;
    }

    private @NotNull BinaryVerbose lazyVerbose(@NotNull Verbose.Writer writer) {
        Objects.requireNonNull(writer, "writer");
        byte[] verboseData = writer.end().toByteArray();
        Verbose template = writer.verbose();
        Supplier<String> rendered = memoize(() -> template.render(verboseData, new VerboseRenderContext(
                player.getClientVersion().getProtocolVersion(),
                PolarisAPI.INSTANCE.getPlatformServer().getPlatformImplementationString())));
        return new BinaryVerbose(verboseData, rendered);
    }

    public final void registerVerboseTemplates(@Nullable VerboseRegistry registry) {
        if (registry == null || stableKey.isEmpty()) return;
        String pluginVersion = PolarisAPI.INSTANCE.getExternalAPI().getPolarisVersion();
        for (Verbose template : Verbose.declaredBy(getClass(), Check.class)) {
            registry.registerTemplate(stableKey, checkName, description, pluginVersion, template);
        }
    }

    protected final @NotNull VerboseBuf verbose() {
        return verbose;
    }

    public final boolean flagWithSetback() {
        return flagWithSetback("");
    }

    public final boolean flagWithSetback(String verbose) {
        if (flag(verbose)) {
            setbackIfAboveSetbackVL();
            return true;
        }
        return false;
    }

    public final boolean flagWithSetback(@NotNull Verbose.Writer verbose) {
        if (flag(verbose)) {
            setbackIfAboveSetbackVL();
            return true;
        }
        return false;
    }

    public final boolean flagWithSetback(@NotNull Verbose.Writer verbose, @NotNull Supplier<String> alertText) {
        if (flag(verbose, alertText)) {
            setbackIfAboveSetbackVL();
            return true;
        }
        return false;
    }

    public final void reward() {
        violations = Math.max(0, violations - decay);
    }

    @Override
    public final void reload(@NotNull ConfigManager configuration) {
        if (getConfigName() != null) {
            decay = configuration.getDoubleElse(getConfigName() + ".decay", defaultDecay);
            setbackVL = configuration.getDoubleElse(getConfigName() + ".setbackvl", defaultSetbackVL);
            displayName = configuration.getStringElse(getConfigName() + ".displayname", checkName);
            description = configuration.getStringElse(getConfigName() + ".description", defaultDescription);

            if (setbackVL == -1) setbackVL = Double.MAX_VALUE;
        }
        super.reload(configuration);
    }

    public boolean alert(String verbose) {
        return alert(constant(verbose));
    }

    public boolean alert(@NotNull Supplier<String> verbose) {
        return player.punishmentManager.handleAlert(player, memoize(Objects.requireNonNull(verbose, "verbose")), this);
    }

    public boolean setbackIfAboveSetbackVL() {
        if (shouldSetback()) {
            return player.getSetbackTeleportUtil().executeViolationSetback();
        }
        return false;
    }

    public boolean shouldSetback() {
        return !noSetbackPermission && violations > setbackVL;
    }

    public boolean executeViolationSetback() {
        return !noSetbackPermission && player.getSetbackTeleportUtil().executeViolationSetback();
    }

    public String formatOffset(double offset) {
        return offset > 0.001 ? String.format("%.5f", offset) : String.format("%.2E", offset);
    }

    private static @NotNull Supplier<String> constant(String verbose) {
        String value = verbose == null ? "" : verbose;
        return () -> value;
    }

    private static @NotNull Supplier<String> memoize(@NotNull Supplier<String> supplier) {
        return new Supplier<>() {
            private String value;
            private boolean computed;

            @Override
            public synchronized String get() {
                if (!computed) {
                    try {
                        value = supplier.get();
                        if (value == null) value = "";
                    } catch (RuntimeException ignored) {
                        value = "";
                    }
                    computed = true;
                }
                return value;
            }
        };
    }

    private record BinaryVerbose(byte @NotNull [] data, @NotNull Supplier<String> rendered) {}
}
