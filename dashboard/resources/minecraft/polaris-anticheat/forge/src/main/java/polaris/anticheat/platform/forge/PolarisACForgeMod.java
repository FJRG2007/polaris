package polaris.anticheat.platform.forge;

import com.github.retrooper.packetevents.settings.PacketEventsSettings;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraftforge.fml.ModLoadingContext;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.entity.player.PlayerEvent;
import net.minecraftforge.event.level.LevelEvent;
import net.minecraftforge.event.server.ServerStartingEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.event.TickEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import polaris.anticheat.PolarisAPI;
import polaris.anticheat.platform.forge.packetevents.ForgePacketEvents;
import polaris.anticheat.platform.forge.packetevents.ForgePacketEventsAPI;
import polaris.anticheat.platform.forge.registry.ForgeRegistryBridge;
import polaris.anticheat.platform.forge.utils.Slf4jBackedJULogger;
import polaris.anticheat.platform.forge.world.ForgePlatformWorld;

import java.util.Locale;

/**
 * Polaris's anti-cheat on a dedicated Forge server (1.20.1 and the releases its jar names). It runs unless Polaris has
 * switched it off (`POLARIS_ANTICHEAT=off`), the same switch the Anti-cheat tab
 * writes, and reports what it catches to Polaris while that switch is on.
 *
 * Nothing here may stop a server from starting: a failure to load turns the
 * engine off and says so in the log.
 */
@Mod("polarisac")
public final class PolarisACForgeMod {

    private static final Logger LOG = LoggerFactory.getLogger("PolarisAC");

    private ForgeLoader loader;
    private ForgeTickEndEvent tickEnd;
    private boolean saidUnattached;

    public PolarisACForgeMod() {
        if (!FMLEnvironment.dist.isDedicatedServer()) return;
        if (switchedOff()) {
            LOG.info("Polaris anti-cheat is switched off for this server");
            return;
        }
        try {
            String version = ModLoadingContext.get().getActiveContainer().getModInfo().getVersion().toString();
            loader = new ForgeLoader(new ForgePacketEventsAPI("polarisac", new PacketEventsSettings()), version,
                    new Slf4jBackedJULogger("PolarisAC"));
            tickEnd = new ForgeTickEndEvent();
            PolarisAPI.INSTANCE.load(loader, tickEnd);
        } catch (Throwable failed) {
            loader = null;
            LOG.error("Polaris anti-cheat could not load and stays off; the server starts as usual", failed);
            return;
        }
        MinecraftForge.EVENT_BUS.addListener(this::onServerStarting);
        MinecraftForge.EVENT_BUS.addListener(this::onServerStopping);
        MinecraftForge.EVENT_BUS.addListener(this::onServerTick);
        MinecraftForge.EVENT_BUS.addListener(this::onLogin);
        MinecraftForge.EVENT_BUS.addListener(this::onRespawn);
        MinecraftForge.EVENT_BUS.addListener(this::onLevelUnload);
        MinecraftForge.EVENT_BUS.addListener(ForgePistons::onPiston);
    }

    /** The Anti-cheat tab's switch: anything but `off` leaves it on. */
    static boolean switchedOff() {
        String value = System.getenv("POLARIS_ANTICHEAT");
        return value != null && value.trim().toLowerCase(Locale.ROOT).equals("off");
    }

    private void onServerStarting(ServerStartingEvent event) {
        ForgeServer.set(event.getServer());
        try {
            ForgeRegistryBridge.install(event.getServer());
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
            ForgeServer.set(null);
        }
    }

    private void onServerTick(TickEvent.ServerTickEvent event) {
        if (event.phase != TickEvent.Phase.END) return;
        loader.getScheduler().tick();
        tickEnd.onEndOfServerTick();
    }

    private void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        boolean seen;
        try {
            seen = ForgePacketEvents.onPlayerLogin(player);
        } catch (Throwable failed) {
            LOG.warn("Polaris anti-cheat could not start watching " + player.getGameProfile().getName(), failed);
            return;
        }
        if (!seen && !saidUnattached) {
            saidUnattached = true;
            LOG.warn("Polaris anti-cheat cannot read this server's connections (its connection hook did not load "
                    + "on this Forge build), so it is not watching anybody");
        }
    }

    private void onRespawn(PlayerEvent.PlayerRespawnEvent event) {
        if (!(event.getEntity() instanceof ServerPlayer player)) return;
        ForgePacketEvents.onPlayerPlaced(player);
        if (loader.getPlatformPlayerFactory() instanceof polaris.anticheat.platform.forge.player.ForgePlatformPlayerFactory factory) {
            factory.replaceNativePlayer(player.getUUID(), player);
        }
    }

    private void onLevelUnload(LevelEvent.Unload event) {
        if (event.getLevel() instanceof ServerLevel level) ForgePlatformWorld.forget(level);
    }
}
