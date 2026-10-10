package com.scout.symbiote.registry;

import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModCreativeTabs {
   public static final DeferredRegister<CreativeModeTab> REGISTER = DeferredRegister.create(Registries.CREATIVE_MODE_TAB, "symbiote");
   public static final DeferredHolder<CreativeModeTab, CreativeModeTab> SYMBIOTE_TAB = REGISTER.register(
      "symbiote_tab",
      () -> CreativeModeTab.builder()
         .title(Component.translatable("itemGroup.symbiote.symbiote_tab"))
         .icon(() -> new ItemStack(ModBlocks.DORMANT_SAMPLE_ITEM.get()))
         .displayItems((params, output) -> ModItems.REGISTER.getEntries().forEach(item -> output.accept(item.get())))
         .build()
   );

   private ModCreativeTabs() {
   }
}
