package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SafeShove;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class PredatorHunt {
   private static final int WILD_CHECK_PERIOD = 40;
   private static final float WILD_CHANCE = 0.25F;
   private static final int WILD_COOLDOWN = 2400;
   private static final int NIGHT_CHECK_PERIOD = 100;
   private static final float NIGHT_CHANCE = 0.06F;
   private static final int NIGHT_COOLDOWN = 4800;
   private static final double NIGHT_SCAN_RANGE = 16.0;
   private static final int HUNT_TIMEOUT = 600;
   private static final double GIVE_UP_DIST_SQR = 2304.0;
   private static final double MELEE_DIST = 3.4;
   private static final double LUNGE_MIN = 4.5;
   private static final double LUNGE_MAX = 13.0;
   private static final int LUNGE_COOLDOWN = 50;
   private static final int STRIKE_COOLDOWN = 10;
   private static final int AWARE_MIN = 60;
   private static final int AWARE_SPAN = 60;
   private static final int LOSE_SIGHT_TICKS = 100;
   private static final Map<UUID, PredatorHunt.Hunt> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> WILD_LAST = new HashMap<>();
   private static final Map<UUID, Long> NIGHT_LAST = new HashMap<>();

   public static boolean isHunting(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      UUID id = player.getUUID();
      if (p.strain == SymbioteStrain.PREDATOR && (Boolean)SymbioteConfig.PREDATOR_HUNT_ENABLED.get() && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
         PredatorHunt.Hunt h = ACTIVE.get(id);
         if (h != null) {
            drive(player, level, p, h, now);
         } else {
            maybeBegin(player, level, p, now);
         }
      } else {
         if (ACTIVE.containsKey(id)) {
            end(player, level, p, "gates");
         }
      }
   }

   private static void drive(ServerPlayer player, ServerLevel level, SymbioteProfile p, PredatorHunt.Hunt h, long now) {
      UUID id = player.getUUID();
      if (!(level.getEntity(h.targetId) instanceof LivingEntity target && target.isAlive())) {
         VoiceLines.send(player, "symbiote.voice.predator_kill", 3);
         SymbioteLog.event("PREDATOR_HUNT_END player={} reason=prey_down", id);
         end(player, level, p, null);
      } else if (now - h.startTick <= 600L && !(target.distanceToSqr(player) > 2304.0)) {
         boolean seen = hasLine(player, level, target);
         if (seen) {
            h.lastSeen = now;
         }

         if (h.committed && now - h.lastSeen > 100L) {
            SymbioteLog.event("PREDATOR_HUNT_END player={} reason=prey_buried", id);
            end(player, level, p, null);
         } else {
            if (now - h.lastGaze > 70L) {
               h.lastGaze = now;
               TendrilMantle.noteFixation(player, target);
               ModNetwork.sendOverrideFx(player, "gaze:" + target.getId(), 30);
            }

            if (h.committed) {
               double dist = player.distanceTo(target);
               if (dist > 3.4) {
                  if (!WalkSeizure.isActive(id) && now - h.lastRepath > 10L) {
                     h.lastRepath = now;
                     if (WalkSeizure.start(player, level, p, BlockPos.containing(target.position()), true)) {
                        h.walkFails = 0;
                     } else if (++h.walkFails >= 3) {
                        SymbioteLog.event("PREDATOR_HUNT_END player={} reason=no_path", id);
                        end(player, level, p, null);
                        return;
                     }
                  }

                  if (dist >= 4.5 && dist <= 13.0 && now - h.lastLunge > 50L && seen) {
                     h.lastLunge = now;
                     lunge(player, level, p, target);
                  }
               } else if (now - h.lastStrike > 10L && seen) {
                  h.lastStrike = now;
                  Vec3 chest = target.position().add(0.0, target.getBbHeight() * 0.5, 0.0);
                  if (TendrilMantle.strike(player, level, chest) == null) {
                     TendrilFxEntity.spawnWhip(level, player, target, 12, p.strain);
                  }

                  if (player.getRandom().nextFloat() < 0.45F) {
                     Vec3 chest2 = chest.add(player.getRandom().nextGaussian() * 0.4, 0.25, player.getRandom().nextGaussian() * 0.4);
                     if (TendrilMantle.strike(player, level, chest2) == null) {
                        TendrilFxEntity.spawnWhip(level, player, target, 12, p.strain);
                     }
                  }

                  boolean rival = WildHost.isInfected(target);
                  target.hurt(level.damageSources().playerAttack(player), (rival ? 7.5F : 6.0F) * (float)p.stageIntensity());
               }
            } else if (now >= h.commitAt) {
               if (now - h.lastSeen > 40L) {
                  end(player, level, p, "prey_hidden_at_commit");
               } else if (!OverrideGate.check(player, level, p, h.night ? "predator_night_prowl" : "predator_hunt")) {
                  end(player, level, p, "gate_at_commit");
               } else {
                  h.committed = true;
                  OverrideGate.seize(player, level, p, h.night ? "predator_night_prowl" : "predator_hunt");
                  LivingArmor.forceOn(player, level, p);
                  VoiceLines.send(player, h.night ? "symbiote.voice.predator_night" : "symbiote.voice.predator_hunt", 3);
                  WalkSeizure.start(player, level, p, BlockPos.containing(target.position()), true);
                  SymbioteLog.event("PREDATOR_HUNT_COMMIT player={} target={} kind={}", player.getUUID(), target.getType(), h.night ? "night" : "wild_host");
               }
            }
         }
      } else {
         SymbioteLog.event("PREDATOR_HUNT_END player={} reason=lost", id);
         end(player, level, p, null);
      }
   }

   private static void lunge(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity target) {
      Vec3 to = target.position().add(0.0, target.getBbHeight() * 0.5, 0.0).subtract(player.position().add(0.0, 1.0, 0.0));
      double len = to.length();
      if (!(len < 0.001)) {
         Vec3 dir = to.scale(1.0 / len);

         for (int i = 0; i < 2; i++) {
            Vec3 probe = player.position().add(dir.scale(2.0 + i * 2.5)).add(0.0, 1.0, 0.0);
            BlockHitResult hit = level.clip(new ClipContext(probe, probe.add(0.0, -4.0, 0.0), Block.COLLIDER, Fluid.NONE, player));
            if (hit.getType() == Type.BLOCK && TendrilMantle.timedJob(player, level, hit.getLocation(), 3, 8, 2, ItemStack.EMPTY) == null) {
               TendrilFxEntity fx = TendrilFxEntity.spawnGrabAtPoint(level, player, hit.getLocation(), 14, p.strain);
               fx.setReachTicksOverride(3);
            }
         }

         if (SafeShove.ok(player, level, dir)) {
            player.push(dir.x * 1.35, Math.max(0.32, dir.y * 1.1), dir.z * 1.35);
            player.hurtMarked = true;
            LeapFallProtection.tag(player.getUUID(), level.getGameTime());
            level.playSound(
               null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.PLAYERS, 0.7F, 1.05F
            );
            ModNetwork.sendOverrideFx(player, "tendril_burst", 12);
            SymbioteLog.event("PREDATOR_LUNGE player={} target={} dist={}", player.getUUID(), target.getType(), String.format("%.1f", player.distanceTo(target)));
         }
      }
   }

   private static boolean hasLine(ServerPlayer player, ServerLevel level, LivingEntity target) {
      return level.clip(
               new ClipContext(player.getEyePosition(), target.position().add(0.0, target.getBbHeight() * 0.5, 0.0), Block.COLLIDER, Fluid.NONE, player)
            )
            .getType()
         == Type.MISS;
   }

   private static void maybeBegin(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      UUID id = player.getUUID();
      if (!WalkSeizure.isActive(id) && !DeepSeizure.isActive(id)) {
         if (WildHost.enabled()
            && now % 40L == 11L
            && now - WILD_LAST.getOrDefault(id, -4611686018427387904L) > 2400L
            && WildHostSense.anyNear(id)
            && player.getRandom().nextFloat() < 0.25F) {
            LivingEntity prey = nearestSensedHost(player, level);
            if (prey != null && OverrideGate.check(player, level, p, "predator_hunt")) {
               WILD_LAST.put(id, now);
               begin(player, level, p, prey, false, now);
               return;
            }
         }

         if (now % 100L == 37L
            && level.isNight()
            && !player.isUnderWater()
            && now - NIGHT_LAST.getOrDefault(id, -4611686018427387904L) > 4800L
            && player.getRandom().nextFloat() < 0.06F) {
            Monster prey = nearestMonster(player, level);
            if (prey != null && OverrideGate.check(player, level, p, "predator_night_prowl")) {
               NIGHT_LAST.put(id, now);
               begin(player, level, p, prey, true, now);
            }
         }
      }
   }

   private static void begin(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity target, boolean night, long now) {
      long commitAt = now + 60L + player.getRandom().nextInt(60);
      ACTIVE.put(player.getUUID(), new PredatorHunt.Hunt(target.getId(), now, night, commitAt));
      TendrilMantle.noteFixation(player, target);
      ModNetwork.sendOverrideFx(player, "gaze:" + target.getId(), 40);
      VoiceLines.send(player, "symbiote.voice.predator_notice", 4);
      SymbioteLog.event(
         "PREDATOR_HUNT_AWARE player={} target={} kind={} commit_in={}", player.getUUID(), target.getType(), night ? "night" : "wild_host", commitAt - now
      );
   }

   private static LivingEntity nearestSensedHost(ServerPlayer player, ServerLevel level) {
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (int eid : WildHostSense.hostsNear(player.getUUID())) {
         if (level.getEntity(eid) instanceof LivingEntity le && le.isAlive() && WildHost.isInfected(le) && hasLine(player, level, le)) {
            double d = le.distanceToSqr(player);
            if (d < bestSq) {
               bestSq = d;
               best = le;
            }
         }
      }

      return best;
   }

   private static Monster nearestMonster(ServerPlayer player, ServerLevel level) {
      Monster best = null;
      double bestSq = Double.MAX_VALUE;

      for (Monster m : level.getEntitiesOfClass(
         Monster.class,
         player.getBoundingBox().inflate(16.0),
         e -> e.isAlive() && !WildHost.isInfected(e) && !e.isInWater() && !e.isUnderWater() && HostileTargets.mayOpenOn(e, player)
      )) {
         if (hasLine(player, level, m)) {
            double d = m.distanceToSqr(player);
            if (d < bestSq) {
               bestSq = d;
               best = m;
            }
         }
      }

      return best;
   }

   private static void end(ServerPlayer player, ServerLevel level, SymbioteProfile p, String logReason) {
      ACTIVE.remove(player.getUUID());
      if (WalkSeizure.isActive(player.getUUID())) {
         WalkSeizure.abort(player, level, p, "predator_hunt_end");
      }

      if (logReason != null) {
         SymbioteLog.event("PREDATOR_HUNT_END player={} reason={}", player.getUUID(), logReason);
      }
   }

   public static void onLogout(UUID id) {
      ACTIVE.remove(id);
      WILD_LAST.remove(id);
      NIGHT_LAST.remove(id);
   }

   private PredatorHunt() {
   }

   private static final class Hunt {
      final int targetId;
      final long startTick;
      final boolean night;
      final long commitAt;
      boolean committed;
      long lastLunge;
      long lastStrike;
      long lastRepath;
      long lastGaze;
      long lastSeen;
      int walkFails;

      Hunt(int targetId, long startTick, boolean night, long commitAt) {
         this.targetId = targetId;
         this.startTick = startTick;
         this.night = night;
         this.commitAt = commitAt;
         this.lastSeen = startTick;
      }
   }
}
