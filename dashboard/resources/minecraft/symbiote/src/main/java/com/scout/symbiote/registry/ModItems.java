package com.scout.symbiote.registry;

import net.minecraft.world.item.Item;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModItems {
   public static final DeferredRegister.Items REGISTER = DeferredRegister.createItems("symbiote");
   public static final DeferredItem<Item> BIOMASS = REGISTER.registerSimpleItem("biomass");

   private ModItems() {
   }
}
