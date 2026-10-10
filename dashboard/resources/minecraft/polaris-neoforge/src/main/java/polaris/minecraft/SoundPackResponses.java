package polaris.minecraft;

import java.util.UUID;
import net.minecraft.network.protocol.common.ServerboundResourcePackPacket;
import net.minecraft.server.level.ServerPlayer;

/** The mixin's way in to {@link SoundPack}, which is not public. */
public final class SoundPackResponses {
    private SoundPackResponses() {}

    /** Whether the answer was to the sound pack, and so handled. */
    public static boolean handle(ServerPlayer player, UUID packId, ServerboundResourcePackPacket.Action action) {
        SoundPack pack = SoundPack.instance();
        return pack != null && pack.onResponse(player, packId, action);
    }
}
