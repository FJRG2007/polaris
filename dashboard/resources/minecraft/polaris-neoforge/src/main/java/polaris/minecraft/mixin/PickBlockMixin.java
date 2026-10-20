package polaris.minecraft.mixin;

import net.minecraft.network.protocol.game.ServerboundPickItemFromBlockPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.SeasonalDecor;

/**
 * Pick block on a seasonal decoration gives the decoration: the server picks
 * from the world, and the world holds the grass under a pumpkin a player is only
 * shown. The game hands the packet to the server thread before it reads the
 * world, so the off-thread first call is left to do that.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class PickBlockMixin {
    @Shadow
    public ServerPlayer player;

    @Inject(method = "handlePickItemFromBlock", at = @At("HEAD"), cancellable = true)
    private void polaris$pickDecoration(ServerboundPickItemFromBlockPacket packet, CallbackInfo done) {
        if (player.getServer() == null || !player.getServer().isSameThread()) return;
        if (SeasonalDecor.pick(player, packet.pos())) done.cancel();
    }
}
