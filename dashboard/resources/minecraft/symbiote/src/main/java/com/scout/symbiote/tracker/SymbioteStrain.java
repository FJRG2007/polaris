package com.scout.symbiote.tracker;

import net.minecraft.util.StringRepresentable;

public enum SymbioteStrain implements StringRepresentable {
   GUARDIAN("guardian"),
   PREDATOR("predator"),
   SHADOW("shadow"),
   SCULK("sculk"),
   ROYAL("royal");

   private final String name;

   SymbioteStrain(String name) {
      this.name = name;
   }

   public String getSerializedName() {
      return this.name;
   }

   public static SymbioteStrain fromOrdinalSafe(int ordinal) {
      SymbioteStrain[] vs = values();
      return ordinal >= 0 && ordinal < vs.length ? vs[ordinal] : GUARDIAN;
   }

   public int getDisplayColor() {
      return switch (this) {
         case GUARDIAN -> 13992191;
         case PREDATOR -> 16729156;
         case SHADOW -> 4871536;
         case SCULK -> 1616048;
         case ROYAL -> 14721072;
      };
   }

   public String lowerKey() {
      return this.name;
   }
}
