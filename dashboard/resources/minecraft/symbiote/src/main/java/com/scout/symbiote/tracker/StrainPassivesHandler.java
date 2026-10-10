package com.scout.symbiote.tracker;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class StrainPassivesHandler {
   private static final int TICK_INTERVAL = 100;
   private static final int NIGHT_SPEED_DURATION_TICKS = 140;
   private static final int SUN_VOICE_ONE_IN = 8;
   private static final Random RANDOM = new Random();
   private static final Map<UUID, Boolean> WAS_NIGHT = new HashMap<>();

   @SubscribeEvent
   public static void onPlayerTick(PlayerTickEvent.Post event) {
      if (true) {
         if (event.getEntity() instanceof ServerPlayer player) {
            ServerLevel level = player.serverLevel();
            long now = level.getGameTime();
            if (now % 20L == 0L) {
               SymbioteProfile fast = SymbioteTracker.get(level).peek(player.getUUID());
               if (fast != null && fast.isActive(now)) {
                  SymbioteStrain g = fast.graft != null ? fast.graft.strain : null;
                  if (fast.strain == SymbioteStrain.SHADOW || g == SymbioteStrain.SHADOW) {
                     player.addEffect(new MobEffectInstance(MobEffects.NIGHT_VISION, 600, 0, false, false, false));
                  }
               }
            }

            if (now % 100L == 0L) {
               SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
               if (p != null && p.isActive(now)) {
                  SymbioteStrain graftStrain = p.graft != null ? p.graft.strain : null;
                  if (p.strain == SymbioteStrain.SHADOW || graftStrain == SymbioteStrain.SHADOW) {
                     tickShadow(player, level);
                  }

                  if (StrainTraits.passiveRegen(p.strain) || graftStrain != null && StrainTraits.passiveRegen(graftStrain)) {
                     tickRoyalRegen(player);
                  }
               }
            }
         }
      }
   }

   private static void tickRoyalRegen(ServerPlayer player) {
      if (!(player.getHealth() >= player.getMaxHealth())) {
         if (!CombatSense.inCombat(player)) {
            player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, 140, 1, false, false));
         }
      }
   }

   private static void tickShadow(ServerPlayer player, ServerLevel level) {
      player.addEffect(new MobEffectInstance(MobEffects.NIGHT_VISION, 600, 0, false, false, false));
      boolean skyVisible = level.canSeeSky(BlockPos.containing(player.getX(), player.getEyeY(), player.getZ()));
      if (skyVisible) {
         if (level.isNight()) {
            int amplifier = SymbioteConfig.SHADOW_NIGHT_SPEED_AMPLIFIER.get();
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 140, amplifier, false, false));
            SymbioteProfile prof = SymbioteTracker.get(level).peek(player.getUUID());
            if (prof != null) {
               if (prof.stamina < prof.staminaMax()) {
                  prof.stamina = Math.min(prof.staminaMax(), prof.stamina + 3);
                  SymbioteTracker.get(level).setDirty();
               }

               if (Boolean.FALSE.equals(WAS_NIGHT.put(player.getUUID(), Boolean.TRUE))) {
                  VoiceLines.send(player, "symbiote.voice.shadow_night", 0);
               }
            }

            if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
               SymbioteLog.debug("STRAIN_PASSIVE strain=shadow player={} effect=night_speed amplifier={}", player.getUUID(), amplifier);
            }
         } else if (level.isDay()) {
            WAS_NIGHT.put(player.getUUID(), Boolean.FALSE);
            int stress = SymbioteConfig.SHADOW_DAY_STRESS.get();
            if (stress <= 0) {
               return;
            }

            SymbioteTracker.adjustStress(level, player, stress, "stress_sunlight");
            if (RANDOM.nextInt(8) == 0) {
               VoiceLines.send(player, "symbiote.voice.shadow_sun", 4);
            }
         }
      }
   }

   private StrainPassivesHandler() {
   }
}
