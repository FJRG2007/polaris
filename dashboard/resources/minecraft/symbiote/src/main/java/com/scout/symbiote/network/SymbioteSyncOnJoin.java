package com.scout.symbiote.network;

import com.scout.symbiote.util.ForeignHooks;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.PlayerLoggedInEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class SymbioteSyncOnJoin {
   @SubscribeEvent
   public void onPlayerLoggedIn(PlayerLoggedInEvent event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         if (player.level() instanceof ServerLevel level) {
            player.refreshDimensions();
            ModNetwork.syncToPlayer(level, player);
            String foreign = ForeignHooks.playerWarning();
            if (foreign != null) {
               player.sendSystemMessage(Component.literal(foreign));
            }
         }
      }
   }
}
