package polaris.minecraft.mixin;

import net.minecraft.network.Connection;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.PlayerSkins;

/** The skin chosen in the dashboard goes on the profile before any client hears of the player. */
@Mixin(PlayerList.class)
public abstract class PlayerJoinSkinMixin {
    @Shadow @Final private MinecraftServer server;

    @Inject(method = "placeNewPlayer", at = @At("HEAD"))
    private void polaris$skin(Connection connection, ServerPlayer player, CommonListenerCookie cookie, CallbackInfo done) {
        PlayerSkins.joining(server, player);
    }
}
