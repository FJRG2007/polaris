package polaris.anticheat.platform.neoforge;

import com.github.retrooper.packetevents.PacketEventsAPI;
import lombok.Getter;
import net.neoforged.fml.loading.FMLPaths;
import org.jetbrains.annotations.NotNull;
import polaris.anticheat.PolarisAPI;
import polaris.anticheat.api.PolarisAPIProvider;
import polaris.anticheat.api.plugin.BasicPolarisPlugin;
import polaris.anticheat.api.plugin.PolarisPlugin;
import polaris.anticheat.internal.plugin.resolver.PolarisExtensionManager;
import polaris.anticheat.platform.api.PlatformLoader;
import polaris.anticheat.platform.api.PlatformServer;
import polaris.anticheat.platform.api.command.CommandService;
import polaris.anticheat.platform.api.manager.ItemResetHandler;
import polaris.anticheat.platform.api.manager.MessagePlaceHolderManager;
import polaris.anticheat.platform.api.manager.PermissionRegistrationManager;
import polaris.anticheat.platform.api.manager.PlatformPluginManager;
import polaris.anticheat.platform.api.player.PlatformPlayerFactory;
import polaris.anticheat.platform.neoforge.player.NeoForgePlatformPlayerFactory;
import polaris.anticheat.platform.neoforge.scheduler.NeoForgePlatformScheduler;
import polaris.anticheat.platform.neoforge.sender.NeoForgeSenderFactory;

import java.io.File;
import java.util.List;
import java.util.logging.Logger;

/**
 * The engine's view of a NeoForge server. Commands are left out: on a server
 * Polaris manages, what the engine catches is read on the Anti-cheat tab.
 */
public final class NeoForgeLoader implements PlatformLoader {

    private static volatile NeoForgeLoader instance;

    private final PacketEventsAPI<?> packetEvents;
    @Getter private final PolarisPlugin plugin;
    @Getter private final NeoForgePlatformScheduler scheduler = new NeoForgePlatformScheduler(NeoForgeServer::tickCount);
    @Getter private final PlatformPlayerFactory platformPlayerFactory = new NeoForgePlatformPlayerFactory();
    @Getter private final ItemResetHandler itemResetHandler = new NeoForgeManagers.ItemReset();
    @Getter private final PlatformPluginManager pluginManager = new NeoForgeManagers.Plugins();
    @Getter private final PlatformServer platformServer = new NeoForgePlatformServer();
    private final NeoForgeSenderFactory senderFactory = new NeoForgeSenderFactory();
    private final PermissionRegistrationManager permissionManager = new NeoForgeManagers.Permissions(senderFactory);
    private final MessagePlaceHolderManager placeholders = new NeoForgeManagers.Placeholders();

    NeoForgeLoader(PacketEventsAPI<?> packetEvents, String version, Logger logger) {
        this.packetEvents = packetEvents;
        BasicPolarisPlugin own = new BasicPolarisPlugin(logger,
                new File(FMLPaths.CONFIGDIR.get().toFile(), "PolarisAC"),
                version, "Polaris Anti-Cheat", List.of("Polaris"));
        this.plugin = own;
        PolarisExtensionManager extensions = PolarisAPI.INSTANCE.getExtensionManager();
        extensions.registerResolver(context -> {
            if (context instanceof String id && (id.equalsIgnoreCase("polarisac") || id.equalsIgnoreCase("PolarisAC"))) return own;
            if (context instanceof Class<?> type && type.getName().startsWith("polaris.anticheat.")) return own;
            if (context instanceof PolarisACNeoForgeMod) return own;
            return null;
        });
        instance = this;
    }

    public static NeoForgeLoader get() {
        return instance;
    }

    @Override
    public PacketEventsAPI<?> getPacketEvents() {
        return packetEvents;
    }

    @Override
    public CommandService getCommandService() {
        return () -> {};
    }

    @Override
    public NeoForgeSenderFactory getSenderFactory() {
        return senderFactory;
    }

    public NeoForgeSenderFactory getNeoForgeSenderFactory() {
        return senderFactory;
    }

    @Override
    public void registerAPIService() {
        PolarisAPIProvider.init(PolarisAPI.INSTANCE.getExternalAPI());
    }

    @Override
    public @NotNull MessagePlaceHolderManager getMessagePlaceHolderManager() {
        return placeholders;
    }

    @Override
    public PermissionRegistrationManager getPermissionManager() {
        return permissionManager;
    }
}
