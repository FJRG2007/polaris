package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class Nightstep {
   public static boolean fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      boolean night = !level.isDay();
      double range = night ? SymbioteConfig.NIGHTSTEP_RANGE_NIGHT.get() : SymbioteConfig.NIGHTSTEP_RANGE_DAY.get();
      Vec3 eye = player.getEyePosition();
      Vec3 look = player.getLookAngle();
      double eyeH = player.getEyeHeight();
      Vec3 dest = null;

      for (double d = range; d >= 1.0; d -= 0.5) {
         Vec3 feet = eye.add(look.scale(d)).subtract(0.0, eyeH, 0.0);

         for (int dy : new int[]{0, 1, -1, 2, -2}) {
            Vec3 cand = feet.add(0.0, dy, 0.0);
            if (fits(level, player, cand)) {
               dest = cand;
               break;
            }
         }

         if (dest != null) {
            break;
         }
      }

      if (dest == null) {
         return false;
      }

      double destY = dest.y;
      Vec3 origin = player.position();
      double reached = origin.distanceTo(dest);
      TendrilFxEntity.spawnBurst(level, player, 22, p.strain);
      level.sendParticles(ParticleTypes.SQUID_INK, origin.x, origin.y + 1.0, origin.z, 12, 0.3, 0.5, 0.3, 0.01);
      player.teleportTo(dest.x, destY, dest.z);
      player.fallDistance = 0.0F;
      player.addEffect(new MobEffectInstance(MobEffects.INVISIBILITY, 20, 0, false, false));
      level.sendParticles(ParticleTypes.SMOKE, dest.x, destY + 1.0, dest.z, 14, 0.3, 0.5, 0.3, 0.02);

      for (Mob m : level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(20.0))) {
         if (m.getTarget() == player) {
            m.setTarget(null);
         }
      }

      VoiceLines.send(player, "symbiote.voice.nightstep", 0);
      ModNetwork.sendOverrideFx(player, "vignette_black", 16);
      SymbioteLog.event("STRAIN_ABILITY ability=nightstep player={} night={} dist={}", player.getUUID(), night, reached);
      return true;
   }

   private static boolean fits(ServerLevel level, ServerPlayer player, Vec3 feet) {
      AABB at = player.getBoundingBox().move(feet.x - player.getX(), feet.y - player.getY(), feet.z - player.getZ());
      return level.noCollision(player, at);
   }

   private Nightstep() {
   }
}
