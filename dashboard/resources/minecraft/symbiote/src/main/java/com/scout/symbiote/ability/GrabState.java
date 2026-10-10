package com.scout.symbiote.ability;

import com.scout.symbiote.entity.TendrilFxEntity;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;

public final class GrabState {
   public static final int GRAB_TIMEOUT_TICKS = 160;
   private static final Map<UUID, GrabState.Held> HELD = new HashMap<>();

   public static void start(UUID player, int targetId, long tick, TendrilFxEntity fx) {
      HELD.put(player, new GrabState.Held(targetId, tick, fx.getId()));
   }

   public static GrabState.Held get(UUID player) {
      return HELD.get(player);
   }

   public static boolean isHolding(UUID player) {
      return HELD.containsKey(player);
   }

   public static void clear(UUID player) {
      HELD.remove(player);
   }

   public static void purgeStale(long currentTick) {
      Iterator<Entry<UUID, GrabState.Held>> it = HELD.entrySet().iterator();

      while (it.hasNext()) {
         GrabState.Held h = it.next().getValue();
         if (currentTick - h.grabStartTick > 160L) {
            it.remove();
         }
      }
   }

   private GrabState() {
   }

   public static final class Held {
      public final int targetEntityId;
      public final long grabStartTick;
      public final int tendrilFxId;

      public Held(int targetEntityId, long grabStartTick, int tendrilFxId) {
         this.targetEntityId = targetEntityId;
         this.grabStartTick = grabStartTick;
         this.tendrilFxId = tendrilFxId;
      }
   }
}
