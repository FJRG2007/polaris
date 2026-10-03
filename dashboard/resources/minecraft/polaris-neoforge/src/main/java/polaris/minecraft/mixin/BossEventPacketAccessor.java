package polaris.minecraft.mixin;

import java.util.UUID;
import net.minecraft.network.protocol.game.ClientboundBossEventPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** The bar a boss bar packet is about, for the login gate to tell its own bars from the game's. */
@Mixin(ClientboundBossEventPacket.class)
public interface BossEventPacketAccessor {
    @Accessor("id")
    UUID polaris$id();
}
