package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.HeldGravityGuard;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.AbstractSkeleton;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.Phantom;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.neoforged.neoforge.event.tick.LevelTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class GroundSlam {
   private static final int LIFT_END_TICK = 16;
   private static final int HOLD_END_TICK = 26;
   private static final int DRIVE_END_TICK = 40;
   private static final double LIFT_VELOCITY = 0.22;
   private static final double LIFT_HEIGHT = 2.5;
   private static final double DRIVE_VELOCITY = -1.8;
   private static final double PICK_RANGE = 6.0;
   private static final float DAMAGE_MULT = 1.75F;
   private static final int TENDRIL_REACH_TICKS = 9;
   private static final int COOLDOWN_TICKS = 200;
   private static final double CARRY_RADIUS = 3.5;
   private static final double CARRY_GAIN = 0.35;
   private static final double CARRY_MAX_SPEED = 0.6;
   private static final float CHANCE_PER_CHECK = 0.5F;
   private static final Map<UUID, GroundSlam.Session> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> LAST_SLAM = new HashMap<>();

   private static double clampCarry(double v) {
      return Math.max(-0.6, Math.min(0.6, v));
   }

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static void maybeStart(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.stage.isAtLeast(BondStage.COOPERATIVE)) {
         if (CombatSense.inCombat(player)) {
            if (!player.isUnderWater()) {
               if (!ACTIVE.containsKey(player.getUUID()) && !EnemySlam.isActive(player.getUUID())) {
                  if (!WalkSeizure.isActive(player.getUUID()) && !DeepSeizure.isActive(player.getUUID())) {
                     Long last = LAST_SLAM.get(player.getUUID());
                     if (last == null || now - last >= 200L) {
                        LivingEntity target = pickTarget(player, level);
                        if (target != null) {
                           if (target instanceof Phantom && player.getRandom().nextFloat() < 0.5F) {
                              startSlam(player, level, p, target, false, 3);
                           } else {
                              float chance = 0.5F;
                              if (target instanceof AbstractSkeleton) {
                                 Vec3 away = target.position().subtract(player.position());
                                 if (target.getDeltaMovement().dot(away) > 0.02) {
                                    chance = 0.7F;
                                 }
                              }

                              if (!(player.getRandom().nextFloat() >= chance)) {
                                 startSlam(player, level, p, target, false, 1);
                              }
                           }
                        }
                     }
                  }
               }
            }
         }
      }
   }

   public static boolean force(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity target) {
      if (ACTIVE.containsKey(player.getUUID()) || EnemySlam.isActive(player.getUUID())) {
         return false;
      }

      if (player.isUnderWater()) {
         return false;
      }

      if (target.getMaxHealth() > SymbioteConfig.CONSUME_MAX_TARGET_HP.get()) {
         return false;
      }

      if (target.getBbWidth() > 1.6F || target.getBbHeight() > 2.6F) {
         return false;
      }

      if (!hasSlamFloor(level, target)) {
         return false;
      }

      if (liftAllowance(level, target) < 1.5) {
         return false;
      }

      if (!startSlam(player, level, p, target, true, 1)) {
         return false;
      }

      GroundSlam.Session s = ACTIVE.get(player.getUUID());
      if (s != null) {
         s.damageEach = 1000.0F;
      }

      return true;
   }

   private static boolean startSlam(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity target, boolean squishVoice, int slams) {
      long now = level.getGameTime();
      TendrilMantle.ensureUp(player, level, p, 200);
      TendrilFxEntity fx = TendrilMantle.beginJob(player, level, chest(target));
      if (fx == null) {
         return false;
      }

      if (target.isPassenger()) {
         target.stopRiding();
      }

      if (target.isVehicle()) {
         target.ejectPassengers();
      }

      target.setNoGravity(true);
      HeldGravityGuard.mark(target);
      if (target instanceof Creeper c) {
         c.setSwellDir(-1);
      }

      fx.setReachTicksOverride(9);
      fx.setWrapTarget(target.getId());
      level.playSound(null, target.getX(), target.getY(), target.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.7F, 0.9F);
      GroundSlam.Session s = new GroundSlam.Session(
         level.dimension(), now, p.strain, target.getId(), fx.getId(), target.getY() + liftAllowance(level, target), chest(target)
      );
      double ox = target.getX() - player.getX();
      double oz = target.getZ() - player.getZ();
      double horiz = Math.sqrt(ox * ox + oz * oz);
      if (horiz > 3.5) {
         ox *= 3.5 / horiz;
         oz *= 3.5 / horiz;
      }

      s.holdOffX = ox;
      s.holdOffZ = oz;
      s.liftYOff = s.liftY - player.getY();
      s.squishVoice = squishVoice;
      s.slamsLeft = slams;
      if (slams > 1) {
         s.damageEach = 7.0F;
      }

      ACTIVE.put(player.getUUID(), s);
      LAST_SLAM.put(player.getUUID(), now);
      SymbioteLog.event(
         "GROUND_SLAM_START player={} target={} dist={} squish={}",
         player.getUUID(),
         target.getType(),
         String.format("%.1f", target.distanceTo(player)),
         squishVoice
      );
      return true;
   }

   private static LivingEntity pickTarget(ServerPlayer player, ServerLevel level) {
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (Mob m : level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(6.0), mm -> mm.isAlive() && mm instanceof Enemy && HostileTargets.mayOpenOn(mm, player))) {
         if (!(m.getMaxHealth() > SymbioteConfig.CONSUME_MAX_TARGET_HP.get())
            && !(m.getBbWidth() > 1.6F)
            && !(m.getBbHeight() > 2.6F)
            && hasSlamFloor(level, m)
            && !(liftAllowance(level, m) < 1.5)
            && player.hasLineOfSight(m)) {
            double d = m.distanceToSqr(player);
            if (d < bestSq) {
               bestSq = d;
               best = m;
            }
         }
      }

      return best;
   }

   private static boolean hasSlamFloor(ServerLevel level, LivingEntity t) {
      BlockPos pos = t.blockPosition();
      int fluid = 0;

      for (int dy = 0; dy <= 4; dy++) {
         BlockPos bp = pos.below(dy);
         BlockState st = level.getBlockState(bp);
         if (!st.getFluidState().isEmpty()) {
            if (++fluid > 1) {
               return false;
            }
         } else if (!st.isAir()) {
            return true;
         }
      }

      return false;
   }

   private static double liftAllowance(ServerLevel level, LivingEntity t) {
      Vec3 from = chest(t);
      Vec3 to = from.add(0.0, 3.5, 0.0);
      BlockHitResult hit = level.clip(new ClipContext(from, to, Block.COLLIDER, Fluid.NONE, t));
      return hit.getType() == Type.MISS ? 2.5 : Math.max(0.5, hit.getLocation().y - from.y - 0.5);
   }

   private static Vec3 chest(LivingEntity t) {
      return t.position().add(0.0, t.getBbHeight() * 0.5, 0.0);
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
      Iterator<Entry<UUID, GroundSlam.Session>> it = ACTIVE.entrySet().iterator();

      while (it.hasNext()) {
         Entry<UUID, GroundSlam.Session> e = it.next();
         GroundSlam.Session s = e.getValue();
         if (s.dimension == level.dimension()) {
            ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
            if (player == null || !player.isAlive() || player.serverLevel() != level) {
               restoreGravity(level, s);
               discardFx(level, s);
               SymbioteLog.event("GROUND_SLAM_END player={} reason=player_gone", e.getKey());
               it.remove();
            } else if (s.phase == GroundSlam.Phase.RETRACT) {
               if (now - s.phaseStartTick >= 16L) {
                  discardFx(level, s);
                  SymbioteLog.event("GROUND_SLAM_END player={} reason=retract_complete", e.getKey());
                  it.remove();
               }
            } else {
               LivingEntity t = level.getEntity(s.targetId) instanceof LivingEntity le && le.isAlive() ? le : null;
               if (t == null) {
                  transitionToRetract(level, s, now, "target_lost", e.getKey());
               } else {
                  s.lastTipPos = chest(t);
                  if (level.getEntity(s.fxId) instanceof TendrilFxEntity fx) {
                     Vec3 c = chest(t);
                     fx.setTargetPos(c.x, c.y, c.z);
                  }

                  long elapsed = now - s.startTick;
                  double wantX = player.getX() + s.holdOffX;
                  double wantZ = player.getZ() + s.holdOffZ;
                  double hvx = clampCarry((wantX - t.getX()) * 0.35);
                  double hvz = clampCarry((wantZ - t.getZ()) * 0.35);
                  double goalY = player.getY() + s.liftYOff;
                  if (s.phase == GroundSlam.Phase.LIFT) {
                     t.setDeltaMovement(hvx, t.getY() < goalY ? 0.22 : 0.0, hvz);
                     t.hurtMarked = true;
                     t.fallDistance = 0.0F;
                     if (elapsed >= 16L) {
                        s.phase = s.repeatCycle ? GroundSlam.Phase.DRIVE : GroundSlam.Phase.HOLD;
                        s.phaseStartTick = now;
                     }
                  } else if (s.phase == GroundSlam.Phase.HOLD) {
                     double vy = Math.max(-0.2, Math.min(0.2, (goalY - t.getY()) * 0.3));
                     t.setDeltaMovement(hvx, vy, hvz);
                     t.hurtMarked = true;
                     t.fallDistance = 0.0F;
                     if (elapsed >= 26L) {
                        s.phase = GroundSlam.Phase.DRIVE;
                        s.phaseStartTick = now;
                     }
                  } else {
                     t.setDeltaMovement(hvx * 0.5, -1.8, hvz * 0.5);
                     t.hurtMarked = true;
                     t.fallDistance = 0.0F;
                     if (t.onGround() || elapsed >= 40L) {
                        impact(level, player, s, t);
                        s.slamsLeft--;
                        if (s.slamsLeft > 0 && t.isAlive()) {
                           t.setNoGravity(true);
                           HeldGravityGuard.mark(t);
                           s.gravityRestored = false;
                           s.liftY = t.getY() + liftAllowance(level, t);
                           double rx = t.getX() - player.getX();
                           double rz = t.getZ() - player.getZ();
                           double rh = Math.sqrt(rx * rx + rz * rz);
                           if (rh > 3.5) {
                              rx *= 3.5 / rh;
                              rz *= 3.5 / rh;
                           }

                           s.holdOffX = rx;
                           s.holdOffZ = rz;
                           s.liftYOff = s.liftY - player.getY();
                           s.repeatCycle = true;
                           s.phase = GroundSlam.Phase.LIFT;
                           s.startTick = now;
                           s.phaseStartTick = now;
                        } else {
                           transitionToRetract(level, s, now, "impact", e.getKey());
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void impact(ServerLevel level, ServerPlayer player, GroundSlam.Session s, LivingEntity t) {
      restoreGravity(level, s);
      float damage = s.damageEach > 0.0F ? s.damageEach : SymbioteConfig.SLAM_DAMAGE.get().floatValue() * 1.75F;
      t.invulnerableTime = 0;
      t.hurt(level.damageSources().playerAttack(player), damage);
      t.setDeltaMovement(Vec3.ZERO);
      t.hurtMarked = true;
      BlockPos below = t.blockPosition().below();
      BlockState state = level.getBlockState(below);
      boolean cratered = !state.isAir()
         && state.getDestroySpeed(level, below) >= 0.0F
         && level.getFluidState(below).isEmpty()
         && level.getFluidState(below.below()).isEmpty();
      if (cratered) {
         level.destroyBlock(below, true, player);
      }

      level.playSound(null, t.getX(), t.getY(), t.getZ(), state.getSoundType().getBreakSound(), SoundSource.PLAYERS, 0.9F, 0.7F);
      level.playSound(null, t.getX(), t.getY(), t.getZ(), (SoundEvent)ModSounds.SLAM_CRUNCH.get(), SoundSource.PLAYERS, 1.0F, 1.0F);
      if (!state.isAir()) {
         level.sendParticles(new BlockParticleOption(ParticleTypes.BLOCK, state), t.getX(), t.getY() + 0.1, t.getZ(), 18, 0.5, 0.1, 0.5, 0.12);
      }

      level.sendParticles(ParticleTypes.CRIT, t.getX(), t.getY() + t.getBbHeight() * 0.5, t.getZ(), 8, 0.4, 0.3, 0.4, 0.1);
      if (s.squishVoice && !t.isAlive()) {
         VoiceLines.send(player, "symbiote.voice.curiosity_squish", 0);
      }

      SymbioteLog.event("GROUND_SLAM_IMPACT player={} target={} damage={} alive={}", player.getUUID(), t.getType(), damage, t.isAlive());
   }

   private static void transitionToRetract(ServerLevel level, GroundSlam.Session s, long now, String reason, UUID playerId) {
      restoreGravity(level, s);
      s.phase = GroundSlam.Phase.RETRACT;
      s.phaseStartTick = now;
      if (level.getEntity(s.fxId) instanceof TendrilFxEntity tendril) {
         tendril.setWrapTarget(0);
         if (!TendrilMantle.handOff(level, tendril)) {
            Vec3 tip = s.lastTipPos != null ? s.lastTipPos : tendril.position();
            tendril.setTargetId(0);
            tendril.setTargetPos(tip.x, tip.y, tip.z);
            tendril.setTransitionFrom(tip.x, tip.y, tip.z, tendril.tickCount);
            tendril.setRetractStartTick(tendril.tickCount);
         }
      }

      SymbioteLog.event("GROUND_SLAM_RETRACT_START player={} reason={}", playerId, reason);
   }

   private static void restoreGravity(ServerLevel level, GroundSlam.Session s) {
      if (!s.gravityRestored) {
         s.gravityRestored = true;
         if (level.getEntity(s.targetId) instanceof LivingEntity t) {
            t.setNoGravity(false);
            HeldGravityGuard.release(t);
         }
      }
   }

   private static void discardFx(ServerLevel level, GroundSlam.Session s) {
      Entity ent = level.getEntity(s.fxId);
      if (ent != null && !TendrilMantle.handOff(level, ent)) {
         ent.discard();
      }
   }

   private GroundSlam() {
   }

   private enum Phase {
      LIFT,
      HOLD,
      DRIVE,
      RETRACT;
   }

   private static final class Session {
      final ResourceKey<Level> dimension;
      long startTick;
      final SymbioteStrain strain;
      final int targetId;
      final int fxId;
      final double liftTargetY;
      Vec3 lastTipPos;
      boolean gravityRestored = false;
      GroundSlam.Phase phase = GroundSlam.Phase.LIFT;
      long phaseStartTick;
      boolean squishVoice = false;
      int slamsLeft = 1;
      boolean repeatCycle = false;
      float damageEach = -1.0F;
      double liftY;
      double holdOffX;
      double holdOffZ;
      double liftYOff;

      Session(ResourceKey<Level> dimension, long startTick, SymbioteStrain strain, int targetId, int fxId, double liftTargetY, Vec3 tip) {
         this.dimension = dimension;
         this.startTick = startTick;
         this.phaseStartTick = startTick;
         this.strain = strain;
         this.targetId = targetId;
         this.fxId = fxId;
         this.liftTargetY = liftTargetY;
         this.liftY = liftTargetY;
         this.lastTipPos = tip;
      }
   }
}
