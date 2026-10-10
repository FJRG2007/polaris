package com.scout.symbiote.ability;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.GraftState;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class GraftTicker {
   private static final int INTERVAL = 100;
   private static final int CHATTER_GAP = 2400;
   private static final int HUNGER_DRAIN = 1;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      GraftState g = p.graft;
      if (g != null) {
         if (now % 100L == 0L) {
            g.addHunger(-1);
            double pressure = GraftFlow.tensionPressure(p);
            if (p.trust >= 70) {
               pressure -= 0.7;
            }

            if (MoodEngine.current(p) == MoodEngine.Mood.CONTENT) {
               pressure -= 0.4;
            }

            if (g.isStarving()) {
               pressure += 0.5;
            }

            int before = g.tension;
            if (pressure >= 0.0) {
               if (level.random.nextDouble() < pressure - Math.floor(pressure)) {
                  g.addTension(1);
               }

               g.addTension((int)Math.floor(pressure));
            } else if (level.random.nextDouble() < -pressure) {
               g.addTension(-1);
            }

            if (before < 60 && g.tension >= 60) {
               VoiceLines.sendAs(player, "symbiote.voice.graft_tension_warn", 4, p.strain);
            } else if (before < 85 && g.tension >= 85) {
               VoiceLines.sendAs(player, "symbiote.voice.graft_tension_final", 3, p.strain);
            }

            if (g.tension >= 100 && !TendrilSceneController.isInScene(player.getUUID())) {
               SymbioteLog.event("GRAFT_PURGE_TRIGGER player={} graft={} tension=100", player.getUUID(), g.strain);
               TendrilSceneController.startGraftPurge(player, level, p.strain, g.strain);
               SymbioteTracker.get(level).setDirty();
            } else {
               if (now - g.lastActTick > 2400L && level.random.nextInt(4) == 0 && !TendrilSceneController.isInScene(player.getUUID())) {
                  g.lastActTick = now;
                  String pool = g.isStarving()
                     ? "symbiote.voice.graft_hungry"
                     : (g.tension >= 60 ? "symbiote.voice.graft_bicker" : "symbiote.voice.graft_idle");
                  VoiceLines.sendAs(player, pool, 0, g.strain);
               }

               SymbioteTracker.get(level).setDirty();
               ModNetwork.syncToPlayer(level, player);
            }
         }
      }
   }

   public static void onHostFed(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      GraftState g = p.graft;
      if (g != null) {
         if (p.hunger >= 85) {
            g.addHunger(12);
            g.addTension(-2);
         } else {
            g.addHunger(3);
            g.addTension(2);
         }
      }
   }

   public static float armorBonus(SymbioteProfile p) {
      return p.graft == null ? 0.0F : 0.1F;
   }

   private GraftTicker() {
   }
}
