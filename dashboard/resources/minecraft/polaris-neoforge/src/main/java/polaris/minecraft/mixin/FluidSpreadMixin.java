package polaris.minecraft.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FlowingFluid;
import net.minecraft.world.level.material.FluidState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.EventGuard;

/**
 * Water or lava outside an event's space never flows into it: NeoForge has no
 * event for a fluid spreading, so the spread itself is asked
 * ({@link EventGuard#refusesFlow}). {@code direction} is the way it flows, onto
 * {@code pos} from the block behind it; a fluid already inside flows on.
 */
@Mixin(FlowingFluid.class)
public abstract class FluidSpreadMixin {
    @Inject(method = "spreadTo", at = @At("HEAD"), cancellable = true)
    private void polaris$guard(
            LevelAccessor level, BlockPos pos, BlockState blockState, Direction direction, FluidState fluidState,
            CallbackInfo done) {
        if (EventGuard.refusesFlow(level, pos, direction)) done.cancel();
    }
}
