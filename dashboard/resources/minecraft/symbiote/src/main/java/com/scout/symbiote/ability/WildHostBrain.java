package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.event.WildHostSpawnListener;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.util.DefaultRandomPos;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.Vec3;

public final class WildHostBrain {
   private static final Map<Integer, WildHostBrain.Mind> MINDS = new HashMap<>();
   private static final Map<UUID, long[]> YANKS = new HashMap<>();
   private static final double YANK_SPEED = 0.78;
   private static final int YANK_TICKS = 16;
   private static final double NOTICE = 24.0;
   private static final double STALK_HOLD = 9.0;
   private static final double STRIKE_RANGE = 12.0;
   private static final int WATCH_TICKS = 60;
   private static final int PATIENCE = 600;
   private static final int WITHDRAW_TICKS = 400;
   private static final float FLEE_HEALTH = 0.4F;
   private static final int PROVOKE_TICKS = 1200;
   private static final int INFECT_STALK_TICKS = 900;
   private static final float INFECT_CHANCE = 0.35F;
   private static final int IGNORE_TICKS = 6000;
   private static final double INFECT_CLOSE = 2.6;
   private static final Map<Integer, long[]> PROVOKED = new HashMap<>();
   private static final Map<Long, Long> IGNORE = new HashMap<>();
   private static final Map<Integer, Integer> ATTENTIVE = new HashMap<>();
   private static final int INTERVAL = 10;
   private static final double TENDRIL_REACH = 7.0;
   private static final int STRIKE_COOLDOWN = 30;
   private static final int LUNGE_COOLDOWN = 140;
   private static final int FEED_COOLDOWN = 600;

   public static void tickLook(ServerLevel level) {
      if (WildHost.enabled()) {
         if (!ATTENTIVE.isEmpty()) {
            ATTENTIVE.entrySet().removeIf(e -> {
               if (!(level.getEntity(e.getKey()) instanceof Mob mob && mob.isAlive())) {
                  return true;
               } else if (level.getEntity(e.getValue()) instanceof LivingEntity t && t.isAlive()) {
                  mob.getLookControl().setLookAt(t, 30.0F, 30.0F);
                  return false;
               } else {
                  return true;
               }
            });
         }
      }
   }

   public static boolean isIdle(int mobId) {
      return stateOf(mobId) == WildHostBrain.State.DORMANT && !ATTENTIVE.containsKey(mobId);
   }

   public static void provoke(LivingEntity mob, ServerPlayer by, long now) {
      PROVOKED.put(mob.getId(), new long[]{by.getId(), now + 1200L, now});
   }

   private static boolean provokedBy(int mobId, int playerId, long now) {
      long[] g = PROVOKED.get(mobId);
      return g != null && g[0] == playerId && now < g[1];
   }

   private static boolean provokedFresh(int mobId, int playerId, long now) {
      long[] g = PROVOKED.get(mobId);
      return g != null && g[0] == playerId && now < g[1] && now - g[2] < 200L;
   }

   private static long pairKey(int mobId, int playerId) {
      return (long)mobId << 32 | playerId & 4294967295L;
   }

