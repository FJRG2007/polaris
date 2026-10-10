package com.scout.symbiote.event;

import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.neoforge.event.entity.player.AttackEntityEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.BreakSpeed;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.EntityInteract;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.LeftClickBlock;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.RightClickBlock;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.RightClickItem;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class BloomLockListener {
   private static boolean locked(Player player) {
      if (!(player instanceof ServerPlayer sp)) {
         return false;
      } else {
         ServerLevel level = sp.serverLevel();
         SymbioteProfile p = SymbioteTracker.get(level).peek(sp.getUUID());
         return p != null && p.isBlooming(level.getGameTime());
      }
   }

   @SubscribeEvent
   public static void onAttack(AttackEntityEvent event) {
      if (locked(event.getEntity())) {
         event.setCanceled(true);
      }
   }

   @SubscribeEvent
   public static void onRightClickItem(RightClickItem event) {
      if (locked(event.getEntity())) {
         event.setCanceled(true);
      }
   }

   @SubscribeEvent
   public static void onRightClickBlock(RightClickBlock event) {
      if (locked(event.getEntity())) {
         event.setCanceled(true);
      }
   }

   @SubscribeEvent
   public static void onEntityInteract(EntityInteract event) {
      if (locked(event.getEntity())) {
         event.setCanceled(true);
      }
   }

   @SubscribeEvent
   public static void onLeftClickBlock(LeftClickBlock event) {
      if (locked(event.getEntity())) {
         event.setCanceled(true);
      }
   }

   @SubscribeEvent
   public static void onBreakSpeed(BreakSpeed event) {
      if (locked(event.getEntity())) {
         event.setNewSpeed(0.0F);
      }
   }

   @SubscribeEvent
   public static void onHurtNoop(LivingIncomingDamageEvent event) {
   }

   private BloomLockListener() {
   }
}
