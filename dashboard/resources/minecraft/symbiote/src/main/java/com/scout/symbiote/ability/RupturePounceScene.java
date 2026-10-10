package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;

public final class RupturePounceScene {
   private static final int LIFT_TICKS = 14;
   private static final int GRAB_TICKS = 16;
   private static final int STAB_INTERVAL = 8;
   private static final int MAX_STABS = 8;
   private static final int SCENE_TIMEOUT = 160;
   private static final int FX_LIFETIME = 180;
   private static final double HOVER_H = 2.2;
   private static final double HOLD_DIST = 3.3;
   private static final double HOLD_Y_OFF = 1.1;
   private static final Map<UUID, RupturePounceScene.Scene> ACTIVE = new HashMap<>();

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static boolean begin(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity prey) {
      if (prey != null && !ACTIVE.containsKey(player.getUUID())) {
         long now = level.getGameTime();
         Vec3 look = player.getLookAngle();
         Vec3 fwd = new Vec3(look.x, 0.0, look.z);
         fwd = fwd.lengthSqr() < 1.0E-4 ? new Vec3(0.0, 0.0, 1.0) : fwd.normalize();
         RupturePounceScene.Scene s = new RupturePounceScene.Scene(prey.getId(), now, p.strain, player.getX(), player.getY(), player.getZ(), fwd);

         for (int i = 0; i < 5; i++) {
            double a = (Math.PI * 2) * i / 5.0;
            Vec3 origin = new Vec3(s.startX + Math.cos(a) * 1.5, s.startY, s.startZ + Math.sin(a) * 1.5);
            TendrilFxEntity fx = TendrilFxEntity.spawnGrabFromBlock(level, origin, player, 180, p.strain, 0.22F, (float)a);
            fx.setThick(true);
            fx.setReachTicksOverride(4 + i);
            s.liftIds[i] = fx.getId();
         }

         player.setNoGravity(true);
         ACTIVE.put(player.getUUID(), s);
         VoiceLines.send(player, "symbiote.voice.rupture", 3);
         ModNetwork.sendOverrideFx(player, "vignette_red", 30);
         SymbioteLog.event("RUPTURE_SCENE_START player={} prey={} prey_type={}", player.getUUID(), prey.getUUID(), prey.getType());
         return true;
      } else {
         return false;
      }
   }

   public static void tickAll(ServerLevel level) {
      Iterator<Entry<UUID, RupturePounceScene.Scene>> it = ACTIVE.entrySet().iterator();
      long now = level.getGameTime();

      while (it.hasNext()) {
         Entry<UUID, RupturePounceScene.Scene> e = it.next();
         RupturePounceScene.Scene s = e.getValue();
         ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (player == null || !player.isAlive()) {
            cleanupFx(level, s);
            it.remove();
         } else if (player.serverLevel() == level) {
            long age = now - s.startTick;
            if (age > 160L) {
               abort(level, s, player, "timeout");
               it.remove();
            } else if (level.getEntity(s.preyId) instanceof LivingEntity prey && prey.isAlive()) {
               double targetY = s.startY + 2.2;
               double dy = targetY - player.getY();
               player.setDeltaMovement(0.0, Math.max(-0.4, Math.min(0.4, dy * 0.35)), 0.0);
               player.hurtMarked = true;
               player.fallDistance = 0.0F;
               Vec3 hold = new Vec3(player.getX() + s.fwd.x * 3.3, player.getY() + 1.1, player.getZ() + s.fwd.z * 3.3);
               if (age >= 14L) {
                  if (!s.grabSpawned) {
                     for (int i = 0; i < 4; i++) {
                        TendrilFxEntity fx = TendrilFxEntity.spawnGrab(level, player, prey, 180, s.strain);
                        fx.setReachTicksOverride(3 + i);
                        fx.setArc(0.3F + 0.1F * (i % 2), (float)((Math.PI * 2) * i / 4.0));
                        s.grabIds[i] = fx.getId();
                     }

                     s.grabSpawned = true;
                  }

                  prey.setNoGravity(true);
                  prey.fallDistance = 0.0F;
                  if (age < 30L) {
                     Vec3 to = hold.subtract(prey.position());
                     double len = to.length();
                     if (len > 0.001) {
                        double step = Math.min(len * 0.5, 0.9);
                        prey.setDeltaMovement(to.scale(step / len));
                        prey.hurtMarked = true;
                     }
                  } else {
                     if (!s.executeStarted) {
                        s.executeStarted = true;
                        s.executeStartTick = now;
                        retractOne(level, s.grabIds[2], hold);
                        s.grabIds[2] = 0;
                        retractOne(level, s.grabIds[3], hold);
                        s.grabIds[3] = 0;
                     }

                     prey.setPos(hold.x, hold.y, hold.z);
                     prey.setDeltaMovement(Vec3.ZERO);
                     prey.hurtMarked = true;
                     if ((now - s.executeStartTick) % 8L == 0L) {
                        stab(level, player, prey, s);
                        if (!prey.isAlive() || s.stabs >= 8) {
                           finish(level, s, player, prey, hold);
                           it.remove();
                        }
                     }
                  }
               }
            } else {
               abort(level, s, player, "prey_gone");
               it.remove();
            }
         }
      }
   }

