package com.scout.symbiote.tracker;

import com.scout.symbiote.config.SymbioteConfig;

public final class StrainTraits {
   public static double damageMult(SymbioteStrain strain) {
      return switch (strain) {
         case PREDATOR -> SymbioteConfig.PREDATOR_DAMAGE_MULT.get();
         case ROYAL -> SymbioteConfig.ROYAL_DAMAGE_MULT.get();
         default -> 1.0;
      };
   }

   public static double hungerDrainMult(SymbioteStrain strain) {
      return switch (strain) {
         case PREDATOR -> SymbioteConfig.PREDATOR_HUNGER_DRAIN_MULT.get();
         case ROYAL -> SymbioteConfig.ROYAL_HUNGER_DRAIN_MULT.get();
         default -> 1.0;
      };
   }

   public static double freelanceMult(SymbioteStrain strain, boolean night) {
      return switch (strain) {
         case PREDATOR -> 1.6;
         default -> 1.0;
         case GUARDIAN -> 0.8;
         case SHADOW -> night ? 1.4 : 0.7;
      };
   }

   public static double tendrilCooldownMult(SymbioteStrain strain) {
      return switch (strain) {
         case PREDATOR -> SymbioteConfig.PREDATOR_TENDRIL_COOLDOWN_MULT.get();
         default -> 1.0;
      };
   }

   public static double revivalBondMult(SymbioteStrain strain) {
      return switch (strain) {
         case PREDATOR -> SymbioteConfig.PREDATOR_REVIVAL_BOND_MULT.get();
         default -> 1.0;
      };
   }

   public static int starveThresholdBonus(SymbioteStrain strain) {
      return switch (strain) {
         case PREDATOR -> SymbioteConfig.PREDATOR_STARVE_THRESHOLD_BONUS.get();
         default -> 0;
      };
   }

   public static double defianceMult(SymbioteStrain strain) {
      return switch (strain) {
         case ROYAL -> SymbioteConfig.ROYAL_DEFIANCE_MULT.get();
         default -> 1.0;
      };
   }

   public static double intensityBonus(SymbioteStrain strain) {
      return switch (strain) {
         case ROYAL -> SymbioteConfig.ROYAL_INTENSITY_BONUS.get();
         default -> 0.0;
      };
   }

   public static double armorDrBonus(SymbioteStrain strain) {
      return switch (strain) {
         case ROYAL -> SymbioteConfig.ROYAL_ARMOR_DR_BONUS.get();
         case GUARDIAN -> SymbioteConfig.GUARDIAN_ARMOR_DR_BONUS.get();
         default -> 0.0;
      };
   }

   public static boolean passiveRegen(SymbioteStrain strain) {
      return strain == SymbioteStrain.ROYAL && SymbioteConfig.ROYAL_REGEN_ENABLED.get();
   }

   public static double hitCapFrac(SymbioteStrain strain) {
      return switch (strain) {
         case ROYAL -> SymbioteConfig.ROYAL_HIT_CAP_FRAC.get();
         default -> SymbioteConfig.LIVING_ARMOR_HIT_CAP_FRAC.get();
      };
   }

   public static double sonicResistFrac(SymbioteStrain strain) {
      return switch (strain) {
         case SCULK -> SymbioteConfig.SCULK_SONIC_RESIST.get();
         default -> 0.0;
      };
   }

   public static int senseRangeBonus(SymbioteStrain strain) {
      return switch (strain) {
         case SCULK -> SymbioteConfig.SCULK_SENSE_RANGE_BONUS.get();
         default -> 0;
      };
   }

   private StrainTraits() {
   }
}
