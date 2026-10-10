package com.scout.symbiote.failure;

import com.scout.symbiote.ability.LivingArmor;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.Vec3;

public final class LastResortRevival {
   private static final int STAND_MAX_TICKS = 2400;
   private static final int STAND_CALM_TICKS = 160;
   private static final double STAND_DANGER_RADIUS = 12.0;
   private static final double STAND_WHIP_REACH = 4.5;
   private static final Map<UUID, long[]> STAND = new HashMap<>();
   private static final int ABSORB_GRACE_TICKS = 40;

   public static boolean attempt(ServerPlayer player, ServerLevel level, SymbioteProfile p, float incomingDamage) {
      int minBond = SymbioteConfig.REVIVAL_MIN_BOND.get();
      double bondMult = StrainTraits.revivalBondMult(p.strain);
      if (bondMult != 1.0) {
         minBond = (int)Math.round(minBond * bondMult);
      }

      if (p.bond < minBond) {
         return false;
      }

      if (p.isDormant(level.getGameTime())) {
         return false;
      }

      if (p.instabilityUntilTick > level.getGameTime()) {
         SymbioteLog.event("REVIVAL_SKIPPED player={} reason=integrating", player.getUUID());
         return false;
      }

      if (p.revivalAdrenaline) {
         return false;
      }

      float postHp = player.getHealth() - incomingDamage;
      if (postHp > 0.0F) {
         return false;
      }

      player.setHealth(1.0F);
      VoiceLines.send(player, "symbiote.voice.revival", 4);
      player.addEffect(new MobEffectInstance(MobEffects.CONFUSION, 200, 0, false, true));
      SymbioteTracker.adjustHunger(level, player, -40, "revival_burn");
      SymbioteTracker.adjustStress(level, player, 30, "revival_aftermath");
      p.revivalAdrenaline = true;
      p.addBeat(MoodEngine.BeatType.NEAR_DEATH, level.getGameTime(), null);
      STAND.put(player.getUUID(), new long[]{level.getGameTime() + 2400L, 0L});
      LivingArmor.forceOn(player, level, p);
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("REVIVAL_TRIGGERED player={} damage_absorbed={} stand_begins=true", player.getUUID(), incomingDamage);
      TendrilSceneController.startRevivalCocoon(player, level);
      return true;
   }

   public static void tickAdrenaline(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (!p.revivalAdrenaline) {
         STAND.remove(player.getUUID());
      } else {
         long[] s = STAND.get(player.getUUID());
         if (s == null) {
            s = new long[]{now + 2400L, 0L};
            STAND.put(player.getUUID(), s);
            SymbioteLog.event("REVIVAL_STAND_RESUMED player={} cap={}t", player.getUUID(), 2400);
         }

         if (now % 10L == 0L) {
            ModNetwork.sendOverrideFx(player, "laststand", 16);
         }

         if (now % 40L == 0L) {
            player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, 80, 1, false, false));
         }

         if (now % 20L == 0L) {
            LivingEntity threat = null;
            double bestSq = Double.MAX_VALUE;
            boolean dangerNear = false;

            for (LivingEntity e : level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(12.0), en -> en != player && en.isAlive() && en instanceof Enemy)) {
               dangerNear = true;
               double d = e.distanceToSqr(player);
               if (d < bestSq && d <= 20.25) {
                  bestSq = d;
                  threat = e;
               }
            }

            if (threat != null) {
               if (TendrilMantle.strike(player, level, threat.position().add(0.0, threat.getBbHeight() * 0.5, 0.0)) == null) {
                  TendrilFxEntity.spawnWhip(level, player, threat, 12, p.strain);
               }

               threat.hurt(level.damageSources().playerAttack(player), 4.0F * (float)p.stageIntensity());
               Vec3 away = threat.position().subtract(player.position());
               if (away.lengthSqr() > 1.0E-4) {
                  Vec3 n = away.normalize();
                  threat.setDeltaMovement(n.x * 0.8, 0.3, n.z * 0.8);
                  threat.hurtMarked = true;
               }
            }

            s[1] = dangerNear ? 0L : s[1] + 20L;
         }

         if (s[1] >= 160L || now >= s[0]) {
            collapse(player, level, p, now >= s[0] ? "cap" : "clear");
         }
      }
   }

   public static boolean inAbsorbGrace(UUID player, long now) {
      long[] s = STAND.get(player);
      return s == null ? false : now - (s[0] - 2400L) < 40L;
   }

   private static void collapse(ServerPlayer player, ServerLevel level, SymbioteProfile p, String how) {
      p.revivalAdrenaline = false;
      STAND.remove(player.getUUID());
      p.addBeat(MoodEngine.BeatType.STAND, level.getGameTime(), how);
      p.reunionUntil = level.getGameTime() + SymbioteConfig.REVIVAL_DORMANCY_TICKS.get().intValue() + 6000L;
      SymbioteTracker.enterDormancy(level, player, SymbioteConfig.REVIVAL_DORMANCY_TICKS.get().intValue(), "last_resort_revival");
      TendrilMantle.dismiss(player, level);
      ModNetwork.broadcastLivingArmorState(player, false);
      boolean claimsIt = "clear".equals(how) && p.stage == BondStage.DOMINANT;
      VoiceLines.send(player, claimsIt ? "symbiote.voice.carried" : "symbiote.voice.revival_collapse", 4);
      SymbioteLog.event("REVIVAL_STAND_END player={} how={} dormancy_ticks={}", player.getUUID(), how, SymbioteConfig.REVIVAL_DORMANCY_TICKS.get());
   }

   public static void onLogout(UUID player) {
      STAND.remove(player);
   }

   private LastResortRevival() {
   }
}
