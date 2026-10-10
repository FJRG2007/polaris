package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class TendrilLash {
   public static final boolean VAULTED = true;
   private static final float BASE_DAMAGE = 5.0F;

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      int cooldown = SymbioteConfig.TENDRIL_LASH_COOLDOWN_TICKS.get();
      if (now - p.lastTendrilLashTick < cooldown) {
         SymbioteLog.event("ABILITY_REJECTED ability=tendril_lash player={} reason=on_cooldown", player.getUUID());
      } else {
         p.lastTendrilLashTick = now;
         double range = SymbioteConfig.TENDRIL_LASH_RANGE.get();
         AABB box = player.getBoundingBox().inflate(range);
         List<LivingEntity> targets = level.getEntitiesOfClass(
            LivingEntity.class, box, e -> e != player && e.isAlive() && e.distanceToSqr(player) <= range * range && !isProtectedAlly(e)
         );
         float damage = 5.0F * (float)p.stageIntensity();
         DamageSource src = level.damageSources().playerAttack(player);
         int hit = 0;

         for (LivingEntity target : targets) {
            if (TendrilMantle.strike(player, level, target.position().add(0.0, target.getBbHeight() * 0.5, 0.0)) == null) {
               TendrilFxEntity.spawnWhip(level, player, target, 18, p.strain);
            }

            target.hurt(src, damage);
            Vec3 away = target.position().subtract(player.position());
            if (away.lengthSqr() < 1.0E-4) {
               away = new Vec3(player.getRandom().nextGaussian(), 0.0, player.getRandom().nextGaussian());
            }

            Vec3 awayN = away.normalize();
            target.setDeltaMovement(awayN.x * 1.4, 0.45, awayN.z * 1.4);
            target.hurtMarked = true;
            hit++;
         }

         VoiceLines.send(player, "symbiote.voice.tendril_lash", 3);
         ModNetwork.sendOverrideFx(player, "tendril_burst", 18);
         SymbioteLog.event("ABILITY_FIRED ability=tendril_lash player={} targets_hit={} damage={}", player.getUUID(), hit, damage);
      }
   }

   private static boolean isProtectedAlly(LivingEntity e) {
      if (!(Boolean)SymbioteConfig.PROTECT_ALLIES.get()) {
         return false;
      } else if (e instanceof Player) {
         return true;
      } else {
         return e instanceof TamableAnimal tamable && tamable.isTame() ? true : e.hasCustomName();
      }
   }

   private TendrilLash() {
   }
}
