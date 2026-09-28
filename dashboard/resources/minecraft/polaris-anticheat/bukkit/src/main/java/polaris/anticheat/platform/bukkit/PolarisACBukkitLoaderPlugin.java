package polaris.anticheat.platform.bukkit;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.PolarisExternalAPI;
import polaris.anticheat.api.PolarisAPIProvider;
import polaris.anticheat.api.PolarisAbstractAPI;
import polaris.anticheat.api.event.EventBus;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.command.CloudCommandService;
import polaris.anticheat.internal.platform.bukkit.resolver.BukkitResolverRegistrar;
import polaris.anticheat.manager.init.Initable;
import polaris.anticheat.manager.init.start.ExemptOnlinePlayersOnReload;
import polaris.anticheat.manager.init.start.StartableInitable;
import polaris.anticheat.platform.api.Platform;
import polaris.anticheat.platform.api.PlatformLoader;
import polaris.anticheat.platform.api.PlatformServer;
import polaris.anticheat.platform.api.command.CommandService;
import polaris.anticheat.platform.api.manager.ItemResetHandler;
import polaris.anticheat.platform.api.manager.MessagePlaceHolderManager;
import polaris.anticheat.platform.api.manager.PlatformPluginManager;
import polaris.anticheat.platform.api.manager.cloud.CloudPlatformCommandArguments;
import polaris.anticheat.platform.api.player.PlatformPlayerFactory;
import polaris.anticheat.platform.api.scheduler.PlatformScheduler;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.platform.api.sender.SenderFactory;
import polaris.anticheat.platform.bukkit.initables.BukkitEventManager;
import polaris.anticheat.platform.bukkit.initables.BukkitLuckPermsInitable;
import polaris.anticheat.platform.bukkit.initables.BukkitTickEndEvent;
import polaris.anticheat.platform.bukkit.manager.BukkitItemResetHandler;
import polaris.anticheat.platform.bukkit.manager.BukkitMessagePlaceHolderManager;
import polaris.anticheat.platform.bukkit.manager.BukkitCloudPlatformCommandArguments;
import polaris.anticheat.platform.bukkit.manager.BukkitPermissionRegistrationManager;
import polaris.anticheat.platform.bukkit.manager.BukkitPlatformPluginManager;
import polaris.anticheat.platform.bukkit.player.BukkitPlatformPlayerFactory;
import polaris.anticheat.platform.bukkit.scheduler.bukkit.BukkitPlatformScheduler;
import polaris.anticheat.platform.bukkit.scheduler.folia.FoliaPlatformScheduler;
import polaris.anticheat.platform.bukkit.sender.BukkitSenderFactory;
import polaris.anticheat.platform.bukkit.utils.placeholder.PlaceholderAPIExpansion;
import polaris.anticheat.utils.anticheat.LogUtil;
import polaris.anticheat.utils.lazy.LazyHolder;
import com.github.retrooper.packetevents.PacketEventsAPI;
import io.github.retrooper.packetevents.factory.spigot.SpigotPacketEventsBuilder;
import lombok.Getter;
import org.bukkit.Bukkit;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.ServicePriority;
import org.bukkit.plugin.java.JavaPlugin;
import org.incendo.cloud.CommandManager;
import org.incendo.cloud.brigadier.BrigadierSetting;
import org.incendo.cloud.brigadier.CloudBrigadierManager;
import org.incendo.cloud.bukkit.CloudBukkitCapabilities;
import org.incendo.cloud.execution.ExecutionCoordinator;
import org.incendo.cloud.paper.LegacyPaperCommandManager;

public final class PolarisACBukkitLoaderPlugin extends JavaPlugin implements PlatformLoader {
    public static PolarisACBukkitLoaderPlugin LOADER;

    private final LazyHolder<PlatformScheduler> scheduler = LazyHolder.simple(this::createScheduler);
    private final LazyHolder<PacketEventsAPI<?>> packetEvents = LazyHolder.simple(() -> SpigotPacketEventsBuilder.build(this));
    private final LazyHolder<BukkitSenderFactory> senderFactory = LazyHolder.simple(BukkitSenderFactory::new);
    private final LazyHolder<ItemResetHandler> itemResetHandler = LazyHolder.simple(BukkitItemResetHandler::new);
    private final LazyHolder<CommandService> commandService = LazyHolder.simple(this::createCommandService);
    private final CloudPlatformCommandArguments commandArguments = new BukkitCloudPlatformCommandArguments();

    @Getter private final PlatformPlayerFactory platformPlayerFactory = new BukkitPlatformPlayerFactory();
    @Getter private final PlatformPluginManager pluginManager = new BukkitPlatformPluginManager();
    @Getter private final PolarisPlugin plugin;
    @Getter private final PlatformServer platformServer = new BukkitPlatformServer();
    @Getter private final MessagePlaceHolderManager messagePlaceHolderManager = new BukkitMessagePlaceHolderManager();
    @Getter private final BukkitPermissionRegistrationManager permissionManager = new BukkitPermissionRegistrationManager();

    public PolarisACBukkitLoaderPlugin() {
        BukkitResolverRegistrar registrar = new BukkitResolverRegistrar();
        registrar.registerAll(PolarisAPI.INSTANCE.getExtensionManager());
        this.plugin = registrar.resolvePlugin(this);
    }

    @Override
    public void onLoad() {
        LOADER = this;
        PolarisAPI.INSTANCE.load(this, this.getBukkitInitTasks());
    }

