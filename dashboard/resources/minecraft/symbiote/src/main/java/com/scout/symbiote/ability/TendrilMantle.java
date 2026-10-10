package com.scout.symbiote.ability;

import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;

public final class TendrilMantle {
   private static final int COUNT = 5;
   private static final int REACH = 10;
   private static final int COOLDOWN = 200;
   private static final int JOB_STALE_TICKS = 1200;
   private static final Map<UUID, Long> LAST = new HashMap<>();
   private static final Map<UUID, List<Integer>> ACTIVE = new HashMap<>();
   private static final Map<UUID, Map<Float, Integer>> SLOTS = new HashMap<>();
   private static final int AUTO_HOLD = 200;
   private static final int CALM_DISMISS_TICKS = 200;
   private static final int FIX_HOLD_TICKS = 100;
   private static final int ARMOR_LINGER_TICKS = 120;
   private static final int WATER_DELAY_TICKS = 40;
   private static final int FURL_TOGGLE_COOLDOWN_TICKS = 80;
   private static final Set<UUID> AUTO = new HashSet<>();
   private static final Map<UUID, Long> CALM_SINCE = new HashMap<>();
   private static final Map<UUID, long[]> FIX = new HashMap<>();
   private static final Set<UUID> ARMOR_WAS_ON = new HashSet<>();
   private static final Map<UUID, Long> ARMOR_OFF_AT = new HashMap<>();
   private static final Map<UUID, Long> WATER_SINCE = new HashMap<>();
   private static final Map<UUID, Long> REFUSE_UNTIL = new HashMap<>();
   private static final int LASH_INTERVAL = 55;
   private static final float LASH_BASE_CHANCE = 0.65F;
   private static final float LASH_DAMAGE_ATTACHED = 0.5F;
   private static final float LASH_DAMAGE_INTEGRATED = 1.0F;
   private static final float LASH_DAMAGE_COOPERATIVE = 1.75F;
   private static final float LASH_DAMAGE_DOMINANT = 3.2F;
   private static final double LASH_RANGE = 4.5;

   public static void deploy(ServerPlayer player, ServerLevel level, SymbioteProfile p, int holdTicks) {
      long now = level.getGameTime();
      UUID id = player.getUUID();
      if (p.instabilityUntilTick <= now) {
         if (!isUp(level, id)) {
            Long last = LAST.get(id);
            if (last == null || now - last >= 200L) {
               LAST.put(id, now);
               List<Integer> known = ACTIVE.get(id);

               for (TendrilFxEntity stray : level.getEntitiesOfClass(
                  TendrilFxEntity.class,
                  player.getBoundingBox().inflate(32.0),
                  fxx -> fxx.isAlive()
                     && fxx.usesBackOrigin()
                     && fxx.getHoverPhaseStart() > 0
                     && fxx.getOwnerId() == player.getId()
                     && (known == null || !known.contains(fxx.getId()))
               )) {
                  stray.scheduleRetract(stray.tickCount);
                  SymbioteLog.event("MANTLE_STRAY_RETRACTED player={} fx={}", id, stray.getId());
               }

               Map<Float, Integer> staleSlots = SLOTS.get(id);
               if (staleSlots != null) {
                  staleSlots.clear();
               }

               int lifetime = 10 + holdTicks + 16 + 4;
               List<Integer> ids = new ArrayList<>();

               for (int i = 0; i < 5; i++) {
                  float slot = i / 4.0F * 2.0F - 1.0F;
                  TendrilFxEntity fx = TendrilFxEntity.spawnMantleTendril(level, player, lifetime, p.strain, slot);
                  fx.setReachTicksOverride(10);
                  fx.scheduleRetract(10 + holdTicks);
                  ids.add(fx.getId());
                  SLOTS.computeIfAbsent(id, k -> new HashMap<>()).put(slot, fx.getId());
               }

               ACTIVE.put(id, ids);
               SymbioteLog.event("MANTLE_UP player={} count={} hold={}", id, 5, holdTicks);
            }
         }
      }
   }

