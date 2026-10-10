package com.scout.symbiote.util;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;

public final class CombatSense {
   public static final int DEFAULT_WINDOW_TICKS = 100;
   private static final Map<UUID, Long> LAST_COMBAT = new HashMap<>();
   private static final Map<UUID, Map<Integer, Long>> AGGRESSORS = new HashMap<>();
   private static final int AGGRESSOR_WINDOW_TICKS = 600;

   public static void noteAggressor(ServerPlayer player, LivingEntity attacker) {
      AGGRESSORS.computeIfAbsent(player.getUUID(), k -> new HashMap<>()).put(attacker.getId(), player.serverLevel().getGameTime());
   }

   public static boolean isAggressor(UUID player, Entity entity, long now) {
      Map<Integer, Long> m = AGGRESSORS.get(player);
      if (m == null) {
         return false;
      } else {
         Long t = m.get(entity.getId());
         if (t == null) {
            return false;
         } else if (now - t >= 600L) {
            m.remove(entity.getId());
            return false;
         } else {
            return true;
         }
      }
   }

   public static void note(ServerPlayer player) {
      LAST_COMBAT.put(player.getUUID(), player.serverLevel().getGameTime());
   }

   public static boolean inCombat(ServerPlayer player) {
      return inCombat(player, 100);
   }

   public static boolean inCombat(ServerPlayer player, int windowTicks) {
      Long t = LAST_COMBAT.get(player.getUUID());
      return t != null && player.serverLevel().getGameTime() - t < windowTicks;
   }

   public static void onLogout(UUID player) {
      LAST_COMBAT.remove(player);
      AGGRESSORS.remove(player);
   }

   private CombatSense() {
   }
}
