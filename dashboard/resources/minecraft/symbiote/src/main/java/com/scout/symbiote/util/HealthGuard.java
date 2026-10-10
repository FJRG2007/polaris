package com.scout.symbiote.util;

import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;

public final class HealthGuard {
   public static float lethal(LivingEntity target) {
      float needed = finite(target.getMaxHealth(), 20.0F) + finite(target.getAbsorptionAmount(), 0.0F) + 32.0F;
      return Math.min(needed, 4096.0F) * 8.0F;
   }

   public static float finite(float value, float fallback) {
      return Float.isFinite(value) ? value : fallback;
   }

   public static boolean repair(LivingEntity target) {
      boolean broken = false;
      if (!Float.isFinite(target.getAbsorptionAmount())) {
         target.setAbsorptionAmount(0.0F);
         broken = true;
      }

      float max = target.getMaxHealth();
      if (!Float.isFinite(max) || max <= 0.0F) {
         max = 20.0F;
      }

      float health = target.getHealth();
      if (!Float.isFinite(health)) {
         target.setHealth(Math.max(1.0F, max * 0.5F));
         broken = true;
      } else if (health > max) {
         target.setHealth(max);
         broken = true;
      }

      return broken;
   }

   public static void repairAndLog(LivingEntity target) {
      if (repair(target)) {
         SymbioteLog.event("HEALTH_REPAIRED entity={} id={} health={}", target.getType(), target.getId(), target.getHealth());
      }
   }

   public static void repairAndLog(Player player) {
      if (repair(player)) {
         SymbioteLog.event("HEALTH_REPAIRED player={} health={} absorption={}", player.getUUID(), player.getHealth(), player.getAbsorptionAmount());
      }
   }

   private HealthGuard() {
   }
}
