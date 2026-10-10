package com.scout.symbiote.event;

import java.util.Random;
import net.neoforged.neoforge.event.entity.player.CanPlayerSleepEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class SleepTakeoverHandler {
   public static final boolean SLEEP_VAULTED = true;
   private static final double CHANCE_CAP = 0.85;
   private static final Random RANDOM = new Random();

   @SubscribeEvent
   public static void onPlayerSleepInBed(CanPlayerSleepEvent event) {
   }

   private SleepTakeoverHandler() {
   }
}
