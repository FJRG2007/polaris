package com.scout.symbiote.ability;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class GraftFlow {
   public static final boolean GRAFT_ENABLED = false;
   private static final BondStage REFUSAL_STAGE = BondStage.DOMINANT;

   public static GraftFlow.Eligibility check(SymbioteProfile p) {
      return GraftFlow.Eligibility.NOT_BONDED;
   }

   public static void attach(ServerPlayer player, ServerLevel level, SymbioteStrain graftStrain) {
   }

   public static void detach(ServerPlayer player, ServerLevel level, String reason) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null && p.graft != null) {
         SymbioteStrain was = p.graft.strain;
         p.graft = null;
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         SymbioteLog.event("GRAFT_DETACHED player={} was={} reason={}", player.getUUID(), was, reason);
      }
   }

   public static int baseTension(SymbioteStrain primary, SymbioteStrain graft) {
      int t = 15;
      if (primary == graft) {
         t += 30;
      }

      if (primary == SymbioteStrain.ROYAL) {
         t += 20;
      }

      if (primary == SymbioteStrain.GUARDIAN) {
         t -= 8;
      }

      if (graft == SymbioteStrain.ROYAL) {
         t += 10;
      }

      return Math.max(0, Math.min(100, t));
   }

   public static double tensionPressure(SymbioteProfile p) {
      if (p.graft == null) {
         return 0.0;
      }

      double pressure = 0.5;

      pressure += switch (p.stage) {
         case COOPERATIVE -> 0.6;
         case DOMINANT -> 1.4;
         default -> 0.0;
      };
      if (p.strain == p.graft.strain) {
         pressure += 0.5;
      }

      if (p.strain == SymbioteStrain.ROYAL) {
         pressure += 0.4;
      }

      if (p.graft.isStarving()) {
         pressure += 0.6;
      }

      return pressure;
   }

   private GraftFlow() {
   }

   public enum Eligibility {
      CAN_GRAFT,
      REFUSED_TOO_DEEP,
      ALREADY_GRAFTED,
      NOT_BONDED;
   }
}