   private static void stab(ServerLevel level, ServerPlayer player, LivingEntity prey, RupturePounceScene.Scene s) {
      TendrilFxEntity.spawnWhip(level, player, prey, 10, s.strain);
      TendrilFxEntity.spawnWhip(level, player, prey, 10, s.strain);
      prey.invulnerableTime = 0;
      prey.hurtTime = 0;
      float dmg = SymbioteConfig.RUPTURE_DAMAGE.get().floatValue();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null) {
         dmg *= (float)p.stageIntensity();
      }

      prey.hurt(level.damageSources().playerAttack(player), dmg);
      s.stabs++;
      level.sendParticles(ParticleTypes.DAMAGE_INDICATOR, prey.getX(), prey.getY() + prey.getBbHeight() * 0.6, prey.getZ(), 6, 0.2, 0.2, 0.2, 0.0);
      level.playSound(null, prey.blockPosition(), SoundEvents.RAVAGER_ATTACK, SoundSource.PLAYERS, 0.8F, 1.2F);
   }

   private static void finish(ServerLevel level, RupturePounceScene.Scene s, ServerPlayer player, LivingEntity prey, Vec3 tip) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null) {
         OverrideGate.stamp(level, p);
      }

      if (prey.isAlive()) {
         prey.hurt(level.damageSources().genericKill(), HealthGuard.lethal(prey));
      }

      SymbioteTracker.adjustHunger(level, player, SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get() * 2, "rupture_kill");
      player.heal(5.0F);
      player.getFoodData().eat(3, 0.4F);
      TendrilFxEntity.spawnBurst(level, player, 18, s.strain);
      level.sendParticles(ParticleTypes.LARGE_SMOKE, tip.x, tip.y, tip.z, 14, 0.3, 0.4, 0.3, 0.02);
      level.sendParticles(ParticleTypes.DAMAGE_INDICATOR, tip.x, tip.y, tip.z, 22, 0.3, 0.4, 0.3, 0.0);
      level.playSound(null, player.blockPosition(), SoundEvents.WARDEN_ATTACK_IMPACT, SoundSource.PLAYERS, 1.0F, 1.1F);
      retractAll(level, s, tip);
      player.setNoGravity(false);
      VoiceLines.send(player, "symbiote.voice.rupture", 3);
      SymbioteLog.event("RUPTURE_SCENE_FINISH player={} stabs={}", player.getUUID(), s.stabs);
   }

   private static void abort(ServerLevel level, RupturePounceScene.Scene s, ServerPlayer player, String reason) {
      if (level.getEntity(s.preyId) instanceof LivingEntity prey) {
         prey.setNoGravity(false);
      }

      retractAll(level, s, player.position().add(0.0, 1.0, 0.0));
      player.setNoGravity(false);
      SymbioteLog.event("RUPTURE_SCENE_ABORT player={} reason={}", player.getUUID(), reason);
   }

   private static void retractAll(ServerLevel level, RupturePounceScene.Scene s, Vec3 tip) {
      for (int id : s.liftIds) {
         retractOne(level, id, tip);
      }

      for (int id : s.grabIds) {
         retractOne(level, id, tip);
      }
   }

   private static void retractOne(ServerLevel level, int id, Vec3 tip) {
      if (id != 0) {
         if (level.getEntity(id) instanceof TendrilFxEntity fx) {
            fx.setTargetId(0);
            fx.setTargetPos(tip.x, tip.y, tip.z);
            fx.setTransitionFrom(tip.x, tip.y, tip.z, fx.tickCount);
            fx.setRetractStartTick(fx.tickCount);
            fx.setLifetime(fx.tickCount + 16);
         }
      }
   }

   private static void cleanupFx(ServerLevel level, RupturePounceScene.Scene s) {
      for (int id : s.liftIds) {
         Entity e = level.getEntity(id);
         if (e != null) {
            e.discard();
         }
      }

      for (int id : s.grabIds) {
         if (id != 0) {
            Entity e = level.getEntity(id);
            if (e != null) {
               e.discard();
            }
         }
      }
   }

   public static void forceClear(ServerLevel level, UUID player) {
      RupturePounceScene.Scene s = ACTIVE.remove(player);
      if (s != null) {
         cleanupFx(level, s);
         ServerPlayer pl = level.getServer().getPlayerList().getPlayer(player);
         if (pl != null) {
            pl.setNoGravity(false);
         }

         if (level.getEntity(s.preyId) instanceof LivingEntity prey) {
            prey.setNoGravity(false);
         }
      }
   }

   private RupturePounceScene() {
   }

   static final class Scene {
      final int preyId;
      final long startTick;
      final SymbioteStrain strain;
      final double startX;
      final double startY;
      final double startZ;
      final Vec3 fwd;
      final int[] liftIds = new int[5];
      final int[] grabIds = new int[4];
      boolean grabSpawned = false;
      boolean executeStarted = false;
      long executeStartTick = 0L;
      int stabs = 0;

      Scene(int preyId, long startTick, SymbioteStrain strain, double sx, double sy, double sz, Vec3 fwd) {
         this.preyId = preyId;
         this.startTick = startTick;
         this.strain = strain;
         this.startX = sx;
         this.startY = sy;
         this.startZ = sz;
         this.fwd = fwd;
      }
   }
}