   public static TendrilFxEntity beginJob(ServerPlayer player, ServerLevel level, Vec3 target) {
      Map<Float, Integer> slots = SLOTS.get(player.getUUID());
      if (slots != null && !slots.isEmpty()) {
         long gt = level.getGameTime();
         float yawRad = (float)Math.toRadians(player.yBodyRot);
         double fwdX = -Math.sin(yawRad);
         double fwdZ = Math.cos(yawRad);
         double lateral = (target.x - player.getX()) * fwdZ + (target.z - player.getZ()) * -fwdX;
         TendrilFxEntity best = null;
         float bestSlot = 0.0F;
         double bestScore = 0.0;

         for (Entry<Float, Integer> e : slots.entrySet()) {
            if (level.getEntity(e.getValue()) instanceof TendrilFxEntity fx && fx.isAlive() && fx.getRetractStartTick() <= 0 && fx.tickCount >= 12) {
               if (fx.getMantleJobStart() != 0) {
                  boolean returned = fx.getMantleJobEnd() != 0 && (int)gt - fx.getMantleJobEnd() > 10;
                  boolean stale = fx.getMantleJobEnd() == 0 && (int)gt - fx.getMantleJobStart() > 1200;
                  if (!returned && !stale) {
                     continue;
                  }

                  rest(fx);
               }

               double score = e.getKey().floatValue() * lateral;
               if (best == null || score > bestScore) {
                  best = fx;
                  bestSlot = e.getKey();
                  bestScore = score;
               }
            }
         }

         if (best == null) {
            return null;
         }

         int horizon = best.tickCount + 90;
         if (best.getScheduledRetractTick() > 0 && best.getScheduledRetractTick() < horizon) {
            best.scheduleRetract(horizon);
         }

         int lifeFloor = horizon + 16 + 4;
         if (best.getLifetime() < lifeFloor) {
            best.setLifetime(lifeFloor);
         }

         best.beginMantleJob(target, gt);
         level.playSound(
            null, player.getX(), player.getY() + 1.4, player.getZ(), (SoundEvent)ModSounds.TENDRIL_EXTEND.get(), SoundSource.PLAYERS, 0.45F, 1.06F
         );
         SymbioteLog.event("MANTLE_JOB_BEGIN player={} slot={} lateral={}", player.getUUID(), bestSlot, String.format("%.2f", lateral));
         return best;
      } else {
         return null;
      }
   }

   public static void endJob(ServerLevel level, TendrilFxEntity fx) {
      long gt = level.getGameTime();
      if (fx != null && fx.isAlive() && fx.getMantleJobStart() != 0) {
         if (fx.getMantleJobEnd() == 0 || fx.getMantleJobEnd() > gt) {
            fx.setWrapTarget(0);
            fx.endMantleJob(gt);
            level.playSound(null, fx.getX(), fx.getY(), fx.getZ(), (SoundEvent)ModSounds.TENDRIL_RETRACT.get(), SoundSource.PLAYERS, 0.35F, 1.1F);
            SymbioteLog.event("MANTLE_JOB_END limb={}", fx.getId());
         }
      }
   }

   public static TendrilFxEntity timedJob(ServerPlayer player, ServerLevel level, Vec3 target, int reachTicks, int holdTicks, int armKind, ItemStack tool) {
      TendrilFxEntity fx = beginJob(player, level, target);
      if (fx == null) {
         return null;
      }

      long gt = level.getGameTime();
      fx.setReachTicksOverride(Math.max(1, reachTicks));
      fx.endMantleJob(gt + reachTicks + Math.max(0, holdTicks));
      if (armKind != 2 || !tool.isEmpty()) {
         fx.setArmKind(armKind);
         fx.setHeldItem(tool);
      }

      int horizon = fx.tickCount + reachTicks + Math.max(0, holdTicks) + 8 + 30;
      if (fx.getScheduledRetractTick() > 0 && fx.getScheduledRetractTick() < horizon) {
         fx.scheduleRetract(horizon);
      }

      int lifeFloor = horizon + 16 + 4;
      if (fx.getLifetime() < lifeFloor) {
         fx.setLifetime(lifeFloor);
      }

      return fx;
   }

