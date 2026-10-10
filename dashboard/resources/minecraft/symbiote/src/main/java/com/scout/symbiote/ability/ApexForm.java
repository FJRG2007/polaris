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
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;

public final class ApexForm {
   private static final int AFTERMATH_STRESS = 45;

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      int cooldown = SymbioteConfig.APEX_COOLDOWN_TICKS.get();
      if (now - p.lastApexTick < cooldown) {
         SymbioteLog.event("ABILITY_REJECTED ability=apex player={} reason=on_cooldown", player.getUUID());
      } else {
         p.lastApexTick = now;
         int dur = SymbioteConfig.APEX_DURATION_TICKS.get();
         p.apexUntilTick = now + dur;
         player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_BOOST, dur, 1, false, true));
         player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SPEED, dur, 1, false, true));
         player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, dur, 1, false, true));
         player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, dur, 0, false, true));
         TendrilFxEntity.spawnBurst(level, player, 30, p.strain);
         VoiceLines.send(player, "symbiote.voice.apex", 3);
         ModNetwork.sendOverrideFx(player, "vignette_red", 40);
         SymbioteLog.event("ABILITY_FIRED ability=apex player={} until={}", player.getUUID(), p.apexUntilTick);
      }
   }

   public static void onExpire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      SymbioteTracker.adjustStress(level, player, 45, "apex_aftermath");
      player.addEffect(new MobEffectInstance(MobEffects.WEAKNESS, 100, 0, false, true));
      player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 100, 0, false, true));
      VoiceLines.send(player, "symbiote.voice.control_struggle", 4);
      SymbioteLog.event("APEX_AFTERMATH player={} stress_added={}", player.getUUID(), 45);
   }

   private ApexForm() {
   }
}
