package com.scout.symbiote.event;

import com.scout.symbiote.ability.LivingArmorSizing;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.EntityEvent.Size;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class LivingArmorSizeHandler {
   @SubscribeEvent
   public static void onEntitySize(Size event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         SymbioteProfile p = SymbioteTracker.get(player.serverLevel()).peek(player.getUUID());
         if (p != null && p.stage.isBonded() && p.livingArmorActive) {
            LivingArmorSizing.applyLargeDimensions(event);
         }
      }
   }

   private LivingArmorSizeHandler() {
   }
}
