package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.HeldGravityGuard;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.tick.LevelTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class EnemySlam {
   private static final int LIFT_END_TICK = 8;
   private static final int CONVERGE_END_TICK = 30;
   private static final double LIFT_VELOCITY = 0.4;
   private static final double LIFT_HEIGHT = 2.5;
   private static final double CEILING_PROBE = 3.0;
   private static final double CEILING_MARGIN = 0.5;
   private static final double CONVERGE_MAX_STEP = 0.9;
   private static final double IMPACT_DIST = 1.5;
   private static final double CARRY_RADIUS = 3.5;
   private static final double CARRY_GAIN = 0.35;
   private static final double CARRY_MAX_SPEED = 0.6;
   private static final double IMPACT_KNOCKBACK = 0.5;
   private static final int TENDRIL_LIFETIME_TICKS = 70;
   private static final int TENDRIL_REACH_TICKS = 4;
   private static final Map<UUID, EnemySlam.Session> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> LAST_SLAM = new HashMap<>();

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static boolean canStart(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!(Boolean)SymbioteConfig.SLAM_ENABLED.get()) {
         return false;
      }

      if (!p.stage.isAtLeast(BondStage.DOMINANT)) {
         return false;
      }

      if (ACTIVE.containsKey(player.getUUID())) {
         return false;
      }

      Long last = LAST_SLAM.get(player.getUUID());
      return last == null || level.getGameTime() - last >= SymbioteConfig.SLAM_COOLDOWN_TICKS.get().intValue();
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity t1, LivingEntity t2) {
      if (!canStart(player, level, p)) {
         return false;
      }

      if (t1 != null && t2 != null && t1 != t2 && t1.isAlive() && t2.isAlive()) {
         long now = level.getGameTime();
         EnemySlam.Session s = new EnemySlam.Session(level.dimension(), now, p.strain);
         LivingEntity[] targets = new LivingEntity[]{t1, t2};

         for (int i = 0; i < 2; i++) {
            LivingEntity t = targets[i];
            if (t.isPassenger()) {
               t.stopRiding();
            }

            if (t.isVehicle()) {
               t.ejectPassengers();
            }

            t.setNoGravity(true);
            HeldGravityGuard.mark(t);
            s.targetIds[i] = t.getId();
            s.liftTargetY[i] = t.getY() + liftAllowance(level, t);
            double ox = t.getX() - player.getX();
            double oz = t.getZ() - player.getZ();
            double horiz = Math.sqrt(ox * ox + oz * oz);
            if (horiz > 3.5) {
               ox *= 3.5 / horiz;
               oz *= 3.5 / horiz;
            }

            s.carryOffX[i] = ox;
            s.carryOffZ[i] = oz;
            s.liftYOff[i] = s.liftTargetY[i] - player.getY();
            s.lastTipPos[i] = chest(t);
            if (t instanceof Creeper c) {
               c.setSwellDir(-1);
            }

            TendrilFxEntity fx = TendrilFxEntity.spawnGrab(level, player, t, 70, p.strain);
            fx.setReachTicksOverride(4);
            fx.setWrapTarget(t.getId());
            s.fxIds[i] = fx.getId();
         }

         ACTIVE.put(player.getUUID(), s);
         LAST_SLAM.put(player.getUUID(), now);
         SymbioteLog.event("ENEMY_SLAM_START player={} t1={} t2={} dist_between={}", player.getUUID(), t1.getType(), t2.getType(), t1.distanceTo(t2));
         return true;
      } else {
         return false;
      }
   }

   @SubscribeEvent
   public static void onLevelTick(LevelTickEvent.Post event) {
      if (true) {
         if (event.getLevel() instanceof ServerLevel level) {
            if (!ACTIVE.isEmpty()) {
               tickAll(level);
            }
         }
      }
   }

   private static void tickAll(ServerLevel level) {
      long now = level.getGameTime();
      Iterator<Entry<UUID, EnemySlam.Session>> it = ACTIVE.entrySet().iterator();

      while (it.hasNext()) {
         Entry<UUID, EnemySlam.Session> e = it.next();
         EnemySlam.Session s = e.getValue();
         if (s.dimension == level.dimension()) {
            ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
            if (player == null || !player.isAlive() || player.serverLevel() != level) {
               restoreGravity(level, s);
               discardFx(level, s);
               SymbioteLog.event("ENEMY_SLAM_END player={} reason=player_gone", e.getKey());
               it.remove();
            } else if (s.phase == EnemySlam.Phase.RETRACT) {
               if (now - s.phaseStartTick >= 16L) {
                  discardFx(level, s);
                  SymbioteLog.event("ENEMY_SLAM_END player={} reason=retract_complete", e.getKey());
                  it.remove();
               }
            } else {
               LivingEntity a = livingTarget(level, s.targetIds[0]);
               LivingEntity b = livingTarget(level, s.targetIds[1]);
               if (a != null && b != null) {
                  s.lastTipPos[0] = chest(a);
                  s.lastTipPos[1] = chest(b);
                  long elapsed = now - s.startTick;
                  if (s.phase == EnemySlam.Phase.LIFT) {
                     tickLift(player, a, s, 0);
                     tickLift(player, b, s, 1);
                     if (elapsed >= 8L) {
                        s.phase = EnemySlam.Phase.CONVERGE;
                        s.phaseStartTick = now;
                     }
                  } else if (!(a.distanceTo(b) <= 1.5) && elapsed < 30L) {
                     Vec3 mid = a.position().add(b.position()).scale(0.5);
                     dragToward(a, mid);
                     dragToward(b, mid);
                  } else {
                     impact(level, player, s, a, b);
                     transitionToRetract(level, s, now, "impact", e.getKey());
                  }
               } else {
                  transitionToRetract(level, s, now, "target_lost", e.getKey());
               }
            }
         }
      }
   }

   private static void tickLift(ServerPlayer player, LivingEntity t, EnemySlam.Session s, int i) {
      double hvx = clampCarry((player.getX() + s.carryOffX[i] - t.getX()) * 0.35);
      double hvz = clampCarry((player.getZ() + s.carryOffZ[i] - t.getZ()) * 0.35);
      double goalY = player.getY() + s.liftYOff[i];
      t.setDeltaMovement(hvx, t.getY() < goalY ? 0.4 : 0.0, hvz);
      t.hurtMarked = true;
      t.fallDistance = 0.0F;
   }

   private static double clampCarry(double v) {
      return Math.max(-0.6, Math.min(0.6, v));
   }

   private static void dragToward(LivingEntity t, Vec3 mid) {
      Vec3 to = mid.subtract(t.position());
      double len = to.length();
      if (len < 1.0E-4) {
         t.setDeltaMovement(Vec3.ZERO);
      } else {
         double step = Math.min(len, 0.9);
         t.setDeltaMovement(to.scale(step / len));
      }

      t.hurtMarked = true;
      t.fallDistance = 0.0F;
   }

   private static void impact(ServerLevel level, ServerPlayer player, EnemySlam.Session s, LivingEntity a, LivingEntity b) {
      restoreGravity(level, s);
      Vec3 mid = a.position().add(b.position()).scale(0.5);
      float damage = SymbioteConfig.SLAM_DAMAGE.get().floatValue();
      DamageSource src = level.damageSources().playerAttack(player);
      a.invulnerableTime = 0;
      b.invulnerableTime = 0;
      a.hurt(src, damage);
      b.hurt(src, damage);
      knockOutward(player, a, mid);
      knockOutward(player, b, mid);
      Vec3 impactPos = mid.add(0.0, Math.max(a.getBbHeight(), b.getBbHeight()) * 0.5, 0.0);
      level.playSound(null, impactPos.x, impactPos.y, impactPos.z, (SoundEvent)ModSounds.SLAM_CRUNCH.get(), SoundSource.PLAYERS, 1.0F, 0.95F);
      level.sendParticles(ParticleTypes.POOF, impactPos.x, impactPos.y, impactPos.z, 10, 0.4, 0.3, 0.4, 0.05);
      level.sendParticles(ParticleTypes.CRIT, impactPos.x, impactPos.y, impactPos.z, 12, 0.5, 0.4, 0.5, 0.15);
      SymbioteLog.event(
         "ENEMY_SLAM_IMPACT player={} t1={} t2={} damage={} t1_alive={} t2_alive={}",
         player.getUUID(),
         a.getType(),
         b.getType(),
         damage,
         a.isAlive(),
         b.isAlive()
      );
   }

   private static void knockOutward(ServerPlayer player, LivingEntity t, Vec3 mid) {
      Vec3 away = t.position().subtract(mid);
      away = new Vec3(away.x, 0.0, away.z);
      if (away.lengthSqr() < 1.0E-4) {
         away = new Vec3(player.getRandom().nextGaussian(), 0.0, player.getRandom().nextGaussian());
      }

      Vec3 awayN = away.normalize();
      t.setDeltaMovement(awayN.x * 0.5, 0.1, awayN.z * 0.5);
      t.hurtMarked = true;
   }

   private static void transitionToRetract(ServerLevel level, EnemySlam.Session s, long now, String reason, UUID playerId) {
      restoreGravity(level, s);
      s.phase = EnemySlam.Phase.RETRACT;
      s.phaseStartTick = now;

      for (int i = 0; i < 2; i++) {
         if (level.getEntity(s.fxIds[i]) instanceof TendrilFxEntity tendril) {
            Vec3 tip = s.lastTipPos[i] != null ? s.lastTipPos[i] : tendril.position();
            tendril.setTargetId(0);
            tendril.setTargetPos(tip.x, tip.y, tip.z);
            tendril.setTransitionFrom(tip.x, tip.y, tip.z, tendril.tickCount);
            tendril.setRetractStartTick(tendril.tickCount);
         }
      }

      SymbioteLog.event("ENEMY_SLAM_RETRACT_START player={} reason={}", playerId, reason);
   }

   private static void restoreGravity(ServerLevel level, EnemySlam.Session s) {
      for (int i = 0; i < 2; i++) {
         if (!s.gravityRestored[i]) {
            if (level.getEntity(s.targetIds[i]) instanceof LivingEntity le) {
               le.setNoGravity(false);
               HeldGravityGuard.release(le);
            }

            s.gravityRestored[i] = true;
         }
      }
   }

   private static void discardFx(ServerLevel level, EnemySlam.Session s) {
      for (int id : s.fxIds) {
         Entity ent = level.getEntity(id);
         if (ent != null) {
            ent.discard();
         }
      }
   }

   public static void forceClear(ServerLevel level, UUID player) {
      EnemySlam.Session s = ACTIVE.remove(player);
      if (s != null) {
         restoreGravity(level, s);
         discardFx(level, s);
      }
   }

   private static LivingEntity livingTarget(ServerLevel level, int id) {
      return level.getEntity(id) instanceof LivingEntity living && living.isAlive() ? living : null;
   }

   private static Vec3 chest(LivingEntity t) {
      return t.position().add(0.0, t.getBbHeight() * 0.5, 0.0);
   }

   private static double liftAllowance(ServerLevel level, LivingEntity t) {
      double clear = 0.0;

      for (double dy = 0.5; dy <= 3.0 && level.noCollision(t, t.getBoundingBox().move(0.0, dy, 0.0)); dy += 0.5) {
         clear = dy;
      }

      return Math.min(2.5, Math.max(0.0, clear - 0.5));
   }

   private EnemySlam() {
   }

   private enum Phase {
      LIFT,
      CONVERGE,
      RETRACT;
   }

   private static final class Session {
      final ResourceKey<Level> dimension;
      final long startTick;
      final SymbioteStrain strain;
      final int[] targetIds = new int[2];
      final int[] fxIds = new int[2];
      final double[] liftTargetY = new double[2];
      final Vec3[] lastTipPos = new Vec3[2];
      final boolean[] gravityRestored = new boolean[2];
      final double[] carryOffX = new double[2];
      final double[] carryOffZ = new double[2];
      final double[] liftYOff = new double[2];
      EnemySlam.Phase phase = EnemySlam.Phase.LIFT;
      long phaseStartTick;

      Session(ResourceKey<Level> dimension, long startTick, SymbioteStrain strain) {
         this.dimension = dimension;
         this.startTick = startTick;
         this.phaseStartTick = startTick;
         this.strain = strain;
      }
   }
}
