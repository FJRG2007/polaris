package com.scout.symbiote.override;

import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.SymbioteFeedingHunt;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.TendrilYank;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.phys.AABB;

public final class HungerOverride {
   private static final int TICK_INTERVAL = 20;
   private static final int STALK_COMMIT_TICKS = 600;
   private static final int STALK_MAX_REPATHS = 5;
   private static final int STALK_STUCK_TICKS = 140;
   private static final Map<UUID, Map<Integer, Long>> FAILED_PREY = new HashMap<>();
   private static final int FAILED_PREY_MEMORY = 6000;
   private static final Map<UUID, HungerOverride.Stalk> STALK = new HashMap<>();
   private static final Map<UUID, Long> STALK_NEXT_TRY = new HashMap<>();
   private static final int STALK_RETRY_COOLDOWN = 600;

   public static boolean shouldTick(long worldTick) {
      return worldTick % 20L == 0L;
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      tickStalk(player, level, p);
      if (OverrideGate.check(player, level, p, "hunger_override")) {
         if (p.isStarving()) {
            if (!SymbioteFeedingHunt.isHunting(player.getUUID())) {
               if (!WalkSeizure.isActive(player.getUUID()) && !DeepSeizure.isActive(player.getUUID())) {
                  LivingEntity hostile = pickHostile(player, level);
                  if (hostile != null) {
                     if (hostile.getMaxHealth() <= SymbioteConfig.CONSUME_MAX_TARGET_HP.get() && SymbioteFeedingHunt.startTargeted(player, level, p, hostile)) {
                        OverrideGate.seize(player, level, p, "hunger_override");
                     } else {
                        biteInPlace(player, level, p, hostile);
                     }
                  } else if (SymbioteFeedingHunt.start(player, level, p)) {
                     OverrideGate.seize(player, level, p, "hunger_override");
                  } else if (!startStalk(player, level, p)) {
                     SymbioteLog.overrideSkipped(player.getUUID(), "hunger_override", "no_target");
                     VoiceLines.send(player, "symbiote.voice.hunger_starving", 3);
                  }
               }
            }
         }
      }
   }

   private static void blacklistPrey(UUID player, int preyId, long now) {
      FAILED_PREY.computeIfAbsent(player, k -> new HashMap<>()).put(preyId, now + 6000L);
   }

   private static boolean preyBlacklisted(UUID player, int preyId, long now) {
      Map<Integer, Long> m = FAILED_PREY.get(player);
      if (m == null) {
         return false;
      } else {
         Long until = m.get(preyId);
         if (until == null) {
            return false;
         } else if (now >= until) {
            m.remove(preyId);
            return false;
         } else {
            return true;
         }
      }
   }

   private static double stalkEatDist() {
      return Math.min(7.0, SymbioteConfig.HUNGER_OVERRIDE_SEARCH_RANGE.get() - 1.0);
   }

   private static boolean startStalk(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      double range = (Double)SymbioteConfig.HUNGER_STALK_RANGE.get();
      if (range <= 0.0 || STALK.containsKey(player.getUUID())) {
         return false;
      } else if (!p.stage.isAtLeast(BondStage.INTEGRATED)) {
         return false;
      } else {
         long now = level.getGameTime();
         Long next = STALK_NEXT_TRY.get(player.getUUID());
         if (next != null && now < next) {
            return false;
         } else if (CombatSense.inCombat(player)) {
            return false;
         } else {
            LivingEntity prey = pickStalkTarget(player, level, range);
            if (prey == null) {
               return false;
            } else if (!WalkSeizure.start(player, level, p, prey.blockPosition(), true)) {
               STALK_NEXT_TRY.put(player.getUUID(), now + 600L);
               return false;
            } else {
               STALK.put(player.getUUID(), new HungerOverride.Stalk(prey.getId(), now + 600L, prey.blockPosition(), now));
               VoiceLines.send(player, "symbiote.voice.stalk", 3);
               SymbioteLog.event(
                  "HUNGER_STALK_START player={} prey={} dist={}", player.getUUID(), prey.getType(), String.format("%.1f", prey.distanceTo(player))
               );
               return true;
            }
         }
      }
   }

   public static boolean isStalking(UUID player) {
      return STALK.containsKey(player);
   }

