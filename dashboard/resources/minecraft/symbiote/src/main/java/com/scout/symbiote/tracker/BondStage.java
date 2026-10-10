package com.scout.symbiote.tracker;

import com.scout.symbiote.config.SymbioteConfig;

public enum BondStage {
   UNBONDED,
   ATTACHED,
   INTEGRATED,
   COOPERATIVE,
   DOMINANT;

   public static BondStage forBond(int bond, BondStage current) {
      if (current == UNBONDED) {
         return UNBONDED;
      } else if (bond >= (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get()) {
         return DOMINANT;
      } else if (bond >= (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get()) {
         return COOPERATIVE;
      } else {
         return bond >= SymbioteConfig.STAGE_INTEGRATED_BOND.get() ? INTEGRATED : ATTACHED;
      }
   }

   public boolean isBonded() {
      return this != UNBONDED;
   }

   public boolean isAtLeast(BondStage other) {
      return this.ordinal() >= other.ordinal();
   }

   public static BondStage fromOrdinalSafe(int ordinal) {
      BondStage[] values = values();
      return ordinal >= 0 && ordinal < values.length ? values[ordinal] : UNBONDED;
   }
}
