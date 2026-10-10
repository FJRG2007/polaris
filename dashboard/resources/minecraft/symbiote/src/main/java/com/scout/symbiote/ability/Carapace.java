package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class Carapace {
   public static final boolean VAULTED = true;
   public static final float DAMAGE_REDUCTION = 0.65F;

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      int cooldown = SymbioteConfig.CARAPACE_COOLDOWN_TICKS.get();
      if (now - p.lastCarapaceTick < cooldown) {
         SymbioteLog.event("ABILITY_REJECTED ability=carapace player={} reason=on_cooldown", player.getUUID());
      } else {
         p.lastCarapaceTick = now;
         p.carapaceUntilTick = now + SymbioteConfig.CARAPACE_DURATION_TICKS.get().intValue();
         TendrilFxEntity.spawnBurst(level, player, 25, p.strain);
         VoiceLines.send(player, "symbiote.voice.carapace", 0);
         ModNetwork.sendOverrideFx(player, "bond_up", 30);
         SymbioteLog.event("ABILITY_FIRED ability=carapace player={} until={}", player.getUUID(), p.carapaceUntilTick);
      }
   }

   private Carapace() {
   }
}
