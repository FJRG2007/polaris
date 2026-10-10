package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.SymbioteProfile;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

public final class RupturePounce {
   public static boolean fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (RupturePounceScene.isActive(player.getUUID())) {
         return false;
      }

      double range = SymbioteConfig.RUPTURE_RANGE.get();
      Vec3 eye = player.getEyePosition();
      Vec3 look = player.getLookAngle();
      Vec3 end = eye.add(look.scale(range));
      AABB box = player.getBoundingBox().expandTowards(look.scale(range)).inflate(1.0);
      EntityHitResult hit = ProjectileUtil.getEntityHitResult(level, player, eye, end, box, e -> e instanceof LivingEntity && e != player && e.isAlive());
      return hit != null && hit.getEntity() instanceof LivingEntity target ? RupturePounceScene.begin(player, level, p, target) : false;
   }

   private RupturePounce() {
   }
}
