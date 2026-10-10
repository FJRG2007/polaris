package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class AegisBloom {
   public static boolean fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      int dur = SymbioteConfig.AEGIS_DURATION_TICKS.get();
      p.aegisUntilTick = now + dur;
      player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, dur, 1, false, true));
      player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, dur, 0, false, false));
      double range = SymbioteConfig.AEGIS_RANGE.get();
      AABB box = player.getBoundingBox().inflate(range);

      for (Player ally : level.getEntitiesOfClass(Player.class, box, pl -> pl != player)) {
         ally.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, dur, 0, false, true));
      }

      for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, box, en -> en != player && en.isAlive() && en instanceof Enemy)) {
         Vec3 away = e.position().subtract(player.position());
         if (away.lengthSqr() < 1.0E-4) {
            away = new Vec3(player.getRandom().nextGaussian(), 0.0, player.getRandom().nextGaussian());
         }

         Vec3 n = away.normalize();
         e.setDeltaMovement(n.x * 1.2, 0.4, n.z * 1.2);
         e.hurtMarked = true;
         e.hurt(level.damageSources().playerAttack(player), 2.0F);
      }

      TendrilFxEntity.spawnBurst(level, player, 26, p.strain);
      VoiceLines.send(player, "symbiote.voice.aegis", 1);
      ModNetwork.sendOverrideFx(player, "bond_up", 30);
      SymbioteLog.event("STRAIN_ABILITY ability=aegis_bloom player={} until={}", player.getUUID(), p.aegisUntilTick);
      return true;
   }

   private AegisBloom() {
   }
}
