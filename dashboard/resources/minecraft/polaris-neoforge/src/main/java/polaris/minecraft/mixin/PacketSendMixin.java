package polaris.minecraft.mixin;

import net.minecraft.network.protocol.Packet;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import polaris.minecraft.AntiXray;

/** Every packet a player is sent passes the anti-xray, so a block update never gives buried ore away. */
@Mixin(ServerCommonPacketListenerImpl.class)
public abstract class PacketSendMixin {
    @ModifyVariable(
            method = "send(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketSendListener;)V",
            at = @At("HEAD"),
            argsOnly = true)
    private Packet<?> polaris$filter(Packet<?> packet) {
        if (!AntiXray.on() || !((Object) this instanceof ServerGamePacketListenerImpl game)) return packet;
        return AntiXray.filter(packet, game.player);
    }
}
