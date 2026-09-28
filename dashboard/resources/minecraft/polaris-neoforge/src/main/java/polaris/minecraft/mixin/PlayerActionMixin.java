package polaris.minecraft.mixin;

import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.AntiXray;

/** Digging at buried ore the player could not have seen: how X-Ray tools probe an anti-xray. */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class PlayerActionMixin {
    @Shadow
    public ServerPlayer player;

    @Inject(method = "handlePlayerAction", at = @At("HEAD"))
    private void polaris$probe(ServerboundPlayerActionPacket packet, CallbackInfo done) {
        AntiXray.onDig(player, packet.getAction(), packet.getPos());
    }
}