   private static void tickStalk(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      HungerOverride.Stalk stalk = STALK.get(player.getUUID());
      if (stalk != null) {
         int preyId = stalk.preyId;
         long now = level.getGameTime();
         boolean walking = WalkSeizure.isActive(player.getUUID());
         if (walking && level.getEntity(preyId) instanceof LivingEntity marchPrey) {
            Iterator var15 = level.getEntitiesOfClass(
                  LivingEntity.class,
                  player.getBoundingBox().inflate(3.0),
                  e -> e != player
                     && e != marchPrey
                     && e.isAlive()
                     && !(e instanceof ServerPlayer)
                     && e.getMaxHealth() <= SymbioteConfig.CONSUME_MAX_TARGET_HP.get()
                     && (!(Boolean)SymbioteConfig.PROTECT_ALLIES.get() || !(e instanceof TamableAnimal t && t.isTame()) && !e.hasCustomName())
               )
               .iterator();
            if (var15.hasNext()) {
               LivingEntity blocker = (LivingEntity)var15.next();
               if (TendrilMantle.strike(player, level, blocker.position().add(0.0, blocker.getBbHeight() * 0.5, 0.0)) == null) {
                  TendrilFxEntity.spawnWhip(level, player, blocker, 12, p.strain);
               }

               blocker.hurt(level.damageSources().playerAttack(player), 7.0F * (float)p.stageIntensity());
               if (!blocker.isAlive()) {
                  SymbioteTracker.adjustHunger(level, player, 4, "hunger_march_bite");
               }

               SymbioteLog.event("HUNGER_MARCH_BITE player={} blocker={} killed={}", player.getUUID(), blocker.getType(), !blocker.isAlive());
            }
         }

         if (level.getEntity(preyId) instanceof LivingEntity prey && prey.isAlive()) {
            if (player.distanceToSqr(prey) < 196.0 && player.hasLineOfSight(prey)) {
               ModNetwork.sendOverrideFx(player, "preylock:" + prey.getId(), 30);
            }

            double eatDist = stalkEatDist();
            if (player.distanceToSqr(prey) <= eatDist * eatDist && player.hasLineOfSight(prey)) {
               WalkSeizure.abort(player, level, p, "prey_reached");
               boolean ate = SymbioteFeedingHunt.startTargeted(player, level, p, prey);
               if (ate) {
                  OverrideGate.seize(player, level, p, "hunger_override");
               }

               if (ate) {
                  STALK.remove(player.getUUID());
                  STALK_NEXT_TRY.put(player.getUUID(), now + 200L);
                  SymbioteLog.event("HUNGER_STALK_ARRIVED player={} prey={}", player.getUUID(), prey.getType());
               }
            } else {
               double distSq = player.distanceToSqr(prey);
               if (distSq < stalk.bestDistSq - 1.0) {
                  stalk.bestDistSq = distSq;
                  stalk.lastProgress = now;
               }

               boolean stuck = now - stalk.lastProgress > 140L;
               if (stuck || now >= stalk.commitUntil || stalk.repaths >= 5) {
                  STALK.remove(player.getUUID());
                  blacklistPrey(player.getUUID(), stalk.preyId, now);
                  WalkSeizure.abort(player, level, p, "stalk_unreachable");
                  STALK_NEXT_TRY.put(player.getUUID(), now + 600L);
                  SymbioteLog.event(
                     "HUNGER_STALK_FAILED player={} reason={} repaths={}", player.getUUID(), stuck ? "no_progress" : "unreachable", stalk.repaths
                  );
               } else if (!walking) {
                  if (now - stalk.lastRepath >= 40L) {
                     stalk.lastRepath = now;
                     stalk.lastTarget = prey.blockPosition();
                     stalk.repaths++;
                     if (WalkSeizure.start(player, level, p, stalk.lastTarget, true)) {
                        SymbioteLog.event("HUNGER_STALK_REPATH player={} attempt={} cause=walk_ended", player.getUUID(), stalk.repaths);
                     } else {
                        STALK.remove(player.getUUID());
                        STALK_NEXT_TRY.put(player.getUUID(), now + 600L);
                        SymbioteLog.event("HUNGER_STALK_FAILED player={} reason=walk_refused", player.getUUID());
                     }
                  }
               } else {
                  if (prey.blockPosition().distSqr(stalk.lastTarget) > 16.0 && now - stalk.lastRepath >= 60L) {
                     stalk.lastRepath = now;
                     stalk.lastTarget = prey.blockPosition();
                     stalk.repaths++;
                     WalkSeizure.abort(player, level, p, "stalk_retarget");
                     if (WalkSeizure.start(player, level, p, stalk.lastTarget, true)) {
                        SymbioteLog.event("HUNGER_STALK_REPATH player={} attempt={} cause=prey_moved", player.getUUID(), stalk.repaths);
                     }
                  }
               }
            }
         } else {
            STALK.remove(player.getUUID());
            WalkSeizure.abort(player, level, p, "prey_gone");
            STALK_NEXT_TRY.put(player.getUUID(), now + 600L);
         }
      }
   }

