package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class SymbioteFeedingHunt {
   private static final int HUNT_TIMEOUT_TICKS = 200;
   private static final double CONSUME_DIST = 2.6;
   private static final int FORCE_EAT_TICKS = 28;
   private static final double FORCE_EAT_DIST = 5.0;
   private static final int MIN_EAT_TICKS = 8;
   private static final double MAX_DRAG_DIST = 20.0;
   private static final double MAX_DRAG_PER_TICK = 1.9;
   private static final double DRAG_APPROACH_FRAC = 0.55;
   private static final double DRAG_Y_OFFSET = 0.5;
   private static final Map<UUID, SymbioteFeedingHunt.Hunt> ACTIVE = new HashMap<>();

   public static boolean isHunting(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      return begin(player, level, p, pickPrey(player, level), false);
   }

   public static boolean startTargeted(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity prey) {
      if (prey != null && prey.isAlive() && prey instanceof Mob) {
         if (!(Boolean)SymbioteConfig.PROTECT_ALLIES.get() || !(prey instanceof TamableAnimal t && t.isTame()) && !prey.hasCustomName()) {
            if (prey.getMaxHealth() > SymbioteConfig.CONSUME_MAX_TARGET_HP.get()) {
               return false;
            } else if (!TendrilYank.haulable(prey)) {
               return false;
            } else {
               return !player.hasLineOfSight(prey) ? false : begin(player, level, p, prey, false);
            }
         } else {
            return false;
         }
      } else {
         return false;
      }
   }

   public static boolean startConsume(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      return begin(player, level, p, pickConsumeTarget(player, level), true);
   }

   private static boolean begin(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity prey, boolean forced) {
      if (ACTIVE.containsKey(player.getUUID())) {
         return false;
      }

      if (prey == null) {
         return false;
      }

      HealthGuard.repairAndLog(prey);
      if (!TendrilYank.haulable(prey)) {
         SymbioteLog.event("CONSUME_REFUSED player={} target={} reason=too_big", player.getUUID(), prey.getType());
         return false;
      }

      if (prey.isSleeping()) {
         prey.stopSleeping();
      }

      if (prey instanceof Creeper c) {
         c.setSwellDir(-1);
      }

      int count = forced ? 4 : 3;
      int[] fxIds = new int[count];
      Vec3 preyPos = prey.position().add(0.0, prey.getBbHeight() * 0.5, 0.0);

      for (int i = 0; i < count; i++) {
         TendrilFxEntity fx = TendrilMantle.beginJob(player, level, preyPos);
         if (fx != null) {
            fx.setReachTicksOverride(3 + i);
            fx.setWrapTarget(prey.getId());
         } else {
            fx = TendrilFxEntity.spawnGrab(level, player, prey, 200, p.strain);
            fx.setReachTicksOverride(3 + i);
            fx.setArc(0.25F + 0.1F * (i % 2), (float)((Math.PI * 2) * i / count));
            fx.setWrapTarget(prey.getId());
         }

         fxIds[i] = fx.getId();
      }

      ACTIVE.put(player.getUUID(), new SymbioteFeedingHunt.Hunt(prey.getId(), level.getGameTime(), fxIds, p.strain, forced));
      VoiceLines.send(player, forced ? "symbiote.voice.consume" : "symbiote.voice.hunger_override", 3);
      ModNetwork.sendOverrideFx(player, "vignette_red", 25);
      SymbioteLog.event(
         "FEEDING_HUNT_START player={} prey={} prey_type={} forced={} dist={}",
         player.getUUID(),
         prey.getUUID(),
         prey.getType(),
         forced,
         player.distanceTo(prey)
      );
      return true;
   }

   public static void tickAll(ServerLevel level) {
      Iterator<Entry<UUID, SymbioteFeedingHunt.Hunt>> it = ACTIVE.entrySet().iterator();
      long now = level.getGameTime();

      while (it.hasNext()) {
         Entry<UUID, SymbioteFeedingHunt.Hunt> e = it.next();
         SymbioteFeedingHunt.Hunt h = e.getValue();
         ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (player == null || !player.isAlive()) {
            cleanupFx(level, h);
            it.remove();
         } else if (player.serverLevel() == level) {
            if (now - h.startTick > 200L) {
               cleanupFx(level, h);
               SymbioteLog.event("FEEDING_HUNT_END player={} reason=timeout", player.getUUID());
               it.remove();
            } else if (level.getEntity(h.targetEntityId) instanceof LivingEntity prey && prey.isAlive()) {
               if ((now - h.startTick) % 15L == 0L) {
                  ModNetwork.sendOverrideFx(player, "preylock:" + prey.getId(), 20);
               }

               double dist = player.distanceTo(prey);
               if (dist > 20.0) {
                  cleanupFx(level, h);
                  SymbioteLog.event("FEEDING_HUNT_END player={} reason=prey_too_far dist={}", player.getUUID(), dist);
                  it.remove();
               } else {
                  double dragX = player.getX();
                  double dragY = player.getY() + 0.5;
                  double dragZ = player.getZ();
                  long age = now - h.startTick;
                  if (age < 8L || !(dist <= 2.6) && (age < 28L || !(dist <= 5.0))) {
                     for (int fxId : h.tendrilFxIds) {
                        if (level.getEntity(fxId) instanceof TendrilFxEntity fx && fx.getMantleJobStart() != 0) {
                           fx.setTargetPos(prey.getX(), prey.getY() + prey.getBbHeight() * 0.5, prey.getZ());
                        }
                     }

                     Vec3 toPlayer = new Vec3(dragX - prey.getX(), dragY - prey.getY(), dragZ - prey.getZ());
                     double len = toPlayer.length();
                     if (!(len < 1.0E-4)) {
                        double step = Math.min(len * 0.55, 1.9);
                        if (prey.isSleeping()) {
                           prey.stopSleeping();
                        }

                        prey.setDeltaMovement(toPlayer.scale(step / len));
                        prey.hurtMarked = true;
                        prey.fallDistance = 0.0F;
                        prey.setYRot((float)Math.toDegrees(Math.atan2(player.getX() - prey.getX(), prey.getZ() - player.getZ())));
                     }
                  } else {
                     Vec3 eatPos = new Vec3(dragX, dragY, dragZ);
                     prey.setPos(eatPos.x, eatPos.y, eatPos.z);
                     prey.setDeltaMovement(Vec3.ZERO);
                     consume(player, level, prey, h);
                     retractFx(level, h, eatPos);
                     it.remove();
                  }
               }
            } else {
               cleanupFx(level, h);
               SymbioteLog.event("FEEDING_HUNT_END player={} reason=prey_dead_or_gone", player.getUUID());
               it.remove();
            }
         }
      }
   }

   private static void consume(ServerPlayer player, ServerLevel level, LivingEntity prey, SymbioteFeedingHunt.Hunt h) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null) {
         OverrideGate.stamp(level, p);
      }

      prey.invulnerableTime = 0;
      prey.hurtTime = 0;
      DamageSource src = level.damageSources().playerAttack(player);
      prey.hurt(src, HealthGuard.lethal(prey));
      if (prey.isAlive()) {
         prey.invulnerableTime = 0;
         prey.hurtTime = 0;
         prey.hurt(level.damageSources().genericKill(), HealthGuard.lethal(prey));
      }

      int hungerGain = SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get() * (h.forced ? 5 : 3);
      SymbioteTracker.adjustHunger(level, player, hungerGain, h.forced ? "symbiote_consume" : "symbiote_feeding");
      SymbioteCuriosity.noteTaste(player, level, prey);
      int trustDelta = 0;
      if (h.forced) {
         player.heal(6.0F);
         player.getFoodData().eat(4, 0.5F);
      }

      level.playSound(null, prey.getX(), prey.getY(), prey.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.9F, 0.75F);
      level.playSound(null, prey.getX(), prey.getY(), prey.getZ(), SoundEvents.GENERIC_EAT, SoundSource.PLAYERS, 1.0F, 0.7F);
      ModNetwork.sendOverrideFx(player, "vignette_red", 30);
      VoiceLines.send(player, h.forced ? "symbiote.voice.consume" : "symbiote.voice.hunger_override", 3);
      SymbioteLog.event(
         "FEEDING_HUNT_CONSUME player={} prey={} prey_type={} forced={} killed={} hunger_gain={} trust_delta={}",
         player.getUUID(),
         prey.getUUID(),
         prey.getType(),
         h.forced,
         !prey.isAlive(),
         hungerGain,
         trustDelta
      );
   }

   private static LivingEntity pickConsumeTarget(ServerPlayer player, ServerLevel level) {
      double range = SymbioteConfig.HUNGER_OVERRIDE_SEARCH_RANGE.get();
      AABB box = player.getBoundingBox().inflate(range);
      boolean protectAllies = (Boolean)SymbioteConfig.PROTECT_ALLIES.get();
      LivingEntity best = null;
      double bestDist = Double.MAX_VALUE;
      double hpCap = SymbioteConfig.CONSUME_MAX_TARGET_HP.get();

      for (Mob m : level.getEntitiesOfClass(Mob.class, box, LivingEntity::isAlive)) {
         if ((!protectAllies || !(m instanceof TamableAnimal tamable && tamable.isTame()) && !m.hasCustomName())
            && player.hasLineOfSight(m)
            && !(m.getMaxHealth() > hpCap)
            && TendrilYank.haulable(m)) {
            double d = m.distanceToSqr(player);
            if (d < bestDist) {
               bestDist = d;
               best = m;
            }
         }
      }

      return best;
   }

   private static void cleanupFx(ServerLevel level, SymbioteFeedingHunt.Hunt h) {
      for (int id : h.tendrilFxIds) {
         Entity e = level.getEntity(id);
         if (e != null && !TendrilMantle.handOff(level, e)) {
            e.discard();
         }
      }
   }

   private static void retractFx(ServerLevel level, SymbioteFeedingHunt.Hunt h, Vec3 tip) {
      for (int id : h.tendrilFxIds) {
         if (level.getEntity(id) instanceof TendrilFxEntity fx && !TendrilMantle.handOff(level, fx)) {
            fx.setTargetId(0);
            fx.setTargetPos(tip.x, tip.y, tip.z);
            fx.setTransitionFrom(tip.x, tip.y, tip.z, fx.tickCount);
            fx.setRetractStartTick(fx.tickCount);
            fx.setLifetime(fx.tickCount + 16);
         }
      }
   }

   private static LivingEntity pickPrey(ServerPlayer player, ServerLevel level) {
      double range = SymbioteConfig.HUNGER_OVERRIDE_SEARCH_RANGE.get();
      AABB box = player.getBoundingBox().inflate(range);
      List<Mob> mobs = level.getEntitiesOfClass(Mob.class, box, LivingEntity::isAlive);
      boolean protectAllies = (Boolean)SymbioteConfig.PROTECT_ALLIES.get();
      LivingEntity animal = null;
      LivingEntity villager = null;
      double animalDist = Double.MAX_VALUE;
      double villDist = Double.MAX_VALUE;
      double hpCap = SymbioteConfig.CONSUME_MAX_TARGET_HP.get();

      for (Mob m : mobs) {
         if (!(m instanceof Enemy)
            && (!protectAllies || !(m instanceof TamableAnimal tamable && tamable.isTame()) && !m.hasCustomName())
            && player.hasLineOfSight(m)
            && !(m.getMaxHealth() > hpCap)
            && TendrilYank.haulable(m)) {
            double d = m.distanceToSqr(player);
            if (m instanceof Villager) {
               if (d < villDist) {
                  villDist = d;
                  villager = m;
               }
            } else if (m instanceof Animal && d < animalDist) {
               animalDist = d;
               animal = m;
            }
         }
      }

      return animal != null ? animal : villager;
   }

   public static void clear(UUID player) {
      ACTIVE.remove(player);
   }

   public static void forceClear(ServerLevel level, UUID player) {
      SymbioteFeedingHunt.Hunt h = ACTIVE.remove(player);
      if (h != null) {
         cleanupFx(level, h);
      }
   }

   public static void onLogout(UUID player) {
      ACTIVE.remove(player);
   }

   private SymbioteFeedingHunt() {
   }

   public static final class Hunt {
      public final int targetEntityId;
      public final long startTick;
      public final int[] tendrilFxIds;
      public final SymbioteStrain strain;
      public final boolean forced;

      Hunt(int targetEntityId, long startTick, int[] tendrilFxIds, SymbioteStrain strain, boolean forced) {
         this.targetEntityId = targetEntityId;
         this.startTick = startTick;
         this.tendrilFxIds = tendrilFxIds;
         this.strain = strain;
         this.forced = forced;
      }
   }
}
