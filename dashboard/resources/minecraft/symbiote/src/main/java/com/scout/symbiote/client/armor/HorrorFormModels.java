package com.scout.symbiote.client.armor;

public final class HorrorFormModels {
   private static LivingArmorModel cached;

   public static LivingArmorModel get() {
      if (cached == null) {
         rebake();
      }

      return cached;
   }

   public static void rebake() {
      cached = new LivingArmorModel(LivingArmorModel.createHorrorBodyLayer().bakeRoot());
   }

   private HorrorFormModels() {
   }
}
