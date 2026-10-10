package com.scout.symbiote.ability;

import net.minecraft.world.entity.EntityDimensions;
import net.minecraft.world.entity.Pose;
import net.neoforged.neoforge.event.entity.EntityEvent.Size;

public final class LivingArmorSizing {
   public static final float WIDTH_SCALE = 1.35F;
   public static final float HEIGHT_SCALE = 1.35F;
   public static final double MOVE_SPEED_BONUS = 0.25;
   public static final double STEP_HEIGHT_BONUS = 0.6;

   public static void applyLargeDimensions(Size event) {
      EntityDimensions base = event.getNewSize();
      if (!base.fixed() && event.getPose() != Pose.SLEEPING && event.getPose() != Pose.DYING) {
         EntityDimensions grown = base.scale(1.35F);
         float scaledEye = base.eyeHeight() * 1.35F;
         event.setNewSize(grown.withEyeHeight(Math.max(0.05F, Math.min(grown.height() - 0.05F, scaledEye))));
      }
   }

   private LivingArmorSizing() {
   }
}