   private static boolean isBonded(ServerPlayer player, ServerLevel level) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      return p != null && p.stage.isBonded();
   }

   public static void tickAll(ServerLevel level) {
      if (WildHost.enabled()) {
         if (level.getGameTime() % 10L == 0L) {
            if (!level.players().isEmpty()) {
               for (ServerPlayer player : level.players()) {
                  if (!player.isSpectator() && !player.isCreative()) {
                     for (PathfinderMob mob : level.getEntitiesOfClass(
                        PathfinderMob.class,
                        player.getBoundingBox().inflate(32.0),
                        m -> m.isAlive()
                           && WildHost.isInfected(m)
                           && !(m instanceof Enemy)
                           && !WildHostSpawnListener.isAquatic(m)
                           && !WildHostSpawnListener.isAirborne(m)
                     )) {
                        tick(mob, player, level);
                     }
                  }
               }

               MINDS.keySet().removeIf(id -> level.getEntity(id) == null);
               ATTENTIVE.keySet().removeIf(id -> level.getEntity(id) == null);
               PROVOKED.entrySet().removeIf(e -> level.getGameTime() >= e.getValue()[1] || level.getEntity(e.getKey()) == null);
               IGNORE.values().removeIf(until -> until < level.getGameTime());
            }
         }
      }
   }

   private static void tick(PathfinderMob mob, ServerPlayer player, ServerLevel level) {
      WildHostBrain.Mind mind = MINDS.computeIfAbsent(mob.getId(), k -> new WildHostBrain.Mind());
      long now = level.getGameTime();
      double dist = Math.sqrt(mob.distanceToSqr(player));
      boolean sees = mob.hasLineOfSight(player);
      long held = now - mind.since;
      boolean preyMode = isBonded(player, level) || provokedBy(mob.getId(), player.getId(), now);
      if (preyMode && mind.infectIntent) {
         mind.infectIntent = false;
      }

      if (preyMode
         && mind.state != WildHostBrain.State.STRIKING
         && mind.state != WildHostBrain.State.WITHDRAWING
         && provokedFresh(mob.getId(), player.getId(), now)) {
         set(mind, WildHostBrain.State.STRIKING, now, mob, player);
      }

      switch (mind.state) {
         case DORMANT:
            if ((WildHost.dispositionOf(mob) != WildHost.Disposition.FEEDER || now - mind.lastFeed <= 600L || !feed(mob, level, mind, now))
               && dist <= 24.0
               && sees) {
               if (preyMode) {
                  set(mind, WildHostBrain.State.WATCHING, now, mob, player);
               } else if (SymbioteConfig.WILD_HOST_LEAP_ENABLED.get()
                  && !isBonded(player, level)
                  && IGNORE.getOrDefault(pairKey(mob.getId(), player.getId()), 0L) < now) {
                  mind.infectIntent = true;
                  set(mind, WildHostBrain.State.WATCHING, now, mob, player);
               }
            }
            break;
         case WATCHING:
            mob.getNavigation().stop();
            mob.getLookControl().setLookAt(player, 30.0F, 30.0F);
            mob.setTarget(null);
            if (!(dist > 24.0) && sees) {
               if (WildHost.dispositionOf(mob) != WildHost.Disposition.WATCHER) {
                  if (mind.infectIntent) {
                     if (held > 60L) {
                        set(mind, WildHostBrain.State.STALKING, now, mob, player);
                     }
                  } else if (opening(mob, player, level, held)) {
                     set(mind, WildHostBrain.State.STRIKING, now, mob, player);
                  } else if (held > 60L) {
                     set(mind, WildHostBrain.State.STALKING, now, mob, player);
                  }
               }
            } else {
               set(mind, WildHostBrain.State.DORMANT, now, mob, player);
            }
            break;
         case STALKING:
            mob.setTarget(null);
            mob.getLookControl().setLookAt(player, 30.0F, 30.0F);
            if (!(dist > 30.0) && (sees || held <= 200L)) {
               if (mind.infectIntent) {
                  if (held > 900L) {
                     if (mob.getRandom().nextFloat() < 0.35F) {
                        SymbioteLog.event("WILD_HOST_INFECT_DECIDED entity={} player={}", mob.getId(), player.getUUID());
                        set(mind, WildHostBrain.State.STRIKING, now, mob, player);
                     } else {
                        SymbioteLog.event("WILD_HOST_INFECT_DECLINED entity={} player={}", mob.getId(), player.getUUID());
                        mind.infectIntent = false;
                        IGNORE.put(pairKey(mob.getId(), player.getId()), now + 6000L);
                        set(mind, WildHostBrain.State.WITHDRAWING, now, mob, player);
                     }
                  } else {
                     hold(mob, player, dist);
                  }
               } else if (opening(mob, player, level, held)) {
                  set(mind, WildHostBrain.State.STRIKING, now, mob, player);
               } else {
                  hold(mob, player, dist);
               }
            } else {
               set(mind, WildHostBrain.State.DORMANT, now, mob, player);
            }
            break;
         case STRIKING:
            if (mind.infectIntent) {
               mob.setTarget(null);
               if (dist > 30.0) {
                  set(mind, WildHostBrain.State.DORMANT, now, mob, player);
               } else if (dist <= 2.6) {
                  SymbioteLog.event("WILD_HOST_INFECT_LEAP entity={} player={}", mob.getId(), player.getUUID());
                  WildHost.markForcedLeap(mob);
                  mob.hurt(level.damageSources().genericKill(), HealthGuard.lethal(mob));
               } else {
                  mob.getNavigation().moveTo(player, 1.25);
               }
            } else {
               mob.setTarget(player);
               mob.getLookControl().setLookAt(player, 30.0F, 30.0F);
               if (mob.getHealth() / mob.getMaxHealth() < 0.4F) {
                  set(mind, WildHostBrain.State.WITHDRAWING, now, mob, player);
               } else if (dist > 24.0) {
                  set(mind, WildHostBrain.State.DORMANT, now, mob, player);
               } else if (dist <= 7.0) {
                  if (now - mind.lastStrike >= 30L) {
                     strike(mob, player, level, mind, now);
                  }
               } else if (now - mind.lastLunge >= 140L) {
                  lunge(mob, player, level, mind, now);
               } else {
                  mob.getNavigation().moveTo(player, 1.1);
               }
            }
            break;
         case WITHDRAWING:
            mob.setTarget(null);
            if (held < 400L) {
               if (held < 6L && now - mind.lastLunge >= 20L) {
                  launchAway(mob, player, level, mind, now);
               }

               flee(mob, player);
            } else {
               set(mind, WildHostBrain.State.DORMANT, now, mob, player);
            }
      }
   }

   private static boolean opening(PathfinderMob mob, ServerPlayer player, ServerLevel level, long held) {
      if (Math.sqrt(mob.distanceToSqr(player)) > 12.0) {
         return false;
      } else {
         Vec3 look = player.getLookAngle().normalize();
         Vec3 toward = mob.position().subtract(player.position()).normalize();
         boolean backTurned = look.dot(toward) < 0.1;
         if (backTurned) {
            return true;
         } else if (player.getHealth() / player.getMaxHealth() <= 0.6F) {
            return true;
         } else {
            return level.getMaxLocalRawBrightness(mob.blockPosition()) <= 6 ? true : held > 600L;
         }
      }
   }

   private static void hold(PathfinderMob mob, ServerPlayer player, double dist) {
      if (Math.abs(dist - 9.0) < 2.0) {
         mob.getNavigation().stop();
      } else {
         if (dist > 9.0) {
            Vec3 toward = player.position().subtract(mob.position()).normalize();
            Vec3 goal = player.position().subtract(toward.scale(9.0));
            mob.getNavigation().moveTo(goal.x, goal.y, goal.z, 0.85);
         } else {
            Vec3 away = DefaultRandomPos.getPosAway(mob, 8, 4, player.position());
            if (away != null) {
               mob.getNavigation().moveTo(away.x, away.y, away.z, 0.9);
            }
         }
      }
   }

   private static void flee(PathfinderMob mob, ServerPlayer from) {
      Vec3 away = DefaultRandomPos.getPosAway(mob, 16, 8, from.position());
      if (away == null) {
         Vec3 dir = mob.position().subtract(from.position()).normalize();
         away = mob.position().add(dir.scale(12.0));
      }

      mob.getNavigation().moveTo(away.x, away.y, away.z, 1.35);
      if (mob.getNavigation().isDone()) {
         Vec3 dir = mob.position().subtract(from.position()).normalize();
         mob.setDeltaMovement(dir.x * 0.32, mob.getDeltaMovement().y, dir.z * 0.32);
         mob.hurtMarked = true;
      }
   }

   private static void set(WildHostBrain.Mind mind, WildHostBrain.State next, long now, PathfinderMob mob, ServerPlayer player) {
      if (mind.state != next) {
         mind.state = next;
         mind.since = now;
         if (next == WildHostBrain.State.STRIKING) {
            mind.lastStrike = now;
         }

         if (next == WildHostBrain.State.DORMANT) {
            mob.setTarget(null);
         }

         if (next == WildHostBrain.State.DORMANT || next == WildHostBrain.State.WITHDRAWING) {
            mind.infectIntent = false;
         }

         if (next != WildHostBrain.State.WATCHING && next != WildHostBrain.State.STALKING && next != WildHostBrain.State.STRIKING) {
            ATTENTIVE.remove(mob.getId());
         } else {
            ATTENTIVE.put(mob.getId(), player.getId());
         }

         SymbioteLog.event("WILD_HOST_STATE entity={} type={} state={} player={}", mob.getId(), mob.getType().toString(), next, player.getUUID());
      }
   }

   private static void strike(PathfinderMob mob, ServerPlayer player, ServerLevel level, WildHostBrain.Mind mind, long now) {
      mind.lastStrike = now;
      SymbioteStrain strain = strainOf(mob);
      boolean toss = level.random.nextInt(3) == 0;
      TendrilFxEntity.spawnWhip(level, mob, player, 14, strain);
      player.hurt(level.damageSources().mobAttack(mob), (float)mob.getAttributeValue(Attributes.ATTACK_DAMAGE));
      if (toss) {
         TendrilFxEntity grab = TendrilFxEntity.spawnGrab(level, mob, player, 22, strainOf(mob));
         grab.setReachTicksOverride(4);
         grab.scheduleRetract(14);
         grab.setWrapTarget(player.getId());
         Vec3 away = player.position().subtract(mob.position()).normalize();
         player.setDeltaMovement(away.x * 1.15, 0.62, away.z * 1.15);
         player.hurtMarked = true;
         level.playSound(null, mob.getX(), mob.getY(), mob.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.HOSTILE, 1.0F, 0.85F);
      }

      SymbioteLog.event("WILD_HOST_STRIKE entity={} throw={} player={}", mob.getId(), toss, player.getUUID());
   }

   private static void lunge(PathfinderMob mob, ServerPlayer player, ServerLevel level, WildHostBrain.Mind mind, long now) {
      mind.lastLunge = now;
      SymbioteStrain strain = strainOf(mob);
      mob.getNavigation().stop();

      for (int i = 0; i < 3; i++) {
         TendrilFxEntity fx = TendrilFxEntity.spawnGrab(level, mob, player, 30, strain);
         fx.setReachTicksOverride(6);
         fx.scheduleRetract(22);
         fx.setWrapTarget(player.getId());
      }

      Vec3 toward = player.position().subtract(mob.position()).normalize();
      mob.setDeltaMovement(toward.x * 1.05, 0.42, toward.z * 1.05);
      mob.hurtMarked = true;
      YANKS.put(player.getUUID(), new long[]{mob.getId(), now + 16L});
      level.playSound(null, mob.getX(), mob.getY(), mob.getZ(), (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.HOSTILE, 1.0F, 1.1F);
      level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.HOSTILE, 0.9F, 0.95F);
      SymbioteLog.event("WILD_HOST_LUNGE entity={} player={}", mob.getId(), player.getUUID());
   }

   private static void launchAway(PathfinderMob mob, ServerPlayer player, ServerLevel level, WildHostBrain.Mind mind, long now) {
      mind.lastLunge = now;
      mob.getNavigation().stop();
      Vec3 away = mob.position().subtract(player.position()).normalize();
      mob.setDeltaMovement(away.x * 1.0, 0.5, away.z * 1.0);
      mob.hurtMarked = true;
      level.playSound(null, mob.getX(), mob.getY(), mob.getZ(), (SoundEvent)ModSounds.TENDRIL_RETRACT.get(), SoundSource.HOSTILE, 1.0F, 0.95F);
   }

   private static boolean feed(PathfinderMob mob, ServerLevel level, WildHostBrain.Mind mind, long now) {
      Animal prey = null;
      double bestSq = Double.MAX_VALUE;

      for (Animal a : level.getEntitiesOfClass(Animal.class, mob.getBoundingBox().inflate(10.0), x -> x.isAlive() && x != mob && !WildHost.isInfected(x))) {
         double d = a.distanceToSqr(mob);
         if (d < bestSq) {
            bestSq = d;
            prey = a;
         }
      }

      if (prey == null) {
         return false;
      } else if (bestSq > 9.0) {
         mob.getNavigation().moveTo(prey, 1.0);
         mob.getLookControl().setLookAt(prey, 30.0F, 30.0F);
         mind.prey = prey.getId();
         return true;
      } else {
         mind.lastFeed = now;
         mind.prey = -1;
         SymbioteStrain strain = strainOf(mob);
         TendrilFxEntity.spawnWhip(level, mob, prey, 16, strain);
         prey.hurt(level.damageSources().mobAttack(mob), 200.0F);
         mob.heal(6.0F);
         level.playSound(null, mob.getX(), mob.getY(), mob.getZ(), (SoundEvent)ModSounds.CONSUMPTION.get(), SoundSource.HOSTILE, 0.9F, 1.05F);
         SymbioteLog.event("WILD_HOST_FED entity={} prey={}", mob.getId(), prey.getType().toString());
         return true;
      }
   }

   public static void tickYank(ServerPlayer player, ServerLevel level, long now) {
      if (WildHost.enabled()) {
         long[] yank = YANKS.get(player.getUUID());
         if (yank != null) {
            if (now >= yank[1]) {
               YANKS.remove(player.getUUID());
            } else {
               Entity puller = level.getEntity((int)yank[0]);
               if (puller != null && puller.isAlive()) {
                  Vec3 toward = puller.position().subtract(player.position());
                  if (toward.lengthSqr() < 2.25) {
                     YANKS.remove(player.getUUID());
                  } else {
                     toward = toward.normalize();
                     player.setDeltaMovement(toward.x * 0.78, Math.max(player.getDeltaMovement().y, 0.12), toward.z * 0.78);
                     player.hurtMarked = true;
                  }
               } else {
                  YANKS.remove(player.getUUID());
               }
            }
         }
      }
   }

   public static void clearYank(UUID player) {
      YANKS.remove(player);
   }

   public static boolean isFeeding(int entityId) {
      WildHostBrain.Mind m = MINDS.get(entityId);
      return m != null && m.prey >= 0;
   }

   private static SymbioteStrain strainOf(PathfinderMob mob) {
      SymbioteStrain s = WildHost.strainOf(mob);
      return s == null ? SymbioteStrain.GUARDIAN : s;
   }

   public static WildHostBrain.State stateOf(int entityId) {
      WildHostBrain.Mind m = MINDS.get(entityId);
      return m == null ? WildHostBrain.State.DORMANT : m.state;
   }

   public static void forget(int entityId) {
      MINDS.remove(entityId);
      ATTENTIVE.remove(entityId);
      PROVOKED.remove(entityId);
      IGNORE.keySet().removeIf(k -> (int)(k >> 32) == entityId);
   }

   private WildHostBrain() {
   }

   private static final class Mind {
      WildHostBrain.State state = WildHostBrain.State.DORMANT;
      long since = 0L;
      long lastStrike = 0L;
      long lastLunge = 0L;
      long lastFeed = 0L;
      int prey = -1;
      boolean infectIntent = false;
   }

   public enum State {
      DORMANT,
      WATCHING,
      STALKING,
      STRIKING,
      WITHDRAWING;
   }
}
