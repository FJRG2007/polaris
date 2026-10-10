package com.scout.symbiote.client.armor;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.player.Player;
import net.neoforged.fml.ModList;

public final class EpicFightArmorDiagnostics {
   private static final boolean ENABLED = ModList.get().isLoaded("epicfight");
   private static Player measuredPlayer;
   private static int startTick;
   private static int playerPasses;
   private static int layerCalls;

   public static void playerPass(Player player) {
      if (ENABLED && player == Minecraft.getInstance().player) {
         if (measuredPlayer != player || player.tickCount < startTick) {
            measuredPlayer = player;
            startTick = player.tickCount;
            playerPasses = 0;
            layerCalls = 0;
         }

         playerPasses++;
         if (player.tickCount - startTick >= 100) {
            if (SymbioteLog.verbose()) {
               SymbioteMod.LOGGER
                  .info(
                     "[epic_armor] player_passes={} shell_layer_calls={} shell_progress={}",
                     new Object[]{playerPasses, layerCalls, LivingArmorRenderLayer.progressOf(player.getUUID())}
                  );
            }

            startTick = player.tickCount;
            playerPasses = 0;
            layerCalls = 0;
         }
      }
   }

   public static void layerCall(Player player) {
      if (ENABLED && player == Minecraft.getInstance().player) {
         layerCalls++;
      }
   }

   private EpicFightArmorDiagnostics() {
   }
}