   private static LivingEntity pickStalkTarget(ServerPlayer player, ServerLevel level, double range) {
      boolean protectAllies = (Boolean)SymbioteConfig.PROTECT_ALLIES.get();
      long now = level.getGameTime();
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (Mob m : level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(range), LivingEntity::isAlive)) {
         if (!(Math.abs(m.getY() - player.getY()) > 6.0) && !preyBlacklisted(player.getUUID(), m.getId(), now)) {
            boolean edible = m instanceof Enemy || m instanceof Animal || m instanceof Villager;
            if (edible
               && (!protectAllies || !(m instanceof TamableAnimal tamable && tamable.isTame()) && !m.hasCustomName())
               && !(m.getMaxHealth() > SymbioteConfig.CONSUME_MAX_TARGET_HP.get())
               && TendrilYank.haulable(m)) {
               double d = m.distanceToSqr(player);
               if (d < bestSq) {
                  bestSq = d;
                  best = m;
               }
            }
         }
      }

      return best;
   }

   public static boolean forceTrigger(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.stage.isBonded()) {
         return false;
      }

      if (SymbioteFeedingHunt.isHunting(player.getUUID())) {
         return false;
      }

      LivingEntity hostile = pickHostile(player, level);
      if (hostile != null) {
         if (hostile.getMaxHealth() <= SymbioteConfig.CONSUME_MAX_TARGET_HP.get() && SymbioteFeedingHunt.startTargeted(player, level, p, hostile)) {
            OverrideGate.stamp(level, p);
            return true;
         } else {
            biteInPlace(player, level, p, hostile);
            return true;
         }
      } else if (SymbioteFeedingHunt.start(player, level, p)) {
         OverrideGate.stamp(level, p);
         return true;
      } else {
         VoiceLines.send(player, "symbiote.voice.hunger_starving", 3);
         SymbioteLog.overrideSkipped(player.getUUID(), "hunger_override", "debug_no_target");
         return false;
      }
   }

   private static void biteInPlace(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity target) {
      DamageSource src = level.damageSources().playerAttack(player);
      float damage = 8.0F;
      target.hurt(src, damage);
      boolean killed = !target.isAlive();
      int hungerGain = killed ? SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get() * 3 : SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get();
      SymbioteTracker.adjustHunger(level, player, hungerGain, "hunger_override_bite");
      SymbioteTracker.adjustTrust(level, player, 1, "trust_override_helped");
      SymbioteCuriosity.noteTaste(player, level, target);
      OverrideGate.seize(player, level, p, "hunger_override");
      ModNetwork.sendOverrideFx(player, "vignette_red", 25);
      VoiceLines.send(player, "symbiote.voice.hunger_override", 3);
      SymbioteLog.overrideFired(player.getUUID(), "hunger_override", "hostile_bite", "target", target.getType(), "killed", killed, "hunger_gain", hungerGain);
   }

   private static LivingEntity pickHostile(ServerPlayer player, ServerLevel level) {
      double range = SymbioteConfig.HUNGER_OVERRIDE_SEARCH_RANGE.get();
      AABB box = player.getBoundingBox().inflate(range);
      List<Mob> mobs = level.getEntitiesOfClass(Mob.class, box, LivingEntity::isAlive);
      LivingEntity hostile = null;
      double bestDist = Double.MAX_VALUE;

      for (Mob m : mobs) {
         if (m instanceof Enemy && TendrilYank.haulable(m) && HostileTargets.mayOpenOn(m, player) && player.hasLineOfSight(m)) {
            double d = m.distanceToSqr(player);
            if (d < bestDist) {
               bestDist = d;
               hostile = m;
            }
         }
      }

      return hostile;
   }

   public static void onLogout(UUID player) {
      STALK.remove(player);
      STALK_NEXT_TRY.remove(player);
      FAILED_PREY.remove(player);
   }

   private HungerOverride() {
   }

   private static final class Stalk {
      final int preyId;
      final long commitUntil;
      long lastRepath;
      BlockPos lastTarget;
      int repaths;
      double bestDistSq = Double.MAX_VALUE;
      long lastProgress;

      Stalk(int preyId, long commitUntil, BlockPos target, long now) {
         this.preyId = preyId;
         this.commitUntil = commitUntil;
         this.lastTarget = target;
         this.lastRepath = now;
         this.lastProgress = now;
      }
   }
}
