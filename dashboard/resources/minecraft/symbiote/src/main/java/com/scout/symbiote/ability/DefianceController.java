package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SafeShove;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;

public final class DefianceController {
   private static final Map<UUID, Long> STRUGGLE_LAST = new HashMap<>();
   private static final int STRUGGLE_MIN_GAP = 4800;

   public static boolean shouldDefyCommand(SymbioteProfile p) {
      if (!p.stage.isAtLeast(BondStage.COOPERATIVE)) {
         return false;
      }

      double base = SymbioteConfig.DEFIANCE_BASE_CHANCE.get();
      double stageScale = p.stage == BondStage.DOMINANT ? 1.8 : 1.0;
      double trustScale = 1.7 - p.trust / 100.0 * 1.4;
      double strainScale = StrainTraits.defianceMult(p.strain);
      double moodScale = MoodEngine.defianceScale(p);
      double chance = Math.min(0.95, base * stageScale * trustScale * strainScale * moodScale);
      return Math.random() < chance;
   }

   public static void tickAction(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if ((Boolean)SymbioteConfig.DEFIANCE_SHOVES.get()) {
         if (p.stage.isAtLeast(BondStage.COOPERATIVE)) {
            if (!SymbioteMolt.isMolting(p, now)) {
               int interval = SymbioteConfig.DEFIANCE_ACTION_INTERVAL_TICKS.get();
               if (p.stage == BondStage.DOMINANT) {
                  interval = Math.max(100, interval / 2);
               }

               if (now - p.lastDefianceActionTick >= interval) {
                  double fireChance = (0.25 + p.stress / 100.0 * 0.4) * MoodEngine.defianceScale(p);
                  if (Math.random() > fireChance) {
                     p.lastDefianceActionTick = now - (long)(interval * 0.6);
                  } else {
                     p.lastDefianceActionTick = now;
                     LivingEntity prey = nearestSeizeTarget(player, level);
                     if (prey != null) {
                        if (!SafeShove.toward(player, level, prey.position(), 0.5, 0.1)) {
                           SafeShove.hitch(player);
                        }

                        SymbioteLog.event("DEFIANCE_ACTION player={} type=lunge target={}", player.getUUID(), prey.getType());
                     } else {
                        SafeShove.hitch(player);
                        SymbioteLog.event("DEFIANCE_ACTION player={} type=twitch", player.getUUID());
                     }

                     VoiceLines.send(player, "symbiote.voice.defiance_action", 3);
                     ModNetwork.sendOverrideFx(player, "vignette_black", 12);
                  }
               }
            }
         }
      }
   }

   public static void maybeControlStruggle(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if ((Boolean)SymbioteConfig.CONTROL_STRUGGLES.get()) {
         if (p.stage == BondStage.DOMINANT) {
            if (!SymbioteMolt.isMolting(p, now)) {
               if (now % 200L == 0L) {
                  if (now - STRUGGLE_LAST.getOrDefault(player.getUUID(), -4611686018427387904L) >= 4800L) {
                     if (!(Math.random() > Math.min(0.35, 0.15 * MoodEngine.defianceScale(p)))) {
                        STRUGGLE_LAST.put(player.getUUID(), now);
                        player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 30, 2, false, false));
                        VoiceLines.send(player, "symbiote.voice.control_struggle", 4);
                        ModNetwork.sendOverrideFx(player, "vignette_black", 30);
                        SymbioteTracker.adjustStress(level, player, 5, "control_struggle");
                        SymbioteLog.event("CONTROL_STRUGGLE player={}", player.getUUID());
                     }
                  }
               }
            }
         }
      }
   }

   private static LivingEntity nearestSeizeTarget(ServerPlayer player, ServerLevel level) {
      AABB box = player.getBoundingBox().inflate(6.0);
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, box, en -> en != player && en.isAlive() && (en instanceof Enemy || en instanceof Animal))) {
         double d = e.distanceToSqr(player);
         if (d < bestSq) {
            bestSq = d;
            best = e;
         }
      }

      return best;
   }

   private DefianceController() {
   }
}
