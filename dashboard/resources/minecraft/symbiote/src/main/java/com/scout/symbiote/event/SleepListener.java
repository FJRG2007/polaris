package com.scout.symbiote.event;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.neoforged.neoforge.event.level.SleepFinishedTimeEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class SleepListener {
   public static final boolean SLEEP_BOND_VAULTED = true;
   private static final long AWARD_COOLDOWN_MS = 60000L;
   private static final Map<UUID, Long> LAST_AWARD = new HashMap<>();

   @SubscribeEvent
   public void onSleepFinished(SleepFinishedTimeEvent event) {
   }

   public static void onLogout(UUID player) {
      LAST_AWARD.remove(player);
   }
}
