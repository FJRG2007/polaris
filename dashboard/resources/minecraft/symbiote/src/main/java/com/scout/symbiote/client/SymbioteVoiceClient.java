package com.scout.symbiote.client;

import com.scout.symbiote.SymbioteMod;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.language.I18n;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;

public final class SymbioteVoiceClient {
   private static final int DISPLAY_TICKS = 80;
   private static final int FADE_TICKS = 15;
   private static String activeLine = null;
   private static int remainingTicks = 0;
   private static int totalTicks = 0;
   private static int toneCode = 0;
   private static int speakerStrain = -1;
   private static final ResourceLocation STING_UP = ResourceLocation.fromNamespaceAndPath("symbiote", "voice_up");
   private static final ResourceLocation STING_DOWN = ResourceLocation.fromNamespaceAndPath("symbiote", "voice_down");
   private static final ResourceLocation STING_AGGRESSIVE = ResourceLocation.fromNamespaceAndPath("symbiote", "voice_aggressive");
   private static final ResourceLocation STING_WARNING = ResourceLocation.fromNamespaceAndPath("symbiote", "voice_warning");

   public static void show(String key, int tone) {
      show(key, tone, -1);
   }

   public static void show(String key, int tone, int speaker) {
      activeLine = key;
      remainingTicks = 80;
      totalTicks = 80;
      toneCode = tone;
      speakerStrain = speaker;
      playSting(tone);
      Minecraft mc = Minecraft.getInstance();
      if (mc.player != null) {
         String text = resolve(key);
         mc.player.displayClientMessage(Component.literal("§8» §7§o" + text), false);
      }
   }

   public static void tick() {
      if (remainingTicks > 0) {
         remainingTicks--;
      }

      if (remainingTicks == 0) {
         activeLine = null;
      }
   }

   public static void reset() {
      activeLine = null;
      remainingTicks = 0;
      toneCode = 0;
      speakerStrain = -1;
   }

   public static int getSpeakerStrain() {
      return speakerStrain;
   }

   public static String getActiveLine() {
      return activeLine;
   }

   public static int getRemainingTicks() {
      return remainingTicks;
   }

   public static int getTotalTicks() {
      return totalTicks;
   }

   public static int getFadeTicks() {
      return 15;
   }

   public static int getToneCode() {
      return toneCode;
   }

   public static String resolve(String key) {
      if (key.startsWith("literal:")) {
         return key.substring("literal:".length());
      }

      try {
         return I18n.get(key, new Object[0]);
      } catch (Exception e) {
         return key;
      }
   }

   private static void playSting(int tone) {
      Minecraft mc = Minecraft.getInstance();
      if (mc.player != null && mc.level != null) {
         ResourceLocation sound = switch (tone) {
            case 1 -> STING_UP;
            case 2 -> STING_DOWN;
            case 3 -> STING_AGGRESSIVE;
            case 4 -> STING_WARNING;
            default -> null;
         };
         if (sound != null) {
            mc.level
               .playLocalSound(
                  mc.player.getX(),
                  mc.player.getY(),
                  mc.player.getZ(),
                  SoundEvent.createVariableRangeEvent(sound),
                  SoundSource.PLAYERS,
                  0.6F,
                  tone == 1 ? 0.5F : 0.8F,
                  false
               );
         }

         SymbioteMod.LOGGER.debug("Played voice sting tone={}", tone);
      }
   }

   private SymbioteVoiceClient() {
   }
}
