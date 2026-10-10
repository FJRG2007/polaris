package com.scout.symbiote.client;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Map.Entry;

public final class OverrideFxClient {
   private static final Map<String, OverrideFxClient.ActiveFx> ACTIVE = new HashMap<>();

   public static void trigger(String fxId, int durationTicks) {
      if (durationTicks > 0) {
         ACTIVE.put(fxId, new OverrideFxClient.ActiveFx(durationTicks, durationTicks));
      }
   }

   public static int getRemaining(String fxId) {
      OverrideFxClient.ActiveFx fx = ACTIVE.get(fxId);
      return fx == null ? 0 : fx.remaining;
   }

   public static int getTotal(String fxId) {
      OverrideFxClient.ActiveFx fx = ACTIVE.get(fxId);
      return fx == null ? 0 : fx.total;
   }

   public static float getFraction(String fxId) {
      OverrideFxClient.ActiveFx fx = ACTIVE.get(fxId);
      return fx != null && fx.total != 0 ? (float)fx.remaining / fx.total : 0.0F;
   }

   public static boolean isActive(String fxId) {
      OverrideFxClient.ActiveFx fx = ACTIVE.get(fxId);
      return fx != null && fx.remaining > 0;
   }

   public static String findActiveWithPrefix(String prefix) {
      for (Entry<String, OverrideFxClient.ActiveFx> e : ACTIVE.entrySet()) {
         if (e.getValue().remaining > 0 && e.getKey().startsWith(prefix)) {
            return e.getKey();
         }
      }

      return null;
   }

   public static int getTotalForActive(String fxId) {
      OverrideFxClient.ActiveFx fx = ACTIVE.get(fxId);
      return fx == null ? 0 : fx.total;
   }

   public static void tick() {
      Iterator<Entry<String, OverrideFxClient.ActiveFx>> it = ACTIVE.entrySet().iterator();

      while (it.hasNext()) {
         Entry<String, OverrideFxClient.ActiveFx> e = it.next();
         e.getValue().remaining--;
         if (e.getValue().remaining <= 0) {
            it.remove();
         }
      }
   }

   public static void reset() {
      ACTIVE.clear();
   }

   private OverrideFxClient() {
   }

   private static final class ActiveFx {
      int remaining;
      final int total;

      ActiveFx(int remaining, int total) {
         this.remaining = remaining;
         this.total = total;
      }
   }
}
