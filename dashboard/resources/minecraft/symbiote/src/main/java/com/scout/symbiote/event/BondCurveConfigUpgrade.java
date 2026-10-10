package com.scout.symbiote.event;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.util.SymbioteLog;
import net.neoforged.neoforge.event.server.ServerAboutToStartEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class BondCurveConfigUpgrade {
   @SubscribeEvent
   public static void onServerAboutToStart(ServerAboutToStartEvent event) {
      if ((Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get() == 40
         && (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get() == 65
         && (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get() == 88) {
         SymbioteConfig.STAGE_INTEGRATED_BOND.set(120);
         SymbioteConfig.STAGE_COOPERATIVE_BOND.set(240);
         SymbioteConfig.STAGE_DOMINANT_BOND.set(400);
         SymbioteLog.event("BOND_CURVE_CONFIG_UPGRADED 100/40/65/88 -> 500/120/240/400 (v1.0 defaults detected. customized configs are never touched)");
      }
   }

   private BondCurveConfigUpgrade() {
   }
}
