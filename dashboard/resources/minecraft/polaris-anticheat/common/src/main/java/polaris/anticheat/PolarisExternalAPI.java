package polaris.anticheat;

import polaris.anticheat.api.PolarisAbstractAPI;
import polaris.anticheat.api.PolarisUser;
import polaris.anticheat.api.alerts.AlertManager;
import polaris.anticheat.api.config.ConfigManager;
import polaris.anticheat.api.event.EventBus;
import polaris.anticheat.api.event.events.PolarisReloadEvent;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.api.storage.backend.BackendRegistry;
import polaris.anticheat.manager.config.ConfigManagerFileImpl;
import polaris.anticheat.manager.init.start.StartableInitable;
import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.anticheat.MessageUtil;
import polaris.anticheat.utils.common.ConfigReloadObserver;
import polaris.anticheat.utils.common.PropertiesUtil;
import lombok.Getter;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

// This is used for polarisac's external API. It has its own class just for organization.
public class PolarisExternalAPI implements PolarisAbstractAPI, ConfigReloadObserver, StartableInitable {

    // Holder class — PolarisExternalAPI is constructed inside PolarisAPI's ctor,
    // so a plain static-final would see a null PolarisAPI.INSTANCE. Holder
    // init runs on first fire, after PolarisAPI is fully built.
    private static final class Channels {
        static final PolarisReloadEvent.Channel RELOAD = PolarisAPI.INSTANCE.getEventBus().get(PolarisReloadEvent.class);
    }

    private final PolarisAPI api;
    @Getter
    private final Map<String, Function<PolarisUser, String>> variableReplacements = new ConcurrentHashMap<>();
    @Getter
    private final Map<String, String> staticReplacements = new ConcurrentHashMap<>();
    private final Map<String, Function<Object, Object>> functions = new ConcurrentHashMap<>();
    private final ConfigManagerFileImpl configManagerFile = new ConfigManagerFileImpl();
    private final String polarisacVersion;
    private ConfigManager configManager = null;
    private boolean started = false;

    public PolarisExternalAPI(PolarisAPI api) {
        this.api = api;
        this.polarisacVersion = resolvePolarisVersion(api);
    }

    @Override
    public @NotNull EventBus getEventBus() {
        return api.getEventBus();
    }

    @Deprecated
    @Override
    public @Nullable PolarisUser getPolarisUser(Player player) {
        return getPolarisUser(player.getUniqueId());
    }

    @Override
    public @Nullable PolarisUser getPolarisUser(UUID uuid) {
        return api.getPlayerDataManager().getPlayer(uuid);
    }

    @Override
    public void registerVariable(String string, Function<PolarisUser, String> replacement) {
        if (replacement == null) {
            variableReplacements.remove(string);
        } else {
            variableReplacements.put(string, replacement);
        }
    }

    @Override
    public void registerVariable(String variable, String replacement) {
        if (replacement == null) {
            staticReplacements.remove(variable);
        } else {
            staticReplacements.put(variable, replacement);
        }
    }

    @Override
    public String getPolarisVersion() {
        return polarisacVersion;
    }

    private static String resolvePolarisVersion(PolarisAPI api) {
        try {
            Properties properties = PropertiesUtil.readProperties(PolarisExternalAPI.class, "polarisac.properties");
            String buildVersion = properties.getProperty("build.version");
            if (buildVersion != null && !buildVersion.isBlank() && !buildVersion.startsWith("${")) {
                return buildVersion;
            }
        } catch (RuntimeException ignored) {
        }

        try {
            return api.getPolarisPlugin().getDescription().getVersion();
        } catch (RuntimeException e) {
            return "unknown";
        }
    }

    @Override
    public void registerFunction(String key, Function<Object, Object> function) {
        if (function == null) {
            functions.remove(key);
        } else {
            functions.put(key, function);
        }
    }

    @Override
    public Function<Object, Object> getFunction(String key) {
        return functions.get(key);
    }

    @Override
    public AlertManager getAlertManager() {
        return PolarisAPI.INSTANCE.getAlertManager();
    }

    @Override
    public ConfigManager getConfigManager() {
        return configManager;
    }

    @Override
    public boolean hasStarted() {
        return started;
    }

    @Override
    public int getCurrentTick() {
        return PolarisAPI.INSTANCE.getTickManager().currentTick;
    }

    @Override
    public @NotNull PolarisPlugin getPolarisPlugin(@NotNull Object o) {
        return this.api.getExtensionManager().getPlugin(o);
    }

    @Override
    public @NotNull BackendRegistry getBackendRegistry() {
        return api.getBackendRegistry();
    }

