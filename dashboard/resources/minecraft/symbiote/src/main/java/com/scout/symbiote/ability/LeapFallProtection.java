package com.scout.symbiote.ability;

import com.scout.symbiote.util.BodyControl;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;

public final class LeapFallProtection {
   private static final Map<UUID, Long> LAUNCHED = new HashMap<>();
   private static final int WINDOW_TICKS = 60;

   public static void tag(UUID player, long launchTick) {
      LAUNCHED.put(player, launchTick);
   }

   public static boolean isProtected(UUID player, long currentTick) {
      Long launch = LAUNCHED.get(player);
      if (launch == null) {
         return false;
      }

      if (currentTick - launch <= 60L) {
         return true;
      }

      Long grounded = BodyControl.lastGroundedTick(player);
      return grounded == null || launch >= grounded;
   }

   public static boolean consume(UUID player, long currentTick) {
      boolean covered = isProtected(player, currentTick);
      LAUNCHED.remove(player);
      return covered;
   }

   public static void purgeExpired(long currentTick) {
      Iterator<Entry<UUID, Long>> it = LAUNCHED.entrySet().iterator();

      while (it.hasNext()) {
         if (currentTick - it.next().getValue() > 12000L) {
            it.remove();
         }
      }
   }

   public static void onLogout(UUID player) {
      LAUNCHED.remove(player);
   }

   private LeapFallProtection() {
   }
}
