package com.scout.symbiote.voice;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;

public final class Vindication {
   private static final float CHANCE = 0.4F;
   private static final long COOLDOWN_TICKS = 1200L;
   private static final long DELAY_TICKS = 22L;
   private static final Map<UUID, Long> PENDING = new HashMap<>();
   private static final Map<UUID, Long> LAST = new HashMap<>();

   public static void consider(ServerPlayer player, long now) {
      UUID id = player.getUUID();
      Long last = LAST.get(id);
      if (last == null || now - last >= 1200L) {
         if (!(player.getRandom().nextFloat() >= 0.4F)) {
            PENDING.put(id, now + 22L);
         }
      }
   }

   public static void tick(ServerPlayer player, long now) {
      UUID id = player.getUUID();
      Long at = PENDING.get(id);
      if (at != null && now >= at) {
         PENDING.remove(id);
         LAST.put(id, now);
         VoiceLines.send(player, "symbiote.voice.vindication", 0);
      }
   }

   public static void clear(UUID player) {
      PENDING.remove(player);
      LAST.remove(player);
   }

   public static void onLogout(UUID player) {
      PENDING.remove(player);
      LAST.remove(player);
   }

   private Vindication() {
   }
}
