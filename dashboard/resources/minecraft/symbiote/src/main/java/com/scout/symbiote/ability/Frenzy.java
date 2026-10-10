package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class Frenzy {
   public static final boolean VAULTED = true;
   private static final int STRIKE_INTERVAL = 8;
   private static final double STRIKE_RANGE = 6.0;
   private static final float STRIKE_DAMAGE = 7.0F;

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      int cooldown = SymbioteConfig.FRENZY_COOLDOWN_TICKS.get();
      if (now - p.lastFrenzyTick < cooldown) {
         SymbioteLog.event("ABILITY_REJECTED ability=frenzy player={} reason=on_cooldown", player.getUUID());
      } else {
         p.lastFrenzyTick = now;
         p.frenzyUntilTick = now + SymbioteConfig.FRENZY_DURATION_TICKS.get().intValue();
         VoiceLines.send(player, "symbiote.voice.frenzy", 3);
         ModNetwork.sendOverrideFx(player, "vignette_red", 30);
         SymbioteLog.event("ABILITY_FIRED ability=frenzy player={} until={}", player.getUUID(), p.frenzyUntilTick);
      }
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (now % 8L == 0L) {
         LivingEntity target = nearestHostile(player, level);
         if (target != null) {
            Vec3 toTarget = target.position().subtract(player.position());
            if (toTarget.lengthSqr() > 1.0) {
               Vec3 dir = toTarget.normalize();
               player.setDeltaMovement(dir.x * 0.6, Math.max(player.getDeltaMovement().y, 0.1), dir.z * 0.6);
               player.hurtMarked = true;
            }

            if (TendrilMantle.strike(player, level, target.position().add(0.0, target.getBbHeight() * 0.5, 0.0)) == null) {
               TendrilFxEntity.spawnWhip(level, player, target, 14, p.strain);
            }

            DamageSource src = level.damageSources().playerAttack(player);
            target.hurt(src, 7.0F * (float)p.stageIntensity());
            if (!target.isAlive()) {
               SymbioteTracker.adjustHunger(level, player, SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get(), "frenzy_kill");
            }
         }
      }
   }

   private static LivingEntity nearestHostile(ServerPlayer player, ServerLevel level) {
      AABB box = player.getBoundingBox().inflate(6.0);
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, box, en -> en != player && en.isAlive() && en instanceof Enemy)) {
         double d = e.distanceToSqr(player);
         if (d < bestSq) {
            bestSq = d;
            best = e;
         }
      }

      return best;
   }

   private Frenzy() {
   }
}
