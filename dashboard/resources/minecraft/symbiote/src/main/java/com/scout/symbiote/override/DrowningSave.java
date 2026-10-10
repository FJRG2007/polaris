package com.scout.symbiote.override;

import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.phys.Vec3;

public final class DrowningSave {
   private static final int AIR_TRIGGER = 60;
   private static final int MAX_TICKS = 120;
   private static final int RETRY_COOLDOWN = 300;
   private static final Map<UUID, Long> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> NEXT_TRY = new HashMap<>();

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      Long started = ACTIVE.get(player.getUUID());
      if (started != null) {
         haul(player, level, p, now, started);
      } else if ((Boolean)SymbioteConfig.DROWNING_SAVE_ENABLED.get()) {
         if (player.getAirSupply() <= 60) {
            if (player.isEyeInFluid(FluidTags.WATER)) {
               if (!player.hasEffect(MobEffects.WATER_BREATHING) && !player.hasEffect(MobEffects.CONDUIT_POWER)) {
                  if (!player.isPassenger()) {
                     if (!TendrilSceneController.isInScene(player.getUUID())) {
                        Long next = NEXT_TRY.get(player.getUUID());
                        if (next == null || now >= next) {
                           WalkSeizure.abort(player, level, p, "drowning");
                           DeepSeizure.abort(player, level, p, "drowning");
                           SymbioteCuriosity.abortStare(player);
                           ACTIVE.put(player.getUUID(), now);
                           OverrideGate.seize(player, level, p, "drowning_save");
                           ModNetwork.sendOverrideFx(player, "vignette_red", 25);
                           VoiceLines.send(player, "symbiote.voice.drowning", 3);
                           SymbioteLog.overrideFired(player.getUUID(), "drowning_save", "air_critical", "air", player.getAirSupply(), "y", (int)player.getY());
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void haul(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, long started) {
      if (!player.isEyeInFluid(FluidTags.WATER) || player.getAirSupply() > 100) {
         ACTIVE.remove(player.getUUID());
         SymbioteLog.event("DROWNING_SAVE_END player={} result=surfaced air={}", player.getUUID(), player.getAirSupply());
      } else if (now - started > 120L) {
         ACTIVE.remove(player.getUUID());
         NEXT_TRY.put(player.getUUID(), now + 300L);
         SymbioteLog.event("DROWNING_SAVE_END player={} result=no_surface", player.getUUID());
      } else {
         if ((now - started) % 5L == 0L) {
            BlockPos above = BlockPos.containing(player.getEyePosition()).above();
            if (level.getBlockState(above).is(BlockTags.ICE)) {
               level.destroyBlock(above, false, player);
               SymbioteLog.event("DROWNING_SAVE_ICE_BREAK player={} pos={}", player.getUUID(), above);
            }
         }

         Vec3 dm = player.getDeltaMovement();
         player.setDeltaMovement(dm.x * 0.6, 0.55, dm.z * 0.6);
         player.hurtMarked = true;
      }
   }

   public static void onLogout(UUID player) {
      ACTIVE.remove(player);
      NEXT_TRY.remove(player);
   }

   private DrowningSave() {
   }
}
