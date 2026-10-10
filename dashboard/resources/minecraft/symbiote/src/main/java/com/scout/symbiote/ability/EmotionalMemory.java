package com.scout.symbiote.ability;

import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class EmotionalMemory {
   private static final int MEMORY_MIN_AGE_TICKS = 6000;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (!(Math.random() > 0.25)) {
         if (!CombatSense.inCombat(player)) {
            if (!TendrilSceneController.isInScene(player.getUUID()) && !WalkSeizure.isActive(player.getUUID()) && !DeepSeizure.isActive(player.getUUID())) {
               if (p.desireType < 0) {
                  SymbioteProfile.Beat strongest = null;

                  for (SymbioteProfile.Beat b : p.beats) {
                     if (now - b.tick >= 6000L
                        && callbackPool(b.type) != null
                        && (
                           strongest == null
                              || Math.abs(b.weight) > Math.abs(strongest.weight)
                              || Math.abs(b.weight) == Math.abs(strongest.weight) && b.tick > strongest.tick
                        )) {
                        strongest = b;
                     }
                  }

                  if (strongest != null) {
                     String pool = callbackPool(strongest.type);
                     VoiceLines.send(player, pool, strongest.weight < 0 ? 2 : 1);
                     SymbioteLog.event(
                        "MEMORY_CALLBACK player={} beat={} age={}s",
                        player.getUUID(),
                        MoodEngine.BeatType.values()[strongest.type],
                        (now - strongest.tick) / 20L
                     );
                  }
               }
            }
         }
      }
   }

   private static String callbackPool(int typeOrdinal) {
      MoodEngine.BeatType[] types = MoodEngine.BeatType.values();
      if (typeOrdinal >= 0 && typeOrdinal < types.length) {
         return switch (types[typeOrdinal]) {
            case STARVED -> "symbiote.voice.memory_starved";
            case STAND -> "symbiote.voice.memory_stand";
            case TOOL_RECLAIMED -> "symbiote.voice.memory_reclaimed";
            case DESIRE_IGNORED -> "symbiote.voice.memory_ignored";
            default -> null;
         };
      } else {
         return null;
      }
   }

   private EmotionalMemory() {
   }
}
