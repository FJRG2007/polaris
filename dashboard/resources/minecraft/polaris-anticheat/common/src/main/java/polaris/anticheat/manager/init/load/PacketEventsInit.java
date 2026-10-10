package polaris.anticheat.manager.init.load;

import polaris.anticheat.PolarisAPI;
import polaris.anticheat.platform.api.Platform;
import polaris.anticheat.utils.anticheat.LogUtil;
import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.PacketEventsAPI;
import com.github.retrooper.packetevents.protocol.chat.ChatTypes;
import com.github.retrooper.packetevents.protocol.entity.data.EntityDataTypes;
import com.github.retrooper.packetevents.protocol.entity.type.EntityTypes;
import com.github.retrooper.packetevents.protocol.item.enchantment.type.EnchantmentTypes;
import com.github.retrooper.packetevents.protocol.item.type.ItemTypes;
import com.github.retrooper.packetevents.protocol.particle.type.ParticleTypes;
import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;
import com.github.retrooper.packetevents.protocol.world.states.type.StateTypes;

import java.util.concurrent.Executors;

public class PacketEventsInit implements LoadableInitable {

    private final PacketEventsAPI<?> packetEventsAPI;

    public PacketEventsInit(PacketEventsAPI<?> packetEventsAPI) {
        this.packetEventsAPI = packetEventsAPI;
    }

    @Override
    public void load() {
        LogUtil.info("Loading PacketEvents...");
        PacketEvents.setAPI(packetEventsAPI);
        PacketEvents.getAPI().getSettings()
                .fullStackTrace(true)
                // A modded server sends content PacketEvents has no mapping for; a packet
                // it fails to read must not cost the player their connection there.
                .kickOnPacketException(PolarisAPI.INSTANCE.getPlatform() != Platform.NEOFORGE)
                .checkForUpdates(false)
                .reEncodeByDefault(false)
                .debug(false);
        PacketEvents.getAPI().load();
        // This may seem useless, but it causes java to start loading stuff async before we need it
        Executors.defaultThreadFactory().newThread(() -> {
            StateTypes.AIR.getName();
            ItemTypes.AIR.getName();
            EntityTypes.PLAYER.getParent();
            EntityDataTypes.BOOLEAN.getName();
            ChatTypes.CHAT.getName();
            EnchantmentTypes.ALL_DAMAGE_PROTECTION.getName();
            ParticleTypes.DUST.getName();
            WrappedBlockState.getByString(PacketEvents.getAPI().getServerManager().getVersion().toClientVersion(), "", false);
        }).start();
    }
}