   public static TendrilFxEntity strike(ServerPlayer player, ServerLevel level, Vec3 target) {
      TendrilFxEntity fx = timedJob(player, level, target, 4, 2, 2, ItemStack.EMPTY);
      if (fx != null) {
         level.playSound(null, target.x, target.y, target.z, (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 0.55F, 1.0F);
      }

      return fx;
   }

   public static boolean handOff(ServerLevel level, Entity ent) {
      if (ent instanceof TendrilFxEntity fx && fx.getMantleJobStart() != 0) {
         endJob(level, fx);
         return true;
      } else {
         return false;
      }
   }

   public static void noteFixation(ServerPlayer player, Entity target) {
      if (target != null) {
         FIX.put(player.getUUID(), new long[]{target.getId(), player.serverLevel().getGameTime() + 100L});
      }
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      UUID id = player.getUUID();
      if (now % 20L == 13L) {
         List<Integer> led = ACTIVE.get(id);
         Map<Float, Integer> ledS = SLOTS.get(id);

         for (TendrilFxEntity ghost : level.getEntitiesOfClass(
            TendrilFxEntity.class,
            player.getBoundingBox().inflate(32.0),
            fxx -> fxx.isAlive()
               && fxx.usesBackOrigin()
               && fxx.getHoverPhaseStart() > 0
               && fxx.getOwnerId() == player.getId()
               && fxx.getRetractStartTick() <= 0
               && (led == null || !led.contains(fxx.getId()))
               && (ledS == null || !ledS.containsValue(fxx.getId()))
         )) {
            ghost.scheduleRetract(ghost.tickCount);
            SymbioteLog.event("MANTLE_GHOST_SWEPT player={} fx={}", id, ghost.getId());
         }
      }

      if (now % 20L == 6L) {
         List<Integer> act = ACTIVE.get(id);
         if (act != null) {
            boolean anyNear = false;
            boolean anyAlive = false;
            boolean anyOnJob = false;

            for (int eid : act) {
               if (level.getEntity(eid) instanceof TendrilFxEntity fx && fx.isAlive()) {
                  anyAlive = true;
                  if (fx.getMantleJobEnd() != 0) {
                     anyOnJob = true;
                  }

                  if (fx.distanceToSqr(player) < 1024.0) {
                     anyNear = true;
                     break;
                  }
               }
            }

            if (anyAlive && !anyNear && !anyOnJob) {
               dismiss(player, level);
               SymbioteLog.event("MANTLE_ORPHAN_SWEEP player={} limbs={}", id, act.size());
            }
         }
      }

      Map<Float, Integer> slots = SLOTS.get(id);
      if (slots != null && !slots.isEmpty() && now % 10L == 4L) {
         for (int fxId : slots.values()) {
            if (level.getEntity(fxId) instanceof TendrilFxEntity fx && fx.getMantleJobEnd() != 0 && (int)now - fx.getMantleJobEnd() > 10) {
               rest(fx);
            }
         }
      }

      boolean fullPolicy = p.stage.isAtLeast(BondStage.COOPERATIVE);
      if (now % 5L == 2L) {
         if (p.instabilityUntilTick > now) {
            if (isUp(level, id)) {
               dismiss(player, level);
               SymbioteLog.event("MANTLE_INTEGRATION_FURL player={}", id);
            }
         } else if (PlayerCommandDispatcher.getMode(id) == PlayerCommandDispatcher.CommandMode.HIDE) {
            if (isUp(level, id)) {
               dismiss(player, level);
               SymbioteLog.event("MANTLE_HIDE_FURL player={}", id);
            }
         } else {
            boolean armorOn = p.livingArmorActive;
            if (armorOn) {
               ARMOR_WAS_ON.add(id);
               ARMOR_OFF_AT.remove(id);
               if (p.mantleFurled) {
                  p.mantleFurled = false;
                  SymbioteTracker.get(level).setDirty();
                  ModNetwork.syncToPlayer(level, player);
                  SymbioteLog.event("MANTLE_FURL player={} state=cleared_by_shell", id);
               }
            } else if (ARMOR_WAS_ON.remove(id)) {
               ARMOR_OFF_AT.put(id, now);
            }

            Long offAt = ARMOR_OFF_AT.get(id);
            if (offAt != null && now - offAt >= 120L) {
               ARMOR_OFF_AT.remove(id);
               offAt = null;
            }

            boolean armorWants = armorOn || offAt != null;
            boolean seizureWants = fullPolicy && (WalkSeizure.isActive(id) || DeepSeizure.isActive(id));
            if (player.isUnderWater()) {
               WATER_SINCE.putIfAbsent(id, now);
            } else {
               WATER_SINCE.remove(id);
            }

            Long wet = WATER_SINCE.get(id);
            boolean waterWants = fullPolicy && wet != null && now - wet > 40L;
            if (p.mantleFurled && p.stage != BondStage.DOMINANT) {
               p.mantleFurled = false;
               SymbioteTracker.get(level).setDirty();
            }

            boolean dominantWants = p.stage == BondStage.DOMINANT && !p.mantleFurled;
            boolean elytraWants = fullPolicy && player.isFallFlying();
            Vec3 fixPos = null;
            boolean moodWants = false;
            int moodOrd = p.moodOrdinal;
            if (fullPolicy && (Boolean)SymbioteConfig.MANTLE_MOODS.get()) {
               long[] fix = FIX.get(id);
               if (fix != null) {
                  if (now > fix[1]) {
                     FIX.remove(id);
                  } else if (level.getEntity((int)fix[0]) instanceof LivingEntity t && t.isAlive()) {
                     fixPos = t.position().add(0.0, t.getBbHeight() * 0.7, 0.0);
                  } else {
                     FIX.remove(id);
                  }
               }

               moodWants = (moodOrd != MoodEngine.Mood.CONTENT.ordinal() || fixPos != null) && !p.mantleFurled;
            }

            boolean wantsOut = armorWants || seizureWants || waterWants || dominantWants || elytraWants || moodWants;
            if (wantsOut) {
               CALM_SINCE.remove(id);
               if (player.tickCount < 40) {
                  return;
               }

               if (!isUp(level, id)) {
                  if (!armorOn && !dominantWants) {
                     deploy(player, level, p, 200);
                  } else {
                     ensureUp(player, level, p, 200);
                  }

                  if (isUp(level, id)) {
                     AUTO.add(id);
                     SymbioteLog.event(
                        "MANTLE_POLICY_UP player={} armor={} seizure={} water={} dominant={} elytra={} mood={}",
                        id,
                        armorWants,
                        seizureWants,
                        waterWants,
                        dominantWants,
                        elytraWants,
                        MoodEngine.Mood.values()[moodOrd]
                     );
                  }
               } else if (slots != null) {
                  if (AUTO.add(id)) {
                     SymbioteLog.event("MANTLE_POLICY_ADOPT player={}", id);
                  }

                  for (Entry<Float, Integer> slotE : slots.entrySet()) {
                     if (!(level.getEntity(slotE.getValue()) instanceof TendrilFxEntity dfx) || !dfx.isAlive()) {
                        TendrilFxEntity fresh = TendrilFxEntity.spawnMantleTendril(level, player, 230, p.strain, slotE.getKey());
                        fresh.setReachTicksOverride(10);
                        fresh.scheduleRetract(210);
                        List<Integer> act = ACTIVE.get(id);
                        if (act != null) {
                           act.add(fresh.getId());
                        }

                        slotE.setValue(fresh.getId());
                        SymbioteLog.event("MANTLE_LIMB_REGROWN player={} slot={}", id, slotE.getKey());
                        break;
                     }
                  }

                  for (int fxId : slots.values()) {
                     if (level.getEntity(fxId) instanceof TendrilFxEntity fx && fx.isAlive()) {
                        int horizon = fx.tickCount + 200;
                        if (fx.getScheduledRetractTick() > 0 && fx.getScheduledRetractTick() < horizon) {
                           fx.scheduleRetract(horizon);
                        }

                        int lifeFloor = horizon + 16 + 4;
                        if (fx.getLifetime() < lifeFloor) {
                           fx.setLifetime(lifeFloor);
                        }
                     }
                  }
               }
            } else if (AUTO.contains(id) && isUp(level, id)) {
               long since = CALM_SINCE.computeIfAbsent(id, k -> now);
               if (now - since > 200L) {
                  dismiss(player, level);
                  AUTO.remove(id);
                  CALM_SINCE.remove(id);
                  SymbioteLog.event("MANTLE_POLICY_DOWN player={}", id);
               }
            }

            if (!wantsOut && isUp(level, id)) {
               Map<Float, Integer> coh = SLOTS.get(id);
               if (coh != null) {
                  int maxRemaining = 0;

                  for (int fxId : coh.values()) {
                     if (level.getEntity(fxId) instanceof TendrilFxEntity fx && fx.isAlive() && fx.getMantleJobStart() == 0) {
                        maxRemaining = Math.max(maxRemaining, fx.getScheduledRetractTick() - fx.tickCount);
                     }
                  }

                  if (maxRemaining > 30) {
                     for (Entry<Float, Integer> slotE : coh.entrySet()) {
                        if (!(level.getEntity(slotE.getValue()) instanceof TendrilFxEntity fx) || !fx.isAlive()) {
                           TendrilFxEntity fresh = TendrilFxEntity.spawnMantleTendril(level, player, 10 + maxRemaining + 16 + 4, p.strain, slotE.getKey());
                           fresh.setReachTicksOverride(10);
                           fresh.scheduleRetract(10 + maxRemaining);
                           List<Integer> act = ACTIVE.get(id);
                           if (act != null) {
                              act.add(fresh.getId());
                           }

                           slotE.setValue(fresh.getId());
                           SymbioteLog.event("MANTLE_LIMB_REGROWN player={} slot={} cause=hold_cohesion", id, slotE.getKey());
                           break;
                        }

                        if (fx.getMantleJobStart() == 0 && fx.getScheduledRetractTick() - fx.tickCount < maxRemaining - 8) {
                           fx.scheduleRetract(fx.tickCount + maxRemaining);
                           int lifeFloor = fx.tickCount + maxRemaining + 16 + 4;
                           if (fx.getLifetime() < lifeFloor) {
                              fx.setLifetime(lifeFloor);
                           }
                        }
                     }
                  }
               }
            }

            slots = SLOTS.get(id);
            if (slots != null) {
               int packed = moodOrd & 7 | (fixPos != null ? 8 : 0);

               for (int fxId : slots.values()) {
                  if (level.getEntity(fxId) instanceof TendrilFxEntity fx && fx.isAlive()) {
                     fx.setMantleMood(packed);
                     if (fixPos != null && fx.getMantleJobStart() == 0) {
                        fx.setTargetPos(fixPos.x, fixPos.y, fixPos.z);
                     }
                  }
               }
            }
         }
      }
   }

   private static void rest(TendrilFxEntity fx) {
      fx.setWrapTarget(0);
      fx.clearMantleJob();
      fx.setArmKind(2);
      fx.setHeldItem(ItemStack.EMPTY);
      fx.setReachTicksOverride(10);
   }

   private static boolean isUp(ServerLevel level, UUID id) {
      List<Integer> ids = ACTIVE.get(id);
      if (ids == null) {
         return false;
      }

      for (int eid : ids) {
         Entity e = level.getEntity(eid);
         if (e != null && e.isAlive()) {
            return true;
         }
      }

      ACTIVE.remove(id);
      SLOTS.remove(id);
      AUTO.remove(id);
      return false;
   }

   public static void ensureUp(ServerPlayer player, ServerLevel level, SymbioteProfile p, int holdTicks) {
      if (!isUp(level, player.getUUID())) {
         LAST.remove(player.getUUID());
         deploy(player, level, p, holdTicks);
      }
   }

   public static void hostFurlToggle(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      UUID id = player.getUUID();
      long now = level.getGameTime();
      if (now - p.lastMantleFurlTick < 80L) {
         SymbioteLog.event("ABILITY_REJECTED ability=mantle_furl_toggle player={} reason=toggle_cooldown", id);
      } else if (p.stage != BondStage.DOMINANT) {
         VoiceLines.send(player, "symbiote.voice.mantle_locked", 2);
         SymbioteLog.event("MANTLE_FURL player={} state=locked stage={}", id, p.stage);
      } else if (p.mantleFurled) {
         p.mantleFurled = false;
         p.lastMantleFurlTick = now;
         ensureUp(player, level, p, 200);
         AUTO.add(id);
         VoiceLines.send(player, "symbiote.voice.arms_on", 0);
         SymbioteLog.event("MANTLE_FURL player={} state=out", id);
      } else {
         boolean needHolds = p.livingArmorActive || WalkSeizure.isActive(id) || DeepSeizure.isActive(id) || player.isUnderWater() || player.isFallFlying();
         if (needHolds) {
            VoiceLines.send(player, p.livingArmorActive ? "symbiote.voice.mantle_busy_shell" : "symbiote.voice.mantle_busy", 0);
            SymbioteLog.event("MANTLE_FURL player={} state=busy armor={}", id, p.livingArmorActive);
         } else {
            int moodNow = p.moodOrdinal;
            if (moodNow != MoodEngine.Mood.ANXIOUS.ordinal() && moodNow != MoodEngine.Mood.COILED.ordinal() && !(player.getHealth() < player.getMaxHealth() * 0.5F)) {
               Long ru = REFUSE_UNTIL.get(id);
               if (ru != null && now < ru) {
                  VoiceLines.send(player, "symbiote.voice.mantle_refuse", 3);
               } else {
                  float refuse = p.stress <= 40 ? 0.0F : Math.min(1.0F, (p.stress - 40) / 60.0F) * 0.85F;
                  if (player.getRandom().nextFloat() < refuse) {
                     REFUSE_UNTIL.put(id, now + 200L);
                     VoiceLines.send(player, "symbiote.voice.mantle_refuse", 3);
                     SymbioteLog.event("MANTLE_FURL player={} state=refused stress={}", id, p.stress);
                  } else {
                     p.mantleFurled = true;
                     p.lastMantleFurlTick = now;
                     dismiss(player, level);
                     VoiceLines.send(player, "symbiote.voice.arms_off", 0);
                     SymbioteLog.event("MANTLE_FURL player={} state=furled stress={}", id, p.stress);
                  }
               }
            } else {
               REFUSE_UNTIL.put(id, now + 200L);
               boolean threatNear = !level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(12.0), m -> m.isAlive() && m instanceof Enemy).isEmpty();
               VoiceLines.send(player, threatNear ? "symbiote.voice.mantle_refuse_edge_threat" : "symbiote.voice.mantle_refuse_edge", 3);
               SymbioteLog.event("MANTLE_FURL player={} state=refused_edge mood={} threat_near={}", id, moodNow, threatNear);
            }
         }
      }
   }

