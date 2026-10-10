package com.scout.symbiote.ability;

import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class VoidFarewell {
   private static final int SAID_WINDOW_TICKS = 200;
   private static final Map<UUID, Long> SAID = new HashMap<>();

   public static void onVoidFall(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      Long said = SAID.get(player.getUUID());
      if (said == null || now - said >= 200L) {
         SAID.put(player.getUUID(), now);
         VoiceLines.send(player, "symbiote.voice.void_farewell", 3);
         SymbioteLog.event("VOID_FAREWELL player={} bond={} stage={}", player.getUUID(), p.bond, p.stage);
      }
   }

   public static boolean inDyingSilence(UUID player, long now) {
      Long said = SAID.get(player);
      return said != null && now - said < 200L;
   }

   public static void onLogout(UUID player) {
      SAID.remove(player);
   }

   private VoidFarewell() {
   }
}
