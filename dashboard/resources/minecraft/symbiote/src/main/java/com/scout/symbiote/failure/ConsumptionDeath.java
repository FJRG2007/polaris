package com.scout.symbiote.failure;

import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class ConsumptionDeath {
   public static void consume(ServerPlayer player, ServerLevel level, String reason) {
      SymbioteLog.event("CONSUMPTION_DEATH player={} reason={}", player.getUUID(), reason);
      TendrilSceneController.startConsumption(player, level);
   }

   private ConsumptionDeath() {
   }
}
