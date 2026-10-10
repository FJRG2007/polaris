package com.scout.symbiote.entity;

import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier.Builder;
import net.minecraft.world.entity.ai.goal.WrappedGoal;
import net.minecraft.world.entity.ai.goal.target.NearestAttackableTargetGoal;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;

public class InfectedZombieEntity extends Zombie {
   private static final int WHIP_LIFETIME_TICKS = 18;

   public InfectedZombieEntity(EntityType<? extends Zombie> type, Level level) {
      super(type, level);
   }

   public static Builder createAttributes() {
      return Zombie.createAttributes()
         .add(Attributes.MAX_HEALTH, 30.0)
         .add(Attributes.ATTACK_DAMAGE, 5.0)
         .add(Attributes.MOVEMENT_SPEED, 0.2)
         .add(Attributes.KNOCKBACK_RESISTANCE, 0.2)
         .add(Attributes.ARMOR, 4.0);
   }

   protected void addBehaviourGoals() {
      super.addBehaviourGoals();
      List<WrappedGoal> shifted = this.targetSelector.getAvailableGoals().stream().filter(w -> w.getPriority() >= 2).toList();
      shifted.forEach(w -> this.targetSelector.removeGoal(w.getGoal()));
      this.targetSelector.addGoal(2, new NearestAttackableTargetGoal<>(this, Player.class, 10, true, false, (target, lvl) -> isBondedHost(target)));
      shifted.forEach(w -> this.targetSelector.addGoal(w.getPriority() + 1, w.getGoal()));
   }

   private static boolean isBondedHost(LivingEntity target) {
      if (target instanceof Player player) {
         if (!(player.level() instanceof ServerLevel level)) {
            return false;
         } else {
            SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
            return p != null && p.stage.isBonded();
         }
      } else {
         return false;
      }
   }

   @Override
   public boolean doHurtTarget(ServerLevel serverLevel, Entity target) {
      boolean hit = super.doHurtTarget(serverLevel, target);
      if (hit && !this.level().isClientSide && target instanceof LivingEntity living) {
         TendrilFxEntity.spawnWhip(this.level(), this, living, 18, SymbioteStrain.GUARDIAN);
      }

      return hit;
   }
}
