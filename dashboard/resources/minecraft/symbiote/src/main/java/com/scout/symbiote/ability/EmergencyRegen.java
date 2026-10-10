package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;

public final class EmergencyRegen {
   public static void maybeTrigger(ServerPlayer player, ServerLevel level, SymbioteProfile p, float incomingDamage) {
      if (p.stage.isBonded()) {
         long now = level.getGameTime();
         if (now - p.lastOverrideTick >= SymbioteConfig.EMERGENCY_REGEN_COOLDOWN_TICKS.get().intValue()) {
            float postHp = player.getHealth() - incomingDamage;
            if (!(postHp > 1.5F)) {
               if (p.hunger < 30) {
                  SymbioteLog.event("OVERRIDE_SKIPPED type=emergency_regen player={} reason=insufficient_hunger", player.getUUID());
               } else {
                  player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, 100, 2, false, true));
                  player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, 100, 1, false, true));
                  SymbioteTracker.adjustHunger(level, player, -25, "emergency_regen_burn");
                  SymbioteTracker.adjustStress(level, player, 15, "emergency_regen_aftermath");
                  p.lastOverrideTick = now;
                  SymbioteLog.overrideFired(
                     player.getUUID(), "emergency_regen", "post_hp_lethal", "post_hp", String.format("%.2f", postHp), "incoming", incomingDamage
                  );
                  ModNetwork.sendOverrideFx(player, "bond_up", 35);
                  VoiceLines.send(player, "symbiote.voice.emergency_regen", 3);
               }
            }
         }
      }
   }

   private EmergencyRegen() {
   }
}
