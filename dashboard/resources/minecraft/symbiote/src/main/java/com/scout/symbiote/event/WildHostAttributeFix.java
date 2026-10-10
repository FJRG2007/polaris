package com.scout.symbiote.event;

import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.neoforged.neoforge.event.entity.EntityAttributeModificationEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.common.EventBusSubscriber.Bus;

@EventBusSubscriber(modid = "symbiote", bus = Bus.MOD)
public final class WildHostAttributeFix {
   @SubscribeEvent
   public static void onAttributeModification(EntityAttributeModificationEvent event) {
      for (EntityType<? extends LivingEntity> type : event.getTypes()) {
         if (!event.has(type, Attributes.ATTACK_DAMAGE)) {
            event.add(type, Attributes.ATTACK_DAMAGE, 0.0);
         }
      }
   }

   private WildHostAttributeFix() {
   }
}
