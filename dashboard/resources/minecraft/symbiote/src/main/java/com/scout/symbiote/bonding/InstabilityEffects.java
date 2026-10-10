package com.scout.symbiote.bonding;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.Random;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;

public final class InstabilityEffects {
   private static final Random R = new Random();

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      if (now % 600L == 0L && R.nextInt(2) == 0) {
         player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 80, 1, false, true));
         SymbioteLog.event("INSTABILITY effect=speed_burst player={}", player.getUUID());
      }

      if (now % 800L == 100L && R.nextInt(2) == 0) {
         player.addEffect(new MobEffectInstance(MobEffects.DIG_SPEED, 80, 1, false, true));
         SymbioteLog.event("INSTABILITY effect=haste player={}", player.getUUID());
      }

      if (now % 1200L == 200L && R.nextInt(2) == 0) {
         player.addEffect(new MobEffectInstance(MobEffects.CONFUSION, 120, 0, false, true));
         SymbioteLog.event("INSTABILITY effect=nausea player={}", player.getUUID());
      }

      if (now % 400L == 300L && R.nextInt(2) == 0) {
         VoiceLines.send(player, "symbiote.voice.instability", 2);
      }

      if (now % 700L == 350L && R.nextInt(3) == 0) {
         ModNetwork.sendOverrideFx(player, "vignette_black", 20);
      }
   }

   private InstabilityEffects() {
   }
}
