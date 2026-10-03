package polaris.minecraft.mixin;

import net.minecraft.network.PacketSendListener;
import net.minecraft.network.protocol.Packet;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.Unseen;

/** Every packet a player is sent is asked whether a player held at the login prompt may see it. */
@Mixin(ServerCommonPacketListenerImpl.class)
public abstract class HeldPacketMixin {
    @Inject(
            method = "send(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketSendListener;)V",
            at = @At("HEAD"),
            cancellable = true)
    private void polaris$unseen(Packet<?> packet, PacketSendListener listener, CallbackInfo info) {
        if ((Object) this instanceof ServerGamePacketListenerImpl game && Unseen.blocks(packet, game.player)) {
            info.cancel();
        }
    }
}
