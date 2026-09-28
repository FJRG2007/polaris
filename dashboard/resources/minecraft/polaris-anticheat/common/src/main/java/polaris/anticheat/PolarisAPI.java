package polaris.anticheat;

import polaris.anticheat.api.event.EventBus;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.api.storage.backend.BackendRegistry;
import polaris.anticheat.internal.plugin.resolver.PolarisExtensionManager;
import polaris.anticheat.internal.event.OptimizedEventBus;
import polaris.anticheat.internal.storage.backend.BackendRegistryImpl;
import polaris.anticheat.internal.storage.backend.memory.InMemoryBackendProvider;
import polaris.anticheat.internal.storage.backend.mongo.MongoBackendProvider;
import polaris.anticheat.internal.storage.backend.mysql.MysqlBackendProvider;
import polaris.anticheat.internal.storage.backend.postgres.PostgresBackendProvider;
import polaris.anticheat.internal.storage.backend.redis.RedisBackendProvider;
import polaris.anticheat.internal.storage.backend.sqlite.SqliteBackendProvider;
import polaris.anticheat.manager.AlertManagerImpl;
import polaris.anticheat.manager.DiscordManager;
import polaris.anticheat.manager.InitManager;
import polaris.anticheat.manager.SpectateManager;
import polaris.anticheat.manager.TickManager;
import polaris.anticheat.manager.config.BaseConfigManager;
import polaris.anticheat.manager.datastore.DataStoreLifecycle;
import polaris.anticheat.manager.init.Initable;
import polaris.anticheat.platform.api.Platform;
import polaris.anticheat.platform.api.PlatformLoader;
import polaris.anticheat.platform.api.PlatformServer;
import polaris.anticheat.platform.api.command.CommandService;
import polaris.anticheat.platform.api.manager.ItemResetHandler;
import polaris.anticheat.platform.api.manager.MessagePlaceHolderManager;
import polaris.anticheat.platform.api.manager.PermissionRegistrationManager;
import polaris.anticheat.platform.api.manager.PlatformPluginManager;
import polaris.anticheat.platform.api.player.PlatformPlayerFactory;
import polaris.anticheat.platform.api.scheduler.PlatformScheduler;
import polaris.anticheat.platform.api.sender.SenderFactory;
import polaris.anticheat.utils.anticheat.PlayerDataManager;
import polaris.anticheat.utils.common.arguments.CommonPolarisArguments;
import polaris.anticheat.utils.reflection.ReflectionUtils;
import lombok.Getter;
import org.jetbrains.annotations.NotNull;

@Getter
public final class PolarisAPI {
    public static final PolarisAPI INSTANCE = new PolarisAPI();

    private final Platform platform = detectPlatform();
    private final BaseConfigManager configManager;
    private final AlertManagerImpl alertManager;
    private final SpectateManager spectateManager;
    private final DiscordManager discordManager;
    private final PlayerDataManager playerDataManager;
    private final TickManager tickManager;
    private final PolarisExtensionManager extensionManager;
    private final EventBus eventBus;
    private final PolarisExternalAPI externalAPI;
    private DataStoreLifecycle dataStoreLifecycle;
    private final BackendRegistry backendRegistry = buildBackendRegistry();
    private PlatformLoader loader;
    private InitManager initManager;
    private boolean initialized = false;

    private PolarisAPI() {
        this.configManager = new BaseConfigManager();
        this.alertManager = new AlertManagerImpl();
        this.spectateManager = new SpectateManager();
        this.discordManager = new DiscordManager();
        this.playerDataManager = new PlayerDataManager();
        this.tickManager = new TickManager();
        this.extensionManager = new PolarisExtensionManager();
        this.eventBus = new OptimizedEventBus(extensionManager);
        this.externalAPI = new PolarisExternalAPI(this);
    }

    // the order matters
    private static Platform detectPlatform() {
        Platform override = CommonPolarisArguments.PLATFORM_OVERRIDE.value();
        if (override != null) return override;
        if (ReflectionUtils.hasClass("io.papermc.paper.threadedregions.RegionizedServer")) return Platform.FOLIA;
        if (ReflectionUtils.hasClass("org.bukkit.Bukkit")) return Platform.BUKKIT;
        if (ReflectionUtils.hasClass("net.fabricmc.loader.api.FabricLoader")) return Platform.FABRIC;
        throw new IllegalStateException("Unknown platform!");
    }

    public void load(PlatformLoader platformLoader, Initable... platformSpecificInitables) {
        this.loader = platformLoader;
        this.dataStoreLifecycle = new DataStoreLifecycle(getPolarisPlugin(), backendRegistry);
        this.initManager = new InitManager(loader.getPacketEvents(), platformSpecificInitables);
        this.initManager.load();
        this.initialized = true;
    }

    private static BackendRegistry buildBackendRegistry() {
        BackendRegistryImpl registry = new BackendRegistryImpl();
        registry.register(new SqliteBackendProvider());
        registry.register(new InMemoryBackendProvider());
        registry.register(new MysqlBackendProvider());
        registry.register(new PostgresBackendProvider());
        registry.register(new MongoBackendProvider());
        registry.register(new RedisBackendProvider());
        return registry;
    }

    public void start() {
        checkInitialized();
        initManager.start();
    }

    public void stop() {
        checkInitialized();
        initManager.stop();
    }

    public PlatformScheduler getScheduler() {
        return loader.getScheduler();
    }

    public PlatformPlayerFactory getPlatformPlayerFactory() {
        return loader.getPlatformPlayerFactory();
    }

    public PolarisPlugin getPolarisPlugin() {
        return loader.getPlugin();
    }

    public SenderFactory<?> getSenderFactory() {
        return loader.getSenderFactory();
    }

    public ItemResetHandler getItemResetHandler() {
        return loader.getItemResetHandler();
    }

    public PlatformPluginManager getPluginManager() {
        return loader.getPluginManager();
    }

    public PlatformServer getPlatformServer() {
        return loader.getPlatformServer();
    }

    public @NotNull MessagePlaceHolderManager getMessagePlaceHolderManager() {
        return loader.getMessagePlaceHolderManager();
    }

    public CommandService getCommandService() {
        return loader.getCommandService();
    }

    private void checkInitialized() {
        if (!initialized) {
            throw new IllegalStateException("PolarisAPI has not been initialized!");
        }
    }

    public PermissionRegistrationManager getPermissionManager() {
        return loader.getPermissionManager();
    }
}
