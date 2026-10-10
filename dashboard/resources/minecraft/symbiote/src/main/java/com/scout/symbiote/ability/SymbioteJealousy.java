package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.TamableAnimal;

public final class SymbioteJealousy {
   private static final int DWELL_STEPS = 30;
   private static final int REFRACTORY_STEPS = -120;
   private static final boolean MP_PLAYER_RIVALS_ENABLED = false;
   private static final Map<UUID, Integer> DWELL = new HashMap<>();

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if ((Boolean)SymbioteConfig.JEALOUSY_ENABLED.get()) {
         if (p.stage.isAtLeast(BondStage.INTEGRATED)) {
            if (MoodEngine.current(p) != MoodEngine.Mood.GRIEVING) {
               LivingEntity rival = null;
               boolean rivalIsPlayer = false;
               if (rival == null) {
                  Iterator id = level.getEntitiesOfClass(
                        LivingEntity.class,
                        player.getBoundingBox().inflate(3.0),
                        en -> en.isAlive() && en instanceof TamableAnimal t && player.getUUID().equals(t.getOwnerUUID())
                     )
                     .iterator();
                  if (id.hasNext()) {
                     LivingEntity e = (LivingEntity)id.next();
                     rival = e;
                  }
               }

               UUID id = player.getUUID();
               int dwell = DWELL.getOrDefault(id, 0);
               if (rival == null) {
                  if (dwell > 0) {
                     DWELL.put(id, Math.max(0, dwell - 2));
                  } else if (dwell < 0) {
                     DWELL.put(id, dwell + 1);
                  }
               } else {
                  DWELL.put(id, ++dwell);
                  if (dwell >= 30) {
                     DWELL.put(id, -120);
                     VoiceLines.send(player, rivalIsPlayer ? "symbiote.voice.jealousy_player" : "symbiote.voice.jealousy_pet", 3);
                     ModNetwork.sendOverrideFx(player, "gaze:" + rival.getId(), 35);
                     TendrilMantle.noteFixation(player, rival);
                     ModNetwork.sendOverrideFx(player, "vignette_red", 25);
                     SymbioteLog.event("JEALOUSY_FLARE player={} rival={} type={}", player.getUUID(), rival.getUUID(), rivalIsPlayer ? "player" : "companion");
                  }
               }
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      DWELL.remove(player);
   }

   private SymbioteJealousy() {
   }
}
