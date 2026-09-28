package polaris.anticheat.utils.data.packetentity.dragon;

import polaris.anticheat.player.PolarisPlayer;
import polaris.anticheat.utils.data.packetentity.PacketEntity;
import com.github.retrooper.packetevents.protocol.entity.type.EntityTypes;

public final class PacketEntityEnderDragonPart extends PacketEntity {
    public final DragonPart part;
    public final float width, height;

    public PacketEntityEnderDragonPart(PolarisPlayer player, DragonPart part, double x, double y, double z, float width, float height) {
        super(player, null, EntityTypes.ENDER_DRAGON, x, y, z);
        this.part = part;
        this.width = width;
        this.height = height;
    }
}
