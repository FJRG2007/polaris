package polaris.anticheat.manager.init.start;

import polaris.anticheat.antixray.AntiXray;
import polaris.anticheat.bridge.PolarisReporter;
import polaris.anticheat.events.packets.*;
import polaris.anticheat.events.packets.worldreader.BasePacketWorldReader;
import polaris.anticheat.events.packets.worldreader.PacketWorldReaderEight;
import polaris.anticheat.events.packets.worldreader.PacketWorldReaderEighteen;
import polaris.anticheat.utils.anticheat.LogUtil;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.manager.server.ServerVersion;

public class PacketManager implements StartableInitable {
    @Override
    public void start() {
        LogUtil.info("Registering packets...");

        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerJoinQuit());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPingListener());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerDigging());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerAttack());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketEntityAction());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketBlockAction());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketSelfMetadataListener());
        PacketEvents.getAPI().getEventManager().registerListener(new BedStateTracker());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketServerPlayerRotation());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketServerTeleport());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerCooldown());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerRespawn());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerTick());
        PacketEvents.getAPI().getEventManager().registerListener(new PreViaCheckManagerListener());
        PacketEvents.getAPI().getEventManager().registerListener(new CheckManagerListener());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPlayerSteer());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketPluginMessage());

        if (PacketEvents.getAPI().getServerManager().getVersion().isNewerThanOrEquals(ServerVersion.V_1_13)) {
            PacketEvents.getAPI().getEventManager().registerListener(new PacketServerTags());
        }

        if (PacketEvents.getAPI().getServerManager().getVersion().isNewerThanOrEquals(ServerVersion.V_1_18)) {
            PacketEvents.getAPI().getEventManager().registerListener(new PacketWorldReaderEighteen());
        } else if (PacketEvents.getAPI().getServerManager().getVersion().isOlderThanOrEquals(ServerVersion.V_1_8_8)) {
            PacketEvents.getAPI().getEventManager().registerListener(new PacketWorldReaderEight());
        } else {
            PacketEvents.getAPI().getEventManager().registerListener(new BasePacketWorldReader());
        }

        // After the world readers: the replica reads the real blocks, the client gets the hidden ones.
        if (AntiXray.wanted()) {
            PacketEvents.getAPI().getEventManager().registerListener(AntiXray.start());
            LogUtil.info("Anti-xray on");
        }
        // Start the link to Polaris now, so the honeypot list is there before anybody digs.
        PolarisReporter.get();

        PacketEvents.getAPI().getEventManager().registerListener(new ProxyAlertMessenger());
        PacketEvents.getAPI().getEventManager().registerListener(new PacketHidePlayerInfo());

        PacketEvents.getAPI().init();
    }
}
