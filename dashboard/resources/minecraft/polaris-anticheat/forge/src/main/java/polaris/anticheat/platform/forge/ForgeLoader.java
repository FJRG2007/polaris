package polaris.anticheat.platform.forge;

import com.github.retrooper.packetevents.PacketEventsAPI;
import lombok.Getter;
import net.minecraftforge.fml.loading.FMLPaths;
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
import polaris.anticheat.platform.forge.player.ForgePlatformPlayerFactory;
import polaris.anticheat.platform.forge.scheduler.ForgePlatformScheduler;
import polaris.anticheat.platform.forge.sender.ForgeSenderFactory;

import java.io.File;
import java.util.List;
import java.util.logging.Logger;

/**
 * The engine's view of a Forge server. Commands are left out: on a server
 * Polaris manages, what the engine catches is read on the Anti-cheat tab.
 */
public final class ForgeLoader implements PlatformLoader {

    private static volatile ForgeLoader instance;

    private final PacketEventsAPI<?> packetEvents;
    @Getter private final PolarisPlugin plugin;
    @Getter private final ForgePlatformScheduler scheduler = new ForgePlatformScheduler(ForgeServer::tickCount);
    @Getter private final PlatformPlayerFactory platformPlayerFactory = new ForgePlatformPlayerFactory();
    @Getter private final ItemResetHandler itemResetHandler = new ForgeManagers.ItemReset();
    @Getter private final PlatformPluginManager pluginManager = new ForgeManagers.Plugins();
    @Getter private final PlatformServer platformServer = new ForgePlatformServer();
    private final ForgeSenderFactory senderFactory = new ForgeSenderFactory();
    private final PermissionRegistrationManager permissionManager = new ForgeManagers.Permissions(senderFactory);
    private final MessagePlaceHolderManager placeholders = new ForgeManagers.Placeholders();

    ForgeLoader(PacketEventsAPI<?> packetEvents, String version, Logger logger) {
        this.packetEvents = packetEvents;
        BasicPolarisPlugin own = new BasicPolarisPlugin(logger,
                new File(FMLPaths.CONFIGDIR.get().toFile(), "PolarisAC"),
                version, "Polaris Anti-Cheat", List.of("Polaris"));
        this.plugin = own;
        PolarisExtensionManager extensions = PolarisAPI.INSTANCE.getExtensionManager();
        extensions.registerResolver(context -> {
            if (context instanceof String id && (id.equalsIgnoreCase("polarisac") || id.equalsIgnoreCase("PolarisAC"))) return own;
            if (context instanceof Class<?> type && type.getName().startsWith("polaris.anticheat.")) return own;
            if (context instanceof PolarisACForgeMod) return own;
            return null;
        });
        instance = this;
    }

    public static ForgeLoader get() {
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
    public ForgeSenderFactory getSenderFactory() {
        return senderFactory;
    }

    public ForgeSenderFactory getForgeSenderFactory() {
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
