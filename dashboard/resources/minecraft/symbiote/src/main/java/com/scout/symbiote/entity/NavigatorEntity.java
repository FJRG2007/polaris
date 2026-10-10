package com.scout.symbiote.entity;

import net.minecraft.server.level.ServerLevel;
import com.scout.symbiote.ability.WalkSeizure;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier.Builder;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.pathfinder.PathType;

public class NavigatorEntity extends PathfinderMob {
   public NavigatorEntity(EntityType<? extends PathfinderMob> type, Level level) {
      super(type, level);
      this.setInvisible(true);
      this.setSilent(true);
      this.setInvulnerable(true);
      this.setPersistenceRequired();
      this.setPathfindingMalus(PathType.LAVA, -1.0F);
      this.setPathfindingMalus(PathType.DAMAGE_FIRE, -1.0F);
      this.setPathfindingMalus(PathType.DANGER_FIRE, 16.0F);
      this.setPathfindingMalus(PathType.WATER, 8.0F);
   }

   public static Builder createAttributes() {
      return Mob.createMobAttributes().add(Attributes.MAX_HEALTH, 10.0).add(Attributes.MOVEMENT_SPEED, 0.23).add(Attributes.FOLLOW_RANGE, 64.0);
   }

   protected void registerGoals() {
   }

   public void tick() {
      super.tick();
      if (!this.level().isClientSide && !WalkSeizure.isNavigator(this.getId())) {
         this.discard();
      }
   }

   public boolean isPushable() {
      return false;
   }

   protected void doPush(Entity entity) {
   }

   @Override
   public boolean hurtServer(ServerLevel level, DamageSource source, float amount) {
      return false;
   }

   public boolean removeWhenFarAway(double dist) {
      return false;
   }
}