    // on load, load the config & register the service
    public void load() {
        reload(configManagerFile);
        api.getLoader().registerAPIService();
    }

    // handles any config loading that's needed to be done after load
    @Override
    public void start() {
        started = true;
        try {
            PolarisAPI.INSTANCE.getConfigManager().start();
        } catch (Exception e) {
            LogUtil.error("Failed to start config manager.", e);
        }
    }

    @Override
    public void reload(ConfigManager config) {
        if (config.isLoadedAsync() && started) {
            PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runNow(PolarisAPI.INSTANCE.getPolarisPlugin(),
                    () -> successfulReload(config));
        } else {
            successfulReload(config);
        }
    }

    @Override
    public CompletableFuture<Boolean> reloadAsync(ConfigManager config) {
        if (config.isLoadedAsync() && started) {
            CompletableFuture<Boolean> future = new CompletableFuture<>();
            PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runNow(PolarisAPI.INSTANCE.getPolarisPlugin(),
                    () -> future.complete(successfulReload(config)));
            return future;
        }
        return CompletableFuture.completedFuture(successfulReload(config));
    }

    private boolean successfulReload(ConfigManager config) {
        try {
            config.reload();
            PolarisAPI.INSTANCE.getConfigManager().load(config);
            if (started) PolarisAPI.INSTANCE.getConfigManager().start();
            onReload(config);
            if (started)
                PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runNow(PolarisAPI.INSTANCE.getPolarisPlugin(),
                        () -> Channels.RELOAD.fire(true));
            return true;
        } catch (Exception e) {
            LogUtil.error("Failed to reload config", e);
        }
        if (started)
            PolarisAPI.INSTANCE.getScheduler().getAsyncScheduler().runNow(PolarisAPI.INSTANCE.getPolarisPlugin(),
                    () -> Channels.RELOAD.fire(false));
        return false;
    }

    @Override
    public void onReload(ConfigManager newConfig) {
        if (newConfig == null) {
            LogUtil.warn("ConfigManager not set. Using default config file manager.");
            configManager = configManagerFile;
        } else {
            configManager = newConfig;
        }
        // Update variables
        updateVariables();
        // Restart
        PolarisAPI.INSTANCE.getAlertManager().reload(configManager);
        PolarisAPI.INSTANCE.getDiscordManager().reload();
        PolarisAPI.INSTANCE.getSpectateManager().reload();
        // First-load guard: load() calls reload() before start() runs, so this fires once with started=false before the datastore exists. Subsequent /polarisac reload calls see started=true and proceed (including disabled→enabled flips — DataStoreLifecycle.reload() re-evaluates builder.enabled() each time).
        if (!started) return;
        // Hot-reload picks up backend swaps + routing + connection-pool edits without a server restart. Drains in-flight writes for shutdown-drain-timeout-ms then drops; brief mid-reload unavailability is the tradeoff.
        if (PolarisAPI.INSTANCE.getDataStoreLifecycle() != null) {
            PolarisAPI.INSTANCE.getDataStoreLifecycle().reload();
        }
        // Reload checks for all players
        for (PolarisPlayer player : PolarisAPI.INSTANCE.getPlayerDataManager().getEntries()) {
            player.runSafely(() -> player.reload(configManager));
        }
    }

    private void updateVariables() {
        variableReplacements.putIfAbsent("%player%", PolarisUser::getName);
        variableReplacements.putIfAbsent("%uuid%", user -> user.getUniqueId().toString());
        variableReplacements.putIfAbsent("%ping%", user -> user.getTransactionPing() + "");
        variableReplacements.putIfAbsent("%brand%", PolarisUser::getBrand);
        variableReplacements.putIfAbsent("%h_sensitivity%", user -> ((int) Math.round(user.getHorizontalSensitivity() * 200)) + "");
        variableReplacements.putIfAbsent("%v_sensitivity%", user -> ((int) Math.round(user.getVerticalSensitivity() * 200)) + "");
        variableReplacements.putIfAbsent("%fast_math%", user -> !user.isVanillaMath() + "");
        variableReplacements.putIfAbsent("%tps%", user -> String.format("%.2f", PolarisAPI.INSTANCE.getPlatformServer().getTPS()));
        variableReplacements.putIfAbsent("%version%", PolarisUser::getVersionName);
        // static variables
        staticReplacements.put("%prefix%", MessageUtil.translateAlternateColorCodes('&', PolarisAPI.INSTANCE.getConfigManager().getPrefix()));
        staticReplacements.putIfAbsent("%polarisac_version%", getPolarisVersion());
    }
}
