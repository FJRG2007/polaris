package polaris.minecraft.mixin;

import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.game.ClientboundLevelChunkPacketData;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import polaris.minecraft.AntiXray;

/** A chunk is written for a player: its sections with buried ore as rock. */
@Mixin(ClientboundLevelChunkPacketData.class)
public abstract class ChunkPacketDataMixin {
    @Inject(method = "calculateChunkSize", at = @At("HEAD"), cancellable = true)
    private static void polaris$size(LevelChunk chunk, CallbackInfoReturnable<Integer> answer) {
        if (AntiXray.on()) answer.setReturnValue(AntiXray.serializedSize(chunk));
    }

    @Inject(method = "extractChunkData", at = @At("HEAD"), cancellable = true)
    private static void polaris$write(FriendlyByteBuf buffer, LevelChunk chunk, CallbackInfo done) {
        if (!AntiXray.on()) return;
        AntiXray.write(buffer, chunk);
        done.cancel();
    }
}
