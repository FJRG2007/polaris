package polaris.minecraft.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.AntiXray;

/** A block changed: ore it stopped covering is sent again, for real. */
@Mixin(ServerLevel.class)
public abstract class ServerLevelMixin {
    @Inject(method = "sendBlockUpdated", at = @At("TAIL"))
    private void polaris$reveal(BlockPos pos, BlockState before, BlockState after, int flags, CallbackInfo done) {
        AntiXray.onBlockChanged((ServerLevel) (Object) this, pos, before, after);
    }
}
