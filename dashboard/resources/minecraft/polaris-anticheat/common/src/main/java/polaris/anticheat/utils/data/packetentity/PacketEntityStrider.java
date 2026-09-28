package polaris.anticheat.utils.data.packetentity;

import polaris.anticheat.player.PolarisPlayer;
import com.github.retrooper.packetevents.protocol.entity.type.EntityType;

import java.util.UUID;

public class PacketEntityStrider extends PacketEntityRideable {
    public boolean isShaking = false;

    public PacketEntityStrider(PolarisPlayer player, UUID uuid, EntityType type, double x, double y, double z) {
        super(player, uuid, type, x, y, z);
    }
}
