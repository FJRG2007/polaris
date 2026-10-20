package polaris.minecraft.mixin;

import net.minecraft.world.entity.Display;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** What a block display shows, for the seasonal cobwebs drawn as one on a single player's screen. */
@Mixin(Display.BlockDisplay.class)
public interface BlockDisplayInvoker {
    @Invoker("setBlockState")
    void polaris$setBlockState(BlockState state);
}
