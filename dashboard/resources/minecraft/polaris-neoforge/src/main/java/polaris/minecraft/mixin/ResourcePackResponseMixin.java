package polaris.minecraft.mixin;

import net.minecraft.network.protocol.common.ServerboundResourcePackPacket;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.SoundPackResponses;

/**
 * A player's answer to the server's sound pack. Taken once the packet is on the
 * game thread (after the thread check, which reschedules it there), and only
 * from players in the game: the answer to a pack of the server's own goes on to
 * the game as before.
 */
@Mixin(ServerCommonPacketListenerImpl.class)
public abstract class ResourcePackResponseMixin {
    @Inject(
            method = "handleResourcePackResponse",
            at = @At(
                    value = "INVOKE",
                    target = "Lnet/minecraft/network/protocol/PacketUtils;ensureRunningOnSameThread(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketListener;Lnet/minecraft/util/thread/BlockableEventLoop;)V",
                    shift = At.Shift.AFTER),
            cancellable = true)
    private void polaris$soundPack(ServerboundResourcePackPacket packet, CallbackInfo done) {
        if ((Object) this instanceof ServerGamePacketListenerImpl game
                && SoundPackResponses.handle(game.player, packet.id(), packet.action())) {
            done.cancel();
        }
    }
}
