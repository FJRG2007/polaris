package com.scout.symbiote.entity;

import net.minecraft.core.Holder;
import net.minecraft.resources.ResourceLocation;
import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.UUID;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeModifier.Operation;
import net.minecraft.world.entity.ai.goal.FloatGoal;
import net.minecraft.world.entity.ai.goal.WaterAvoidingRandomStrollGoal;
import net.minecraft.world.entity.monster.Enemy;

public final class WildHost {
   private static final String TAG = "symbiote:wild_host";
   private static final String KEY_STRAIN = "strain";
   private static final String KEY_SINCE = "since";
   private static final String KEY_DISPOSITION = "disposition";
   private static final UUID MOD_HEALTH = UUID.fromString("6f7d3a11-2b44-4c81-9c1e-1a2b3c4d5e01");
   private static final UUID MOD_SPEED = UUID.fromString("6f7d3a11-2b44-4c81-9c1e-1a2b3c4d5e02");
   private static final UUID MOD_DAMAGE = UUID.fromString("6f7d3a11-2b44-4c81-9c1e-1a2b3c4d5e03");
   private static final UUID MOD_ARMOR = UUID.fromString("6f7d3a11-2b44-4c81-9c1e-1a2b3c4d5e04");
   private static final UUID MOD_KB = UUID.fromString("6f7d3a11-2b44-4c81-9c1e-1a2b3c4d5e05");
   public static final boolean VAULTED = true;

   public static WildHost.Disposition dispositionOf(LivingEntity e) {
      if (!isInfected(e)) {
         return WildHost.Disposition.WATCHER;
      }

      int i = e.getPersistentData().getCompound("symbiote:wild_host").getInt("disposition");
      WildHost.Disposition[] v = WildHost.Disposition.values();
      return v[Math.floorMod(i, v.length)];
   }

   public static boolean isInfected(LivingEntity e) {
      return e != null && e.getPersistentData().contains("symbiote:wild_host");
   }

   public static void markForcedLeap(LivingEntity e) {
      if (isInfected(e)) {
         e.getPersistentData().getCompound("symbiote:wild_host").putBoolean("forced_leap", true);
      }
   }

   public static boolean isForcedLeap(LivingEntity e) {
      return isInfected(e) && e.getPersistentData().getCompound("symbiote:wild_host").getBoolean("forced_leap");
   }

   public static SymbioteStrain strainOf(LivingEntity e) {
      return !isInfected(e) ? null : SymbioteStrain.fromOrdinalSafe(e.getPersistentData().getCompound("symbiote:wild_host").getInt("strain"));
   }

   public static long infectedSince(LivingEntity e) {
      return !isInfected(e) ? 0L : e.getPersistentData().getCompound("symbiote:wild_host").getLong("since");
   }

   public static void infect(Mob mob, SymbioteStrain strain, long now) {
      infect(mob, strain, now, roll(mob));
   }

   public static void infect(Mob mob, SymbioteStrain strain, long now, WildHost.Disposition disposition) {
      if (!isInfected(mob)) {
         CompoundTag tag = new CompoundTag();
         tag.putInt("strain", strain.ordinal());
         tag.putLong("since", now);
         tag.putInt("disposition", disposition.ordinal());
         mob.getPersistentData().put("symbiote:wild_host", tag);
         applyBody(mob);
         applyMind(mob);
         mob.setPersistenceRequired();
         SymbioteLog.event("WILD_HOST_INFECTED entity={} type={} strain={} disposition={}", mob.getId(), mob.getType().toString(), strain, disposition);
      }
   }

   public static void reapply(Mob mob) {
      if (isInfected(mob)) {
         applyBody(mob);
         applyMind(mob);
      }
   }

   private static WildHost.Disposition roll(Mob mob) {
      double r = mob.getRandom().nextDouble();
      if (r < 0.55) {
         return WildHost.Disposition.PREDATOR;
      } else {
         return r < 0.85 ? WildHost.Disposition.FEEDER : WildHost.Disposition.WATCHER;
      }
   }

   private static void applyBody(Mob mob) {
      addModifier(mob, Attributes.MAX_HEALTH, MOD_HEALTH, "symbiote_wild_health", 14.0, Operation.ADD_VALUE);
      addModifier(mob, Attributes.MOVEMENT_SPEED, MOD_SPEED, "symbiote_wild_speed", 0.22, Operation.ADD_MULTIPLIED_BASE);
      addModifier(mob, Attributes.ATTACK_DAMAGE, MOD_DAMAGE, "symbiote_wild_damage", 3.0, Operation.ADD_VALUE);
      addModifier(mob, Attributes.ARMOR, MOD_ARMOR, "symbiote_wild_armor", 6.0, Operation.ADD_VALUE);
      addModifier(mob, Attributes.KNOCKBACK_RESISTANCE, MOD_KB, "symbiote_wild_kb", 0.6, Operation.ADD_VALUE);
      mob.setHealth(mob.getMaxHealth());
   }

   private static void addModifier(Mob mob, Holder<Attribute> attr, UUID id, String name, double amount, Operation op) {
      AttributeInstance inst = mob.getAttribute(attr);
      if (inst != null) {
         ResourceLocation key = ResourceLocation.fromNamespaceAndPath("symbiote", name);
         if (inst.getModifier(key) == null) {
            inst.addPermanentModifier(new AttributeModifier(key, amount, op));
         }
      }
   }

   private static void applyMind(Mob mob) {
      if (mob instanceof PathfinderMob pathfinder) {
         if (!(mob instanceof Enemy)) {
            pathfinder.goalSelector.removeAllGoals(g -> true);
            pathfinder.targetSelector.removeAllGoals(g -> true);
            pathfinder.goalSelector.addGoal(0, new FloatGoal(pathfinder));
            pathfinder.goalSelector.addGoal(7, new WaterAvoidingRandomStrollGoal(pathfinder, 0.7) {
               public boolean canUse() {
                  return WildHostBrain.isIdle(this.mob.getId()) && super.canUse();
               }

               public boolean canContinueToUse() {
                  return WildHostBrain.isIdle(this.mob.getId()) && super.canContinueToUse();
               }
            });
         }
      }
   }

   public static boolean enabled() {
      return false;
   }

   private WildHost() {
   }

   public enum Disposition {
      PREDATOR,
      FEEDER,
      WATCHER;
   }
}
