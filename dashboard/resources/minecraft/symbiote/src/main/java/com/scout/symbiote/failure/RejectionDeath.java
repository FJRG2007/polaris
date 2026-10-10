package com.scout.symbiote.failure;

import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

public final class RejectionDeath {
   public static void kill(ServerPlayer player, ServerLevel level) {
      kill(player, level, null);
   }

   public static void kill(ServerPlayer player, ServerLevel level, Vec3 samplePos) {
      SymbioteLog.event("REJECTION_DEATH player={} pos=({},{},{})", player.getUUID(), player.getX(), player.getY(), player.getZ());
      TendrilSceneController.startRejection(player, level, samplePos);
   }

   private RejectionDeath() {
   }
}