   public static boolean isDeployed(ServerLevel level, UUID id) {
      return isUp(level, id);
   }

   public static void tickCombatAutonomy(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (!p.livingArmorActive) {
         if (PlayerCommandDispatcher.getMode(player.getUUID()) != PlayerCommandDispatcher.CommandMode.HIDE) {
            if (p.instabilityUntilTick <= now) {
               UUID id = player.getUUID();
               if (isUp(level, id)) {
                  if (now % 55L == 0L) {
                     double aggro = SymbioteArmsController.retaliateAggression(p.strain);
                     if (!(player.getRandom().nextFloat() >= 0.65F * aggro)) {
                        LivingEntity best = null;
                        double bestDist = Double.MAX_VALUE;

                        for (LivingEntity e : level.getEntitiesOfClass(
                           LivingEntity.class,
                           player.getBoundingBox().inflate(4.5),
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
                           if (strike(player, level, best.position().add(0.0, best.getBbHeight() * 0.5, 0.0)) == null) {
                              TendrilFxEntity.spawnWhip(level, player, best, 14, p.strain);
                           }
                           float lashDamage = switch (p.stage) {
                              case DOMINANT -> 3.2F;
                              case COOPERATIVE -> 1.75F;
                              case INTEGRATED -> 1.0F;
                              default -> 0.5F;
                           };
                           lashDamage += 2.0F * (float)StrainTraits.intensityBonus(p.strain);
                           best.hurt(level.damageSources().playerAttack(player), lashDamage);
                           SymbioteLog.event("MANTLE_AUTOLASH player={} target={} stage={}", id, best.getType(), p.stage);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   public static void dismiss(ServerPlayer player, ServerLevel level) {
      AUTO.remove(player.getUUID());
      CALM_SINCE.remove(player.getUUID());
      SLOTS.remove(player.getUUID());
      List<Integer> ids = ACTIVE.remove(player.getUUID());
      if (ids != null) {
         for (int eid : ids) {
            if (level.getEntity(eid) instanceof TendrilFxEntity fx && fx.isAlive()) {
               fx.scheduleRetract(fx.tickCount);
            }
         }

         SymbioteLog.event("MANTLE_DISMISS player={}", player.getUUID());
      }
   }

   public static void onLogout(UUID id) {
      LAST.remove(id);
      ACTIVE.remove(id);
      SLOTS.remove(id);
      AUTO.remove(id);
      CALM_SINCE.remove(id);
      FIX.remove(id);
      ARMOR_WAS_ON.remove(id);
      ARMOR_OFF_AT.remove(id);
      WATER_SINCE.remove(id);
      REFUSE_UNTIL.remove(id);
   }

   private TendrilMantle() {
   }
}
