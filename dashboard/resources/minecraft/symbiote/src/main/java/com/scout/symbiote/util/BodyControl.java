package com.scout.symbiote.util;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class BodyControl {
   private static final Map<UUID, Long> LAST = new HashMap<>();
   private static final Map<UUID, Long> LAST_GROUNDED = new HashMap<>();

   public static void note(UUID player, long now) {
      LAST.put(player, now);
   }

   public static void noteGrounded(UUID player, long now) {
      LAST_GROUNDED.put(player, now);
   }

   public static Long lastGroundedTick(UUID player) {
      return LAST_GROUNDED.get(player);
   }

   public static boolean recent(UUID player, long now, int windowTicks) {
      Long t = LAST.get(player);
      return t != null && now - t <= windowTicks;
   }

   public static boolean fallProtected(UUID player, long now, int windowTicks) {
      if (recent(player, now, windowTicks)) {
         return true;
      }

      Long control = LAST.get(player);
      Long grounded = LAST_GROUNDED.get(player);
      return control != null && grounded != null && control >= grounded;
   }

   public static void onLogout(UUID player) {
      LAST.remove(player);
      LAST_GROUNDED.remove(player);
   }

   private BodyControl() {
   }
}
