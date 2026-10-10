package com.scout.symbiote.client;

import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.world.item.ItemStack;

public final class SymbioteClientState {
   private static int bond = 0;
   private static int trust = 50;
   private static int stress = 0;
   private static int hunger = 70;
   private static int livingArmorStamina = 100;
   private static BondStage stage = BondStage.UNBONDED;
   private static SymbioteStrain strain = SymbioteStrain.GUARDIAN;
   private static long dormantUntilTick = 0L;
   private static long instabilityUntilTick = 0L;
   private static boolean livingArmorActive = false;
   private static int stamina = 60;
   private static int staminaMax = 60;
   private static boolean bodySeized = false;
   private static ItemStack[] armSlots = new ItemStack[0];
   private static boolean mantleFurled = false;
   private static int moodOrdinal = 1;
   private static int temperamentOrdinal = 0;
   private static long lastMoodChangeTick = -10000L;
   private static long lastStageChangeTick = -10000L;
   private static PlayerCommandDispatcher.CommandMode commandMode = PlayerCommandDispatcher.CommandMode.DEFAULT;
   private static long lastBondChangeTick = -10000L;
   private static int lastBondChangeDir = 0;
   private static int lastBondChangeAmount = 0;
   private static long clientTick = 0L;
   private static int contrabandSlot = -1;
   private static int graftStrainOrdinal = -1;
   private static int graftHunger = 0;
   private static int graftTension = 0;
   private static long bloomOpenTick = 0L;
   private static long bloomUntilTick = 0L;
   private static long bodySeizedRefreshTick = -10000L;
   private static boolean bodyMarching = false;

   public static int getBond() {
      return bond;
   }

   public static int getTrust() {
      return trust;
   }

   public static int getStress() {
      return stress;
   }

   public static int getHunger() {
      return hunger;
   }

   public static int getLivingArmorStamina() {
      return livingArmorStamina;
   }

   public static BondStage getStage() {
      return stage;
   }

   public static SymbioteStrain getStrain() {
      return strain;
   }

   public static long getDormantUntilTick() {
      return dormantUntilTick;
   }

   public static long getInstabilityUntilTick() {
      return instabilityUntilTick;
   }

   public static boolean isLivingArmorActive() {
      return livingArmorActive;
   }

   public static int getStamina() {
      return stamina;
   }

   public static int getStaminaMax() {
      return staminaMax;
   }

   public static ItemStack getArmSlot(int i) {
      return i >= 0 && i < armSlots.length ? armSlots[i] : ItemStack.EMPTY;
   }

   public static int getArmSlotCount() {
      return armSlots.length;
   }

   public static boolean isMantleFurled() {
      return mantleFurled;
   }

   public static PlayerCommandDispatcher.CommandMode getCommandMode() {
      return commandMode;
   }

   public static long getLastBondChangeTick() {
      return lastBondChangeTick;
   }

   public static int getLastBondChangeDir() {
      return lastBondChangeDir;
   }

   public static int getLastBondChangeAmount() {
      return lastBondChangeAmount;
   }

   public static long getClientTick() {
      return clientTick;
   }

   public static MoodEngine.Mood getMood() {
      MoodEngine.Mood[] v = MoodEngine.Mood.values();
      return v[Math.floorMod(moodOrdinal, v.length)];
   }

   public static MoodEngine.Temperament getTemperament() {
      MoodEngine.Temperament[] v = MoodEngine.Temperament.values();
      return v[Math.floorMod(temperamentOrdinal, v.length)];
   }

   public static long getLastMoodChangeTick() {
      return lastMoodChangeTick;
   }

   public static long getLastStageChangeTick() {
      return lastStageChangeTick;
   }

   public static boolean isBonded() {
      return stage.isBonded();
   }

   public static void update(
      int newBond,
      int newTrust,
      int newStress,
      int newHunger,
      int newLivingArmorStamina,
      BondStage newStage,
      SymbioteStrain newStrain,
      long newDormantUntilTick,
      long newInstabilityUntilTick,
      boolean newLivingArmorActive,
      int newStamina,
      int newStaminaMax
   ) {
      if (newBond != bond) {
         lastBondChangeDir = Integer.signum(newBond - bond);
         lastBondChangeAmount = newBond - bond;
         lastBondChangeTick = clientTick;
      }

      if (newStage != stage && stage.isBonded() && newStage.isBonded()) {
         lastStageChangeTick = clientTick;
      }

      bond = newBond;
      trust = newTrust;
      stress = newStress;
      hunger = newHunger;
      livingArmorStamina = newLivingArmorStamina;
      stage = newStage;
      strain = newStrain;
      dormantUntilTick = newDormantUntilTick;
      instabilityUntilTick = newInstabilityUntilTick;
      livingArmorActive = newLivingArmorActive;
      stamina = newStamina;
      staminaMax = newStaminaMax;
   }

