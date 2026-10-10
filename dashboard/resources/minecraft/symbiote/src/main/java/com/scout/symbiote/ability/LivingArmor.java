package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;

public final class LivingArmor {
   public static void toggle(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      if (now - p.lastArmorToggleTick < SymbioteConfig.LIVING_ARMOR_TOGGLE_COOLDOWN_TICKS.get().intValue()) {
         SymbioteLog.event("ABILITY_REJECTED ability=living_armor_toggle player={} reason=toggle_cooldown", player.getUUID());
         VoiceLines.send(player, "symbiote.voice.armor_too_soon", 2);
      } else {
         if (!p.livingArmorActive) {
            if (p.hunger <= 0) {
               SymbioteLog.event("ABILITY_REJECTED ability=living_armor_toggle player={} reason=starved", player.getUUID());
               VoiceLines.send(player, "symbiote.voice.armor_starved", 2);
               return;
            }

            p.livingArmorActive = true;
            TendrilFxEntity.spawnBurst(level, player, 20, p.strain);
            level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.ARMOR_ON.get(), SoundSource.PLAYERS, 0.8F, 1.0F);
            VoiceLines.send(player, "symbiote.voice.living_armor_on", 0);
         } else {
            p.livingArmorActive = false;
            level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.ARMOR_OFF.get(), SoundSource.PLAYERS, 0.7F, 1.0F);
            VoiceLines.send(player, "symbiote.voice.living_armor_off", 0);
         }

         p.lastArmorToggleTick = now;
         player.refreshDimensions();
         SymbioteLog.event("ABILITY_FIRED ability=living_armor_toggle player={} active={}", player.getUUID(), p.livingArmorActive);
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         ModNetwork.broadcastLivingArmorState(player, p.livingArmorActive);
      }
   }

   public static boolean forceOn(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.livingArmorActive && p.hunger > 0) {
         p.livingArmorActive = true;
         p.lastArmorToggleTick = level.getGameTime();
         TendrilFxEntity.spawnBurst(level, player, 20, p.strain);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.ARMOR_ON.get(), SoundSource.PLAYERS, 0.9F, 0.9F);
         player.refreshDimensions();
         SymbioteLog.event("ABILITY_FIRED ability=living_armor_force_on player={} cause=desire_tantrum", player.getUUID());
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         ModNetwork.broadcastLivingArmorState(player, true);
         return true;
      } else {
         return false;
      }
   }

   public static void autoSheathIfThreatened(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.livingArmorActive && p.hunger > 25) {
         boolean threat = !level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(8.0), e -> e != player && e.isAlive() && e instanceof Enemy).isEmpty();
         if (threat && forceOn(player, level, p)) {
            SymbioteLog.event("LIVING_ARMOR_AUTO_SHEATH player={} cause=seizure_threat", player.getUUID());
         }
      }
   }

   public static float damageReduction(SymbioteProfile p) {
      float base = switch (p.stage) {
         case DOMINANT -> SymbioteConfig.LIVING_ARMOR_DR_DOMINANT.get().floatValue();
         case COOPERATIVE -> SymbioteConfig.LIVING_ARMOR_DR_COOPERATIVE.get().floatValue();
         default -> SymbioteConfig.LIVING_ARMOR_DR_INTEGRATED.get().floatValue();
      };
      float graftBonus = p.graft == null ? 0.0F : GraftTicker.armorBonus(p) + (float)StrainTraits.armorDrBonus(p.graft.strain);
      return Math.min(0.9F, base + (float)StrainTraits.armorDrBonus(p.strain) + graftBonus);
   }

   public static float consume(SymbioteProfile p, float incoming) {
      return !p.livingArmorActive ? incoming : incoming * (1.0F - damageReduction(p));
   }

   public static void tickWorn(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.livingArmorActive) {
         if (now % SymbioteConfig.LIVING_ARMOR_HUNGER_INTERVAL.get().intValue() == 0L) {
            SymbioteTracker.adjustHunger(level, player, -1, "living_armor_upkeep");
            if (p.hunger <= 0) {
               p.livingArmorActive = false;
               player.refreshDimensions();
               level.playSound(
                  null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.ARMOR_OFF.get(), SoundSource.PLAYERS, 0.7F, 0.85F
               );
               VoiceLines.send(player, "symbiote.voice.living_armor_off", 4);
               SymbioteTracker.get(level).setDirty();
               ModNetwork.syncToPlayer(level, player);
               ModNetwork.broadcastLivingArmorState(player, false);
               return;
            }
         }

         if (p.instabilityUntilTick <= now) {
            int lashInterval = SymbioteConfig.LIVING_ARMOR_AUTOLASH_INTERVAL.get();
            if (p.strain == SymbioteStrain.SHADOW && level.isNight()) {
               lashInterval = Math.max(5, lashInterval * 3 / 5);
            }

            if (now % lashInterval == 0L) {
               double range = SymbioteConfig.LIVING_ARMOR_AUTOLASH_RANGE.get();
               AABB box = player.getBoundingBox().inflate(range);
               LivingEntity best = null;
               double bestDist = Double.MAX_VALUE;

               for (LivingEntity e : level.getEntitiesOfClass(
                  LivingEntity.class,
                  box,
                  en -> en != player
                     && en.isAlive()
                     && (en instanceof Enemy || CombatSense.isAggressor(player.getUUID(), en, now))
                     && HostileTargets.mayOpenOn(en, player)
                     && player.hasLineOfSight(en)
               )) {
                  double d = e.distanceToSqr(player);
                  if (d < bestDist) {
                     bestDist = d;
                     best = e;
                  }
               }

               if (best != null) {
                  if (TendrilMantle.strike(player, level, best.position().add(0.0, best.getBbHeight() * 0.5, 0.0)) == null) {
                     TendrilFxEntity.spawnWhip(level, player, best, 14, p.strain);
                  }

                  best.hurt(level.damageSources().playerAttack(player), SymbioteConfig.LIVING_ARMOR_AUTOLASH_DAMAGE.get().floatValue() * (float)p.stageIntensity());
                  if (player.getRandom().nextFloat() < 0.25F) {
                     VoiceLines.send(player, "symbiote.voice.armor_assert", 3);
                  }
               }
            }
         }
      }
   }

   private LivingArmor() {
   }
}
