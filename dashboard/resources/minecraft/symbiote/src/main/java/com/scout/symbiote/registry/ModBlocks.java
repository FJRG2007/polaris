package com.scout.symbiote.registry;

import com.scout.symbiote.block.DeathCocoonBlock;
import com.scout.symbiote.block.DormantSampleBlock;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour.Properties;
import net.minecraft.world.level.material.MapColor;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModBlocks {
   public static final DeferredRegister.Blocks REGISTER = DeferredRegister.createBlocks("symbiote");
   public static final DeferredBlock<DormantSampleBlock> DORMANT_SAMPLE = REGISTER.registerBlock(
      "dormant_sample",
      DormantSampleBlock::new,
      Properties.of().mapColor(MapColor.COLOR_PURPLE).strength(1.5F).sound(SoundType.SLIME_BLOCK).lightLevel(s -> 5).noOcclusion()
   );
   public static final DeferredBlock<DeathCocoonBlock> DEATH_COCOON = REGISTER.registerBlock(
      "death_cocoon", DeathCocoonBlock::new, Properties.of().mapColor(MapColor.COLOR_BLACK).strength(0.8F).sound(SoundType.SLIME_BLOCK).noOcclusion()
   );
   public static final DeferredItem<BlockItem> DORMANT_SAMPLE_ITEM = ModItems.REGISTER.registerSimpleBlockItem("dormant_sample", DORMANT_SAMPLE);
   public static final DeferredItem<BlockItem> DEATH_COCOON_ITEM = ModItems.REGISTER.registerSimpleBlockItem("death_cocoon", DEATH_COCOON);

   private ModBlocks() {
   }
}
