package com.scout.symbiote.override;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import java.util.Set;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;

public final class OverrideGate {
   private static final Set<String> SAVE_TYPES = Set.of("drowning_save", "creeper_save", "void_save", "low_health_override", "host_feed");

   public static boolean check(ServerPlayer player, ServerLevel level, SymbioteProfile p, String type) {
      if (!p.stage.isBonded()) {
         return logSkip(player, type, "unbonded");
      } else {
         long now = level.getGameTime();
         if (p.isDormant(now)) {
            return logSkip(player, type, "dormant");
         } else {
            return now - p.lastOverrideTick < SymbioteConfig.OVERRIDE_GLOBAL_COOLDOWN_TICKS.get().intValue() ? logSkip(player, type, "global_cooldown") : true;
         }
      }
   }

   public static void stamp(ServerLevel level, SymbioteProfile p) {
      p.lastOverrideTick = level.getGameTime();
   }

   public static void seize(ServerPlayer player, ServerLevel level, SymbioteProfile p, String type) {
      stamp(level, p);
      if (SAVE_TYPES.contains(type)) {
         p.addBeat(MoodEngine.BeatType.SAVE, level.getGameTime(), type);
      }

      level.playSound(
         null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.OVERRIDE_SEIZURE.get(), SoundSource.PLAYERS, 0.7F, 1.0F
      );
   }

   private static boolean logSkip(ServerPlayer player, String type, String reason) {
      SymbioteLog.overrideSkipped(player.getUUID(), type, reason);
      return false;
   }

   private OverrideGate() {
   }
}
