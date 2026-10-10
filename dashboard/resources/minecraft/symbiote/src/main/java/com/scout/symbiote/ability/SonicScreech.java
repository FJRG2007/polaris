package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class SonicScreech {
   private static final double CONE_COS = 0.57;

   public static boolean fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      double range = SymbioteConfig.SCREECH_RANGE.get();
      Vec3 look = player.getLookAngle().normalize();
      Vec3 eye = player.getEyePosition();
      AABB box = player.getBoundingBox().inflate(range);
      DamageSource src = level.damageSources().sonicBoom(player);
      float dmg = SymbioteConfig.SCREECH_DAMAGE.get().floatValue() * (float)p.stageIntensity();
      int hit = 0;

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, box, en -> en != player && en.isAlive())) {
         e.addEffect(new MobEffectInstance(MobEffects.GLOWING, 100, 0, false, false));
         Vec3 toE = e.position().add(0.0, e.getBbHeight() * 0.5, 0.0).subtract(eye);
         if (!(toE.lengthSqr() < 1.0E-4) && !(look.dot(toE.normalize()) < 0.57)) {
            e.hurt(src, dmg);
            Vec3 kb = look.scale(1.0);
            e.setDeltaMovement(kb.x, 0.3, kb.z);
            e.hurtMarked = true;
            e.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 40, 2, false, false));
            hit++;
         }
      }

      TendrilFxEntity.spawnBurst(level, player, 18, p.strain);
      level.playSound(null, player.blockPosition(), SoundEvents.WARDEN_SONIC_BOOM, SoundSource.PLAYERS, 1.0F, 1.2F);
      VoiceLines.send(player, "symbiote.voice.screech", 3);
      ModNetwork.sendOverrideFx(player, "bell_stun", 16);
      SymbioteLog.event("STRAIN_ABILITY ability=sonic_screech player={} hit={} dmg={}", player.getUUID(), hit, dmg);
      return true;
   }

   private SonicScreech() {
   }
}
