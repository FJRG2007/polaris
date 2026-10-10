package com.scout.symbiote.override;

import com.scout.symbiote.ability.EnemySlam;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.Vindication;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class CreeperSaveOverride {
   private static final float WHIP_DAMAGE = 6.0F;
   private static final double WHIP_KNOCKBACK = 3.0;
   private static final int WHIP_FX_LIFETIME_TICKS = 20;
   private static final double POINT_BLANK_RANGE = 3.0;
   private static final double CROWD_RANGE = 4.0;
   private static final int MAX_THREATS_PER_FIRE = 4;
   private static final Map<UUID, Long> CREEPER_NOTICE_LAST = new HashMap<>();
   private static final int CREEPER_NOTICE_COOLDOWN_TICKS = 1200;
   private static final Map<UUID, Long> LOW_HP_LAST = new HashMap<>();
   private static final int LOW_HP_REFIRE_TICKS = 600;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (OverrideGate.check(player, level, p, "creeper_save")) {
         PlayerCommandDispatcher.CommandMode mode = PlayerCommandDispatcher.getMode(player.getUUID());
         if (mode == PlayerCommandDispatcher.CommandMode.HIDE) {
            SymbioteLog.overrideSkipped(player.getUUID(), "creeper_save", "command_hide");
         } else {
            List<LivingEntity> threats = nearbyThreats(player, level);
            if (!threats.isEmpty()) {
               boolean trigger = false;
               String reason = "";
               double pointBlank = mode == PlayerCommandDispatcher.CommandMode.PROTECT_ME ? 4.0 : 3.0;

               for (LivingEntity t : threats) {
                  if (t instanceof Creeper c && c.getSwellDir() > 0 && t.distanceToSqr(player) <= pointBlank * pointBlank) {
                     trigger = true;
                     reason = "creeper_about_to_blow";
                     break;
                  }
               }

               if (!trigger) {
                  boolean integrating = p.instabilityUntilTick > level.getGameTime();
                  int crowdCount = 0;
                  double crowdSq = 16.0;

                  for (LivingEntity t : threats) {
                     if (t.distanceToSqr(player) <= crowdSq) {
                        crowdCount++;
                     }
                  }

                  if (crowdCount >= 2 && !integrating) {
                     trigger = true;
                     reason = "crowd_close_x" + crowdCount;
                  }
               }

               if (!trigger) {
                  float hpFrac = player.getHealth() / player.getMaxHealth();
                  double hpThreshold = mode == PlayerCommandDispatcher.CommandMode.PROTECT_ME
                     ? Math.min(0.95, SymbioteConfig.CREEPER_SAVE_MIN_HP_FRAC.get() + 0.3)
                     : SymbioteConfig.CREEPER_SAVE_MIN_HP_FRAC.get();
                  if (hpFrac <= hpThreshold
                     && CombatSense.inCombat(player, 300)
                     && level.getGameTime() - LOW_HP_LAST.getOrDefault(player.getUUID(), -10000L) >= 600L) {
                     trigger = true;
                     reason = "low_hp_with_threat";
                     LOW_HP_LAST.put(player.getUUID(), level.getGameTime());
                  }
               }

               if (trigger) {
                  execute(player, level, p, threats, reason);
               } else {
                  long gnow = level.getGameTime();
                  if (gnow - CREEPER_NOTICE_LAST.getOrDefault(player.getUUID(), -100000L) >= 1200L) {
                     for (LivingEntity t : threats) {
                        if (t instanceof Creeper c && c.getSwellDir() <= 0 && t.distanceToSqr(player) <= 64.0 && player.hasLineOfSight(t)) {
                           CREEPER_NOTICE_LAST.put(player.getUUID(), gnow);
                           VoiceLines.send(player, "symbiote.voice.creeper_notice", 4);
                           SymbioteLog.event("CREEPER_NOTICE player={}", player.getUUID());
                           break;
                        }
                     }
                  }
               }
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      LOW_HP_LAST.remove(player);
      CREEPER_NOTICE_LAST.remove(player);
   }

   public static boolean forceTrigger(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.stage.isBonded()) {
         return false;
      }

      execute(player, level, p, nearbyThreats(player, level), "debug_force");
      return true;
   }

   private static void execute(ServerPlayer player, ServerLevel level, SymbioteProfile p, List<LivingEntity> threats, String reason) {
      List<LivingEntity> alive = new ArrayList<>(threats.size());

      for (LivingEntity threat : threats) {
         if (threat != null && threat.isAlive()) {
            alive.add(threat);
         }
      }

      boolean slammed = false;
      if (alive.size() == 2 && EnemySlam.canStart(player, level, p)) {
         double slamRange = SymbioteConfig.SLAM_RANGE.get();
         double slamRangeSq = slamRange * slamRange;
         LivingEntity a = alive.get(0);
         LivingEntity b = alive.get(1);
         if (a.distanceToSqr(player) <= slamRangeSq && b.distanceToSqr(player) <= slamRangeSq && a.distanceToSqr(b) <= slamRangeSq) {
            slammed = EnemySlam.start(player, level, p, a, b);
         }
      }

      int whipped = 0;
      if (!slammed) {
         for (LivingEntity threat : alive) {
            if (whipped >= 4) {
               break;
            }

            whipThreat(player, level, p, threat);
            whipped++;
         }

         if (whipped == 0) {
            TendrilFxEntity.spawnBurst(level, player, 25, p.strain);
         }
      }

      ModNetwork.sendOverrideFx(player, "vignette_black", 15);
      VoiceLines.send(
         player,
         reason.startsWith("creeper")
            ? "symbiote.voice.creeper_save"
            : (reason.startsWith("low_hp") ? "symbiote.voice.rescue_bleed" : "symbiote.voice.rescue_reflex"),
         3
      );
      if (!reason.startsWith("crowd")) {
         Vindication.consider(player, level.getGameTime());
      }

      OverrideGate.seize(player, level, p, "creeper_save");
      SymbioteLog.overrideFired(
         player.getUUID(), "creeper_save", reason, "hp", player.getHealth(), "stress", p.stress, "bond", p.bond, "threats_whipped", whipped, "slam", slammed
      );
      if (!reason.startsWith("crowd")) {
         SymbioteTracker.adjustBond(level, player, SymbioteConfig.BOND_CLUTCH_SAVE.get(), "bond_clutch_save");
      }
   }

   private static void whipThreat(ServerPlayer player, ServerLevel level, SymbioteProfile p, LivingEntity threat) {
      if (TendrilMantle.strike(player, level, threat.position().add(0.0, threat.getBbHeight() * 0.5, 0.0)) == null) {
         TendrilFxEntity.spawnWhip(level, player, threat, 20, p.strain);
      }

      double intensity = p.stageIntensity();
      DamageSource src = level.damageSources().playerAttack(player);
      threat.hurt(src, (float)(6.0 * intensity));
      Vec3 away = threat.position().subtract(player.position());
      if (away.lengthSqr() < 1.0E-4) {
         away = new Vec3(player.getRandom().nextGaussian(), 0.0, player.getRandom().nextGaussian());
      }

      Vec3 awayN = away.normalize();
      double kb = 3.0 * intensity;
      threat.setDeltaMovement(awayN.x * kb, 0.55, awayN.z * kb);
      threat.hurtMarked = true;
      if (threat instanceof Creeper c) {
         c.setSwellDir(-1);
      }
   }

   private static List<LivingEntity> nearbyThreats(ServerPlayer player, ServerLevel level) {
      double range = SymbioteConfig.CREEPER_SAVE_RANGE.get();
      AABB box = player.getBoundingBox().inflate(range);
      long tnow = level.getGameTime();
      List<Mob> mobs = level.getEntitiesOfClass(
         Mob.class, box, mx -> mx.isAlive() && (isHostileThreat(mx, player) || CombatSense.isAggressor(player.getUUID(), mx, tnow)) && player.hasLineOfSight(mx)
      );
      mobs.sort(Comparator.comparingDouble(mx -> mx.distanceToSqr(player)));
      List<LivingEntity> result = new ArrayList<>(mobs.size());

      for (Mob m : mobs) {
         result.add(m);
      }

      return result;
   }

   private static boolean isHostileThreat(Mob m, ServerPlayer host) {
      if (!(m instanceof Enemy)) {
         return false;
      } else if (!HostileTargets.mayOpenOn(m, host)) {
         return false;
      } else {
         return m instanceof Creeper c ? c.getSwellDir() > 0 : true;
      }
   }

   private CreeperSaveOverride() {
   }
}
