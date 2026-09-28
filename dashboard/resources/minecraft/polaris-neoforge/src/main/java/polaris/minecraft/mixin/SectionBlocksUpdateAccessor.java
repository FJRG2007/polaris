package polaris.minecraft.mixin;

import net.minecraft.core.SectionPos;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** The blocks a section update carries, for the anti-xray to rewrite. */
@Mixin(ClientboundSectionBlocksUpdatePacket.class)
public interface SectionBlocksUpdateAccessor {
    @Accessor("sectionPos")
    SectionPos polaris$sectionPos();

    @Accessor("positions")
    short[] polaris$positions();

    @Accessor("states")
    BlockState[] polaris$states();
}