    private Initable[] getBukkitInitTasks() {
        return new Initable[] {
                new ExemptOnlinePlayersOnReload(),
                new BukkitEventManager(),
                new BukkitTickEndEvent(),
                // Polaris: no usage statistics sent to a third party from somebody's server.
                new BukkitLuckPermsInitable(),
                (StartableInitable) () -> {
                    if (BukkitMessagePlaceHolderManager.hasPlaceholderAPI) {
                        new PlaceholderAPIExpansion().register();
                    }
                }
        };
    }

    @Override
    public void onEnable() {
        PolarisAPI.INSTANCE.start();
    }

    @Override
    public void onDisable() {
        PolarisAPI.INSTANCE.stop();
    }

    @Override
    public PlatformScheduler getScheduler() {
        return scheduler.get();
    }

    @Override
    public PacketEventsAPI<?> getPacketEvents() {
        return packetEvents.get();
    }

    @Override
    public ItemResetHandler getItemResetHandler() {
        return itemResetHandler.get();
    }

    @Override
    public CommandService getCommandService() {
        return commandService.get();
    }

    @Override
    public SenderFactory<CommandSender> getSenderFactory() {
        return senderFactory.get();
    }

    @Override
    @SuppressWarnings("removal")
    public void registerAPIService() {
        final PolarisExternalAPI externalAPI = PolarisAPI.INSTANCE.getExternalAPI();
        final EventBus eventBus = externalAPI.getEventBus();
        final polaris.anticheat.api.plugin.PolarisPlugin plugin = PolarisAPI.INSTANCE.getPolarisPlugin();

        // Bridge Polaris events → legacy Bukkit Event API so pre-1.3 plugins that
        // listened for polaris.anticheat.api.events.* Bukkit events keep working.
        // Typed channel subscriptions here are plugin-bound so they go away if
        // PolarisAC itself is disabled.

        eventBus.get(polaris.anticheat.api.event.events.PolarisJoinEvent.class).onJoin(plugin, (user) -> {
            Bukkit.getPluginManager().callEvent(new polaris.anticheat.api.events.PolarisJoinEvent(user));
        });

        eventBus.get(polaris.anticheat.api.event.events.PolarisQuitEvent.class).onQuit(plugin, (user) -> {
            Bukkit.getPluginManager().callEvent(new polaris.anticheat.api.events.PolarisQuitEvent(user));
        });

        eventBus.get(polaris.anticheat.api.event.events.PolarisReloadEvent.class).onReload(plugin, (success) -> {
            Bukkit.getPluginManager().callEvent(new polaris.anticheat.api.events.PolarisReloadEvent(success));
        });

        eventBus.subscribe(plugin, polaris.anticheat.api.event.events.FlagEvent.class, event -> {
            polaris.anticheat.api.events.FlagEvent bukkitEvent =
                    new polaris.anticheat.api.events.FlagEvent(event.getUser(), event.getCheck(), event::getVerbose);
            Bukkit.getPluginManager().callEvent(bukkitEvent);
            event.setCancelled(event.isCancelled() || bukkitEvent.isCancelled());
        }, 0, false, PolarisACBukkitLoaderPlugin.class);

        eventBus.get(polaris.anticheat.api.event.events.CommandExecuteEvent.class).onCommandExecuteSupplier(plugin, (user, check, verbose, command, cancelled) -> {
            polaris.anticheat.api.events.CommandExecuteEvent bukkitEvent =
                    new polaris.anticheat.api.events.CommandExecuteEvent(user, check, verbose, command);
            Bukkit.getPluginManager().callEvent(bukkitEvent);
            return cancelled || bukkitEvent.isCancelled();
        });

        eventBus.get(polaris.anticheat.api.event.events.CompletePredictionEvent.class).onCompletePrediction(plugin, (user, check, offset, cancelled) -> {
            // Legacy Bukkit event has a verbose field that the new channel event does not; pass empty.
            polaris.anticheat.api.events.CompletePredictionEvent bukkitEvent =
                    new polaris.anticheat.api.events.CompletePredictionEvent(user, check, "", offset);
            Bukkit.getPluginManager().callEvent(bukkitEvent);
            return cancelled || bukkitEvent.isCancelled();
        });

        PolarisAPIProvider.init(externalAPI);
        Bukkit.getServicesManager().register(PolarisAbstractAPI.class, externalAPI, this, ServicePriority.Normal);
    }

    private PlatformScheduler createScheduler() {
        return PolarisAPI.INSTANCE.getPlatform() == Platform.FOLIA ? new FoliaPlatformScheduler() : new BukkitPlatformScheduler();
    }

    private CommandService createCommandService() {
        try {
            return new CloudCommandService(this::createCloudCommandManager, commandArguments);
        } catch (Throwable t) {
            LogUtil.warn("CRITICAL: Failed to initialize Command Framework. " +
                    "Polaris will continue to run with no commands.", t);
            return () -> {};
        }
    }

    private CommandManager<Sender> createCloudCommandManager() {
        LegacyPaperCommandManager<Sender> manager = new LegacyPaperCommandManager<>(
                this,
                ExecutionCoordinator.simpleCoordinator(),
                senderFactory.get()
        );
        if (manager.hasCapability(CloudBukkitCapabilities.NATIVE_BRIGADIER)) {
            try {
                manager.registerBrigadier();
                CloudBrigadierManager<Sender, ?> cbm = manager.brigadierManager();
                cbm.settings().set(BrigadierSetting.FORCE_EXECUTABLE, true);
            } catch (Throwable t) {
                LogUtil.error("Failed to register Brigadier native completions. Falling back to standard completions.", t);
            }
        } else if (manager.hasCapability(CloudBukkitCapabilities.ASYNCHRONOUS_COMPLETION)) {
            manager.registerAsynchronousCompletions();
        }
        return manager;
    }

    public BukkitSenderFactory getBukkitSenderFactory() {
        return senderFactory.get();
    }
}
