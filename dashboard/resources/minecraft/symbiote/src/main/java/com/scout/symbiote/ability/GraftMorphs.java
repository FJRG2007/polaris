package com.scout.symbiote.ability;

import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.GraftState;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.Optional;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.Vec3;

public final class GraftMorphs {
   private static final int COOLDOWN = 60;
   private static final int MORPH_TICKS = 24;
   private static final int WHIP_TICKS = 14;
   private static final double STRIKE_RANGE = 6.0;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      GraftState g = p.graft;
      if (g != null) {
         if (now - g.lastActTick >= 60L) {
            if (!TendrilSceneController.isInScene(player.getUUID())) {
               if (CombatSense.inCombat(player)) {
                  LivingEntity threat = nearestThreat(player, level);
                  if (threat != null) {
                     if (willing(g, level)) {
                        strike(player, level, g, threat, now);
                     }
                  }
               }
            }
         }
      }
   }

   public static boolean request(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      GraftState g = p.graft;
      if (g == null) {
         return false;
      }

      long now = level.getGameTime();
      if (now - g.lastActTick < 60L) {
         return false;
      }

      if (!willing(g, level)) {
         g.lastActTick = now;
         VoiceLines.sendAs(player, "symbiote.voice.graft_refuse_ask", 2, g.strain);
         SymbioteLog.event("GRAFT_MORPH_REFUSED player={} hunger={} tension={}", player.getUUID(), g.hunger, g.tension);
         return false;
      }

      LivingEntity threat = lookedAt(player, level);
      if (threat == null) {
         threat = nearestThreat(player, level);
      }

      if (threat == null) {
         return false;
      }

      strike(player, level, g, threat, now);
      return true;
   }

   private static void strike(ServerPlayer player, ServerLevel level, GraftState g, LivingEntity target, long now) {
      g.lastActTick = now;
      g.addHunger(-2);
      TendrilFxEntity.spawnWhip(level, player, target, 14, g.strain);
      target.hurt(level.damageSources().playerAttack(player), g.isStarving() ? 4.0F : 7.0F);
      ModNetwork.sendOverrideFx(player, "morph:blade", 24);
      SymbioteLog.event("GRAFT_STRIKE player={} target={} hunger={} tension={}", player.getUUID(), target.getId(), g.hunger, g.tension);
   }

   private static boolean willing(GraftState g, ServerLevel level) {
      double chance = 0.9;
      if (g.isStarving()) {
         chance -= 0.5;
      }

      if (g.tension >= 60) {
         chance -= 0.25;
      }

      if (g.tension >= 85) {
         chance -= 0.25;
      }

      return level.random.nextDouble() < Math.max(0.05, chance);
   }

   private static LivingEntity nearestThreat(ServerPlayer player, ServerLevel level) {
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(
         LivingEntity.class, player.getBoundingBox().inflate(6.0), en -> en != player && en.isAlive() && en instanceof Enemy && player.hasLineOfSight(en)
      )) {
         double d = e.distanceToSqr(player);
         if (d < bestSq) {
            bestSq = d;
            best = e;
         }
      }

      return best;
   }

   private static LivingEntity lookedAt(ServerPlayer player, ServerLevel level) {
      Vec3 eye = player.getEyePosition();
      Vec3 end = eye.add(player.getLookAngle().scale(6.0));
      LivingEntity best = null;
      double bestDist = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(6.0), en -> en != player && en.isAlive() && player.hasLineOfSight(en))) {
         Optional<Vec3> hit = e.getBoundingBox().inflate(0.35).clip(eye, end);
         if (!hit.isEmpty()) {
            double d = eye.distanceToSqr(hit.get());
            if (d < bestDist) {
               bestDist = d;
               best = e;
            }
         }
      }

      return best;
   }

   private GraftMorphs() {
   }
}