   public static void updateArmSlots(ItemStack[] slots, boolean furled) {
      armSlots = slots == null ? new ItemStack[0] : slots;
      mantleFurled = furled;
   }

   public static int getContrabandSlot() {
      return contrabandSlot;
   }

   public static void updateContraband(int slot) {
      contrabandSlot = slot;
   }

   public static boolean isGrafted() {
      return graftStrainOrdinal >= 0;
   }

   public static SymbioteStrain getGraftStrain() {
      return SymbioteStrain.fromOrdinalSafe(Math.max(0, graftStrainOrdinal));
   }

   public static int getGraftHunger() {
      return graftHunger;
   }

   public static int getGraftTension() {
      return graftTension;
   }

   public static long getBloomOpenTick() {
      return bloomOpenTick;
   }

   public static long getBloomUntilTick() {
      return bloomUntilTick;
   }

   public static float getBloomProgress(long gameTime, float partialTick) {
      if (bloomUntilTick <= 0L) {
         return 0.0F;
      } else {
         float now = (float)gameTime + partialTick;
         float sinceOpen = now - (float)bloomOpenTick;
         float untilClose = (float)bloomUntilTick - now;
         if (!(sinceOpen < 0.0F) && !(untilClose < 0.0F)) {
            float OPEN_TICKS = 10.0F;
            float CLOSE_TICKS = 14.0F;
            float f = Math.min(sinceOpen / 10.0F, Math.min(1.0F, untilClose / 14.0F));
            f = Math.max(0.0F, Math.min(1.0F, f));
            return f * f * (3.0F - 2.0F * f);
         } else {
            return 0.0F;
         }
      }
   }

   public static void updateBloom(long openTick, long untilTick) {
      bloomOpenTick = openTick;
      bloomUntilTick = untilTick;
   }

   public static void updateGraft(int strainOrdinal, int hunger, int tension) {
      graftStrainOrdinal = strainOrdinal;
      graftHunger = hunger;
      graftTension = tension;
   }

   public static void updateMood(int mood, int temperament) {
      if (mood != moodOrdinal) {
         lastMoodChangeTick = clientTick;
      }

      moodOrdinal = mood;
      temperamentOrdinal = temperament;
   }

   public static void updateCommandMode(PlayerCommandDispatcher.CommandMode mode) {
      commandMode = mode == null ? PlayerCommandDispatcher.CommandMode.DEFAULT : mode;
   }

   public static void incrementTick() {
      clientTick++;
   }

   public static boolean isBodySeized() {
      return bodySeized && clientTick - bodySeizedRefreshTick < 100L;
   }

   public static boolean isBodyMarching() {
      return bodyMarching;
   }

   public static void setBodySeized(boolean seized, boolean marching) {
      bodySeized = seized;
      bodyMarching = seized && marching;
      if (seized) {
         bodySeizedRefreshTick = clientTick;
      }
   }

   public static void reset() {
      bond = 0;
      trust = 50;
      stress = 0;
      hunger = 70;
      livingArmorStamina = 100;
      stage = BondStage.UNBONDED;
      strain = SymbioteStrain.GUARDIAN;
      dormantUntilTick = 0L;
      instabilityUntilTick = 0L;
      livingArmorActive = false;
      stamina = 60;
      staminaMax = 60;
      armSlots = new ItemStack[0];
      mantleFurled = false;
      commandMode = PlayerCommandDispatcher.CommandMode.DEFAULT;
      lastBondChangeTick = -10000L;
      lastBondChangeDir = 0;
      lastBondChangeAmount = 0;
      clientTick = 0L;
      bodySeized = false;
      bodyMarching = false;
      moodOrdinal = 1;
      temperamentOrdinal = 0;
      lastMoodChangeTick = -10000L;
      contrabandSlot = -1;
      graftStrainOrdinal = -1;
      graftHunger = 0;
      graftTension = 0;
   }

   private SymbioteClientState() {
   }
}
