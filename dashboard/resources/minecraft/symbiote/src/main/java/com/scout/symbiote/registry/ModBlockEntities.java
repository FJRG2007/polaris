package com.scout.symbiote.registry;

import com.scout.symbiote.block.DeathCocoonBlock;
import com.scout.symbiote.block.DormantSampleBlock;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModBlockEntities {
   public static final DeferredRegister<BlockEntityType<?>> REGISTER = DeferredRegister.create(Registries.BLOCK_ENTITY_TYPE, "symbiote");
   public static final DeferredHolder<BlockEntityType<?>, BlockEntityType<DormantSampleBlock.Entity>> DORMANT_SAMPLE = REGISTER.register(
      "dormant_sample",
      () -> {
         BlockEntityType<DormantSampleBlock.Entity> type = new BlockEntityType<>(DormantSampleBlock.Entity::new, ModBlocks.DORMANT_SAMPLE.get());
         DormantSampleBlock.Entity.TYPE = type;
         return type;
      }
   );
   public static final DeferredHolder<BlockEntityType<?>, BlockEntityType<DeathCocoonBlock.Entity>> DEATH_COCOON = REGISTER.register(
      "death_cocoon",
      () -> {
         BlockEntityType<DeathCocoonBlock.Entity> type = new BlockEntityType<>(DeathCocoonBlock.Entity::new, ModBlocks.DEATH_COCOON.get());
         DeathCocoonBlock.Entity.TYPE = type;
         return type;
      }
   );

   private ModBlockEntities() {
   }
}
