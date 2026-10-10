package polaris.anticheat.platform.neoforge;

import com.github.retrooper.packetevents.settings.PacketEventsSettings;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.level.LevelEvent;
import net.neoforged.neoforge.event.server.ServerStartingEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import polaris.anticheat.PolarisAPI;
import polaris.anticheat.platform.neoforge.packetevents.NeoForgePacketEvents;
import polaris.anticheat.platform.neoforge.packetevents.NeoForgePacketEventsAPI;
import polaris.anticheat.platform.neoforge.registry.NeoForgeRegistryBridge;
import polaris.anticheat.platform.neoforge.utils.Slf4jBackedJULogger;
import polaris.anticheat.platform.neoforge.world.NeoForgePlatformWorld;

import java.util.Locale;

/**
 * Polaris's anti-cheat on a dedicated NeoForge server. It runs unless Polaris has
 * switched it off (`POLARIS_ANTICHEAT=off`), the same switch the Anti-cheat tab
 * writes, and reports what it catches to Polaris while that switch is on.
 *
 * Nothing here may stop a server from starting: a failure to load turns the
 * engine off and says so in the log.
 */
@Mod("polarisac")
public final class PolarisACNeoForgeMod {

    private static final Logger LOG = LoggerFactory.getLogger("PolarisAC");

    private NeoForgeLoader loader;
    private NeoForgeTickEndEvent tickEnd;
    private boolean saidUnattached;

    public PolarisACNeoForgeMod(IEventBus modBus, ModContainer container) {
        if (!FMLEnvironment.dist.isDedicatedServer()) return;
        if (switchedOff()) {
            LOG.info("Polaris anti-cheat is switched off for this server");
            return;
        }
        try {
            String version = container.getModInfo().getVersion().toString();
            loader = new NeoForgeLoader(new NeoForgePacketEventsAPI("polarisac", new PacketEventsSettings()), version,
                    new Slf4jBackedJULogger("PolarisAC"));
            tickEnd = new NeoForgeTickEndEvent();
            PolarisAPI.INSTANCE.load(loader, tickEnd);
        } catch (Throwable failed) {
            loader = null;
            LOG.error("Polaris anti-cheat could not load and stays off; the server starts as usual", failed);
            return;
        }
        NeoForge.EVENT_BUS.addListener(this::onServerStarting);
        NeoForge.EVENT_BUS.addListener(this::onServerStopping);
        NeoForge.EVENT_BUS.addListener(this::onServerTick);
        NeoForge.EVENT_BUS.addListener(this::onLogin);
        NeoForge.EVENT_BUS.addListener(this::onRespawn);
        NeoForge.EVENT_BUS.addListener(this::onLevelUnload);
        NeoForge.EVENT_BUS.addListener(NeoForgePistons::onPiston);
    }

    /** The Anti-cheat tab's switch: anything but `off` leaves it on. */
    static boolean switchedOff() {
        String value = System.getenv("POLARIS_ANTICHEAT");
        return value != null && value.trim().toLowerCase(Locale.ROOT).equals("off");
    }

    private void onServerStarting(ServerStartingEvent event) {
        NeoForgeServer.set(event.getServer());
        try {
            NeoForgeRegistryBridge.install(event.getServer());
        } catch (Throwable failed) {
            // Simulating a modded world it cannot read would flag honest players
            LOG.error("Polaris anti-cheat stays off on this server: it cannot read this server's content", failed);
            return;
        }
        try {
            PolarisAPI.INSTANCE.start();
            LOG.info("Polaris anti-cheat is watching this server");
        } catch (Throwable failed) {
            LOG.error("Polaris anti-cheat could not start and stays off", failed);
        }
    }

    private void onServerStopping(ServerStoppingEvent event) {
        try {
            PolarisAPI.INSTANCE.stop();
        } catch (Throwable failed) {
            LOG.warn("Polaris anti-cheat did not stop cleanly", failed);
        } finally {
            loader.getScheduler().shutdown();
            NeoForgeServer.set(null);
        }
    }

    private void onServerTick(ServerTickEvent.Post event) {
        loader.getScheduler().tick();
        tickEnd.onEndOfServerTick();
    }

    private void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        boolean seen;
        try {
            seen = NeoForgePacketEvents.onPlayerLogin(player);
        } catch (Throwable failed) {
            LOG.warn("Polaris anti-cheat could not start watching " + player.getGameProfile().getName(), failed);
            return;
        }
        if (!seen && !saidUnattached) {
            saidUnattached = true;
            LOG.warn("Polaris anti-cheat cannot read this server's connections (its connection hook did not load "
                    + "on this NeoForge build), so it is not watching anybody");
        }
    }

    private void onRespawn(PlayerEvent.PlayerRespawnEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        NeoForgePacketEvents.onPlayerPlaced(player);
        if (loader.getPlatformPlayerFactory() instanceof polaris.anticheat.platform.neoforge.player.NeoForgePlatformPlayerFactory factory) {
            factory.replaceNativePlayer(player.getUUID(), player);
        }
    }

    private void onLevelUnload(LevelEvent.Unload event) {
        if (event.getLevel() instanceof ServerLevel level) NeoForgePlatformWorld.forget(level);
    }
}
