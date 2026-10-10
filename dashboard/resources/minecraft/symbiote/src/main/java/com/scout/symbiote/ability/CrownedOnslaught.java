package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;

public final class CrownedOnslaught {
   private static final Map<UUID, int[]> CROWN = new HashMap<>();
   private static final int MAX_STRIKES_PER_VOLLEY = 2;

   public static void activate(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      p.onslaughtUntilTick = now + SymbioteConfig.ONSLAUGHT_DURATION_TICKS.get().intValue();
      int n = SymbioteConfig.ONSLAUGHT_TENDRILS.get();
      int life = SymbioteConfig.ONSLAUGHT_DURATION_TICKS.get() + 16 + 10;
      int[] ids = new int[n];

      for (int i = 0; i < n; i++) {
         float slot = crownSlot(i, n);
         TendrilFxEntity t = TendrilFxEntity.spawnCrownTendril(level, player, life, p.strain, slot);
         ids[i] = t.getId();
      }

      CROWN.put(player.getUUID(), ids);
      VoiceLines.send(player, "symbiote.voice.onslaught", 3);
      ModNetwork.sendOverrideFx(player, "bond_up", 30);
      SymbioteLog.event("STRAIN_ABILITY ability=crowned_onslaught player={} crown={} until={}", player.getUUID(), n, p.onslaughtUntilTick);
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (now < p.onslaughtUntilTick) {
         if (p.onslaughtUntilTick - now <= 16L) {
            retractCrown(player, level);
         }

         int interval = SymbioteConfig.ONSLAUGHT_STRIKE_INTERVAL.get();
         if (now % interval == 0L) {
            double range = SymbioteConfig.ONSLAUGHT_RANGE.get();
            AABB box = player.getBoundingBox().inflate(range);
            List<LivingEntity> hostiles = new ArrayList<>(
               level.getEntitiesOfClass(LivingEntity.class, box, e -> e != player && e.isAlive() && e instanceof Enemy && e.distanceToSqr(player) <= range * range)
            );
            if (!hostiles.isEmpty()) {
               hostiles.sort((x, y) -> Double.compare(x.distanceToSqr(player), y.distanceToSqr(player)));
               int strikes = Math.min(2, hostiles.size());
               float damage = SymbioteConfig.ONSLAUGHT_DAMAGE.get().floatValue() * (float)p.stageIntensity();
               DamageSource src = level.damageSources().playerAttack(player);

               for (int i = 0; i < strikes; i++) {
                  LivingEntity target = hostiles.get(i);
                  TendrilFxEntity.spawnWhip(level, player, target, 12, p.strain, true);
                  target.hurt(src, damage);
               }
            }
         }
      }
   }

   private static float crownSlot(int index, int count) {
      return count <= 1 ? 0.0F : -1.0F + 2.0F * index / (count - 1);
   }

   private static void retractCrown(ServerPlayer player, ServerLevel level) {
      int[] ids = CROWN.get(player.getUUID());
      if (ids != null) {
         for (int id : ids) {
            if (level.getEntity(id) instanceof TendrilFxEntity t && t.getRetractStartTick() == 0) {
               t.setRetractStartTick(t.tickCount);
            }
         }
      }
   }

   public static void clear(UUID uuid) {
      CROWN.remove(uuid);
   }

   private CrownedOnslaught() {
   }
}
