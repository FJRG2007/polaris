package com.scout.symbiote.registry;

import com.scout.symbiote.menu.ArmSlotsMenu;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.inventory.MenuType;
import net.neoforged.neoforge.common.extensions.IMenuTypeExtension;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModMenus {
   public static final DeferredRegister<MenuType<?>> REGISTER = DeferredRegister.create(Registries.MENU, "symbiote");
   public static final DeferredHolder<MenuType<?>, MenuType<ArmSlotsMenu>> ARM_SLOTS = REGISTER.register("arm_slots", () -> IMenuTypeExtension.create(ArmSlotsMenu::new));

   private ModMenus() {
   }
}
