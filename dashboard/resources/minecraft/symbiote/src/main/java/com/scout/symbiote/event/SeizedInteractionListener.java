package com.scout.symbiote.event;

import net.neoforged.bus.api.ICancellableEvent;
import com.scout.symbiote.util.BodySeized;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.living.LivingEntityUseItemEvent.Start;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.EntityInteract;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.EntityInteractSpecific;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.RightClickBlock;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.RightClickItem;
import net.neoforged.bus.api.SubscribeEvent;


public final class SeizedInteractionListener {
   private static final int LOG_EVERY_TICKS = 20;

   @SubscribeEvent
   public void onRightClickItem(RightClickItem event) {
      this.deny(event, "use_item");
   }

   @SubscribeEvent
   public void onRightClickBlock(RightClickBlock event) {
      this.deny(event, "use_block");
   }

   @SubscribeEvent
   public void onEntityInteract(EntityInteract event) {
      this.deny(event, "use_entity");
   }

   @SubscribeEvent
   public void onEntityInteractSpecific(EntityInteractSpecific event) {
      this.deny(event, "use_entity");
   }

   @SubscribeEvent
   public void onUseItemStart(Start event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         if (BodySeized.is(player)) {
            event.setCanceled(true);
            this.log(player, "consume_item");
         }
      }
   }

   private <E extends PlayerInteractEvent & ICancellableEvent> void deny(E event, String what) {
      if (event.getEntity() instanceof ServerPlayer player) {
         if (BodySeized.is(player)) {
            event.setCanceled(true);
            this.log(player, what);
         }
      }
   }

   private void log(ServerPlayer player, String what) {
      if (player.tickCount % 20 == 0) {
         SymbioteLog.event("SEIZED_INTERACTION_BLOCKED player={} what={}", player.getUUID(), what);
      }
   }
}
