package com.scout.symbiote.client;

import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingIn;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingOut;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class SymbioteClientResetHandler {
   @SubscribeEvent
   public void onLoggingOut(LoggingOut event) {
      SymbioteClientState.reset();
      OverrideFxClient.reset();
      SymbioteVoiceClient.reset();
      SculkGlowClient.reset();
   }

   @SubscribeEvent
   public void onLoggingIn(LoggingIn event) {
      SymbioteClientState.reset();
      OverrideFxClient.reset();
      SymbioteVoiceClient.reset();
      SculkGlowClient.reset();
   }

   @SubscribeEvent
   public void onClientTick(ClientTickEvent.Post event) {
      if (true) {
         SymbioteClientState.incrementTick();
         OverrideFxClient.tick();
         SymbioteVoiceClient.tick();
      }
   }
}
