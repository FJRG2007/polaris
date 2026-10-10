package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.LivingDeathListener;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.BodyControl;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.Footing;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.BlockPos.MutableBlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class SymbioteDesires {
   private static final int DWELL_DEEP_TICKS = 100;
   private static final int DWELL_SHELL_TICKS = 1200;
   private static final int AFTER_COMBAT_QUIET = 500;
   private static final int STALE_GRACE_TICKS = 1200;
   private static final int TICK_INTERVAL = 20;
   private static final Random RANDOM = new Random();
   private static final Set<UUID> REMINDED = new HashSet<>();
   private static final Map<UUID, long[]> BLOOD_TANTRUM = new HashMap<>();
   private static final int BLOOD_TANTRUM_TICKS = 80;
   private static final int OVERBURDEN_REQUIRED = 5;
   private static final Map<UUID, Long> TAKE_SINCE = new HashMap<>();
   private static final int TAKE_PATIENCE_TICKS = 2400;

   public static boolean isBloodTantrum(UUID player) {
      return BLOOD_TANTRUM.containsKey(player);
   }

   public static boolean shouldTick(long now) {
      return now % 20L == 0L;
   }

   public static void tickActive(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      tickBloodTantrum(player, level, p, now);
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if ((Boolean)SymbioteConfig.DESIRES_ENABLED.get()) {
         if (!p.isStarving()) {
            if (p.desireType < 0) {
               if (p.instabilityUntilTick <= now) {
                  if (!CombatSense.inCombat(player, 500)) {
                     maybeSpawn(player, level, p, now);
                  }
               }
            } else {
               SymbioteDesires.Desire d = SymbioteDesires.Desire.values()[Math.min(p.desireType, SymbioteDesires.Desire.values().length - 1)];
               if (now >= p.desireDeadline) {
                  if (now - p.desireDeadline > 1200L) {
                     clear(player, p, now, "stale");
                  } else if (!bodyOwned(player) && !CombatSense.inCombat(player, 500) && Footing.planted(player)) {
                     expireIgnored(player, level, p, now, d);
                  } else {
                     p.desireDeadline = now + 100L;
                  }
               } else {
                  if (!REMINDED.contains(player.getUUID()) && p.desireDeadline - now <= SymbioteConfig.DESIRE_WINDOW_TICKS.get() / 2) {
                     REMINDED.add(player.getUUID());
                     VoiceLines.send(player, askPool(d), 4);
                     askHint(player, d);
                  }

                  switch (d) {
                     case DEEP:
                        boolean under = player.getY() < 0.0 || isUnderground(player, level);
                        progress(player, level, p, now, d, under, 100);
                        break;
                     case SHELL:
                        progress(player, level, p, now, d, p.livingArmorActive, 1200);
                  }
               }
            }
         }
      }
   }

   public static boolean forceDesireSoon(ServerPlayer player, ServerLevel level, SymbioteProfile p, String name) {
      if (!forceDesire(player, level, p, name)) {
         return false;
      }

      p.desireDeadline = level.getGameTime() + 100L;
      SymbioteTracker.get(level).setDirty();
      return true;
   }

   public static boolean forceDesire(ServerPlayer player, ServerLevel level, SymbioteProfile p, String name) {
      SymbioteDesires.Desire d;
      try {
         d = SymbioteDesires.Desire.valueOf(name.toUpperCase(Locale.ROOT));
      } catch (IllegalArgumentException e) {
         return false;
      }

      p.desireType = d.ordinal();
      p.desireDeadline = level.getGameTime() + SymbioteConfig.DESIRE_WINDOW_TICKS.get().intValue();
      p.desireProgress = 0;
      REMINDED.remove(player.getUUID());
      SymbioteTracker.get(level).setDirty();
      VoiceLines.send(player, askPool(d), 0);
      askHint(player, d);
      SymbioteLog.event("DESIRE_ASK player={} desire={} cause=debug_force", player.getUUID(), d);
      return true;
   }

   public static int forceTaking(ServerPlayer player, ServerLevel level, SymbioteProfile p, String name) {
      SymbioteDesires.Desire d;
      try {
         d = SymbioteDesires.Desire.valueOf(name.toUpperCase(Locale.ROOT));
      } catch (IllegalArgumentException e) {
         return 0;
      }

      long now = level.getGameTime();
      if (!bodyOwned(player) && startTantrum(player, level, p, now, d)) {
         SymbioteLog.event("DESIRE_TAKEN player={} desire={} cause=debug_take", player.getUUID(), d);
         return 2;
      } else {
         p.desireType = d.ordinal();
         p.desireDeadline = now;
         p.desireProgress = 0;
         REMINDED.add(player.getUUID());
         SymbioteTracker.get(level).setDirty();
         SymbioteLog.event("DESIRE_ASK player={} desire={} cause=debug_take_pending", player.getUUID(), d);
         return 1;
      }
   }

   public static String debugRandomTaking(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (bodyOwned(player)) {
         return null;
      }

      List<SymbioteDesires.Desire> acts = new ArrayList<>(List.of(SymbioteDesires.Desire.values()));
      Collections.shuffle(acts, RANDOM);
      long now = level.getGameTime();

      for (SymbioteDesires.Desire d : acts) {
         if (startTantrum(player, level, p, now, d)) {
            SymbioteLog.event("DEBUG_TAKING player={} act={}", player.getUUID(), d);
            return d.name();
         }
      }

      return null;
   }

   public static void notifyFed(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.desireType == SymbioteDesires.Desire.FLESH.ordinal() && now < p.desireDeadline) {
         fulfilled(player, level, p, now, SymbioteDesires.Desire.FLESH);
      }
   }

   public static void notifyHostileKill(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.desireType == SymbioteDesires.Desire.BLOOD.ordinal() && now < p.desireDeadline) {
         fulfilled(player, level, p, now, SymbioteDesires.Desire.BLOOD);
      }
   }

   public static void notifyAnyKill(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.desireType == SymbioteDesires.Desire.NIGHT.ordinal()
         && now < p.desireDeadline
         && level.isNight()
         && level.canSeeSky(BlockPos.containing(player.getX(), player.getEyeY(), player.getZ()))) {
         fulfilled(player, level, p, now, SymbioteDesires.Desire.NIGHT);
      }
   }

   private static void maybeSpawn(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (!SymbioteMolt.isMolting(p, now)) {
         long interval = SymbioteConfig.DESIRE_INTERVAL_TICKS.get().intValue();
         if (p.stage == BondStage.DOMINANT) {
            interval = (long)(interval * 0.6);
         } else if (p.stage == BondStage.COOPERATIVE) {
            interval = (long)(interval * 0.8);
         }

         if (now < p.reunionUntil) {
            interval /= 2L;
         }

         if (now - p.lastDesireTick >= interval) {
            if (RANDOM.nextInt(20) == 0) {
               if (!CombatSense.inCombat(player)) {
                  if (!TendrilSceneController.isInScene(player.getUUID())) {
                     if (!WalkSeizure.isActive(player.getUUID()) && !DeepSeizure.isActive(player.getUUID())) {
                        SymbioteDesires.Desire pick = pickWeighted(player, level, p);
                        if (pick != null) {
                           p.desireType = pick.ordinal();
                           p.desireDeadline = now + SymbioteConfig.DESIRE_WINDOW_TICKS.get().intValue();
                           p.desireProgress = 0;
                           REMINDED.remove(player.getUUID());
                           SymbioteTracker.get(level).setDirty();
                           VoiceLines.send(player, askPool(pick), 0);
                           askHint(player, pick);
                           SymbioteLog.event("DESIRE_ASK player={} desire={} deadline={}", player.getUUID(), pick, p.desireDeadline);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static SymbioteDesires.Desire pickWeighted(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      List<SymbioteDesires.Desire> bag = new ArrayList<>();
      SymbioteStrain s = p.strain;
      long now = level.getGameTime();
      if (p.hunger < 70) {
         int w = p.hunger < 40 ? 4 : 2;
         addN(bag, SymbioteDesires.Desire.FLESH, w);
      }

      if (now - LivingDeathListener.lastKillTick(player.getUUID()) > 2400L) {
         addN(bag, SymbioteDesires.Desire.BLOOD, 2 + (s != SymbioteStrain.PREDATOR && s != SymbioteStrain.ROYAL ? 0 : 2) + p.stress / 30);
      }

      boolean alreadyUnder = player.getY() < 0.0;
      if (!alreadyUnder) {
         addN(bag, SymbioteDesires.Desire.DEEP, 1 + (s == SymbioteStrain.SCULK ? 3 : 0) + (s == SymbioteStrain.SHADOW ? 1 : 0));
      }

      if (level.isNight()) {
         long dayTime = level.getDayTime() % 24000L;
         if (dayTime >= 11000L && dayTime <= 22000L) {
            addN(bag, SymbioteDesires.Desire.NIGHT, 1 + (s == SymbioteStrain.SHADOW ? 3 : 0));
         }
      }

      if (p.stage.isAtLeast(BondStage.INTEGRATED) && !p.livingArmorActive && p.hunger > 25 && now - p.lastArmorToggleTick > 2400L) {
         addN(bag, SymbioteDesires.Desire.SHELL, 1 + (s != SymbioteStrain.ROYAL && s != SymbioteStrain.GUARDIAN ? 0 : 1));
      }

      return bag.isEmpty() ? null : bag.get(RANDOM.nextInt(bag.size()));
   }

   private static void addN(List<SymbioteDesires.Desire> bag, SymbioteDesires.Desire d, int n) {
      for (int i = 0; i < n; i++) {
         bag.add(d);
      }
   }

   public static boolean isUnderground(ServerPlayer player, ServerLevel level) {
      BlockPos pos = player.blockPosition();
      if (level.canSeeSky(pos)) {
         return false;
      }

      int[] hs = new int[5];
      int[][] probes = new int[][]{{0, 0}, {8, 0}, {-8, 0}, {0, 8}, {0, -8}};

      for (int i = 0; i < 5; i++) {
         hs[i] = level.getHeight(Types.MOTION_BLOCKING_NO_LEAVES, pos.getX() + probes[i][0], pos.getZ() + probes[i][1]);
      }

      Arrays.sort(hs);
      return pos.getY() >= hs[2] - 5 ? false : overburden(level, pos, hs[2]) >= 5;
   }

   private static int overburden(ServerLevel level, BlockPos pos, int surfaceY) {
      MutableBlockPos cursor = new MutableBlockPos();
      int solid = 0;

      for (int y = pos.getY() + 2; y <= surfaceY; y++) {
         cursor.set(pos.getX(), y, pos.getZ());
         if (level.getBlockState(cursor).isSolidRender()) {
            if (++solid >= 5) {
               return solid;
            }
         }
      }

      return solid;
   }

   private static void progress(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, SymbioteDesires.Desire d, boolean holding, int required) {
      if (holding) {
         p.desireProgress += 20;
         if (p.desireProgress >= required) {
            fulfilled(player, level, p, now, d);
         }
      }
   }

   private static void fulfilled(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, SymbioteDesires.Desire d) {
      UUID id = player.getUUID();
      boolean selfDone = BodyControl.recent(id, now, 60)
         || WalkSeizure.isActive(id)
         || DeepSeizure.isActive(id)
         || BLOOD_TANTRUM.containsKey(id)
         || SymbioteFeedingHunt.isHunting(id);
      clear(player, p, now, null);
      if (!selfDone) {
         SymbioteTracker.adjustTrust(level, player, SymbioteConfig.TRUST_DESIRE_FULFILLED.get(), "trust_desire");
      }

      SymbioteTracker.adjustStress(level, player, -10, "stress_desire_sated");
      p.addBeat(MoodEngine.BeatType.DESIRE_FULFILLED, now, d.name());
      ModNetwork.sendOverrideFx(player, "bond_up", 25);
      TendrilFxEntity.spawnBurst(level, player, 22, p.strain);
      VoiceLines.send(player, selfDone ? "symbiote.voice.desire_taken_done" : "symbiote.voice.desire_sated", selfDone ? 3 : 1);
      SymbioteLog.event("DESIRE_FULFILLED player={} desire={} self={}", player.getUUID(), d, selfDone);
      SymbioteTracker.get(level).setDirty();
   }

   private static boolean bodyOwned(ServerPlayer player) {
      UUID id = player.getUUID();
      return WalkSeizure.isActive(id)
         || DeepSeizure.isActive(id)
         || SymbioteCuriosity.isStaring(id)
         || TendrilSceneController.isInScene(id)
         || FirePanicEscape.isActive(id)
         || SymbioteFeedingHunt.isHunting(id)
         || DrowningSave.isActive(id);
   }

   private static void expireIgnored(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, SymbioteDesires.Desire d) {
      if (p.stage.isAtLeast(BondStage.INTEGRATED)) {
         if (startTantrum(player, level, p, now, d)) {
            TAKE_SINCE.remove(player.getUUID());
            clear(player, p, now, null);
            SymbioteTracker.adjustStress(level, player, SymbioteConfig.STRESS_DESIRE_IGNORED.get() / 2, "stress_desire_tantrum");
            SymbioteLog.event("DESIRE_TAKEN player={} desire={}", player.getUUID(), d);
            SymbioteTracker.get(level).setDirty();
            return;
         }

         long since = TAKE_SINCE.computeIfAbsent(player.getUUID(), k -> now);
         if (now - since < 2400L) {
            p.desireDeadline = now + 100L;
            return;
         }

         TAKE_SINCE.remove(player.getUUID());
      }

      ignored(player, level, p, now, d);
   }

   private static boolean startTantrum(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, SymbioteDesires.Desire d) {
      switch (d) {
         case DEEP:
            if (!player.isInWater() && (player.getVehicle() == null || !player.getVehicle().isInWater())) {
               if (DeepSeizure.start(player, level, p)) {
                  return true;
               } else {
                  player.addEffect(new MobEffectInstance(MobEffects.DARKNESS, 200, 0, false, false));
                  OverrideGate.seize(player, level, p, "desire_tantrum_deep");
                  VoiceLines.send(player, "symbiote.voice.tantrum_deep", 3);
                  ModNetwork.sendOverrideFx(player, "vignette_black", 60);
                  return true;
               }
            } else {
               return false;
            }
         case SHELL:
            boolean on = LivingArmor.forceOn(player, level, p);
            if (on) {
               OverrideGate.seize(player, level, p, "desire_tantrum_shell");
               VoiceLines.send(player, "symbiote.voice.tantrum_shell", 3);
            }

            return on;
         case FLESH:
            return HungerOverride.forceTrigger(player, level, p);
         case BLOOD:
            LivingEntity target = nearestHostile(player, level, 14.0);
            if (target == null) {
               return false;
            }

            BLOOD_TANTRUM.put(player.getUUID(), new long[]{target.getId(), now + 80L, 0L, 0L, now});
            OverrideGate.seize(player, level, p, "desire_tantrum_blood");
            Vec3 n0 = target.position().subtract(player.position());
            if (n0.lengthSqr() > 1.0E-4) {
               n0 = n0.normalize();
               player.push(n0.x * 0.5, 0.12, n0.z * 0.5);
               player.hurtMarked = true;
            }

            WalkSeizure.start(player, level, p, BlockPos.containing(target.position()), true);
            VoiceLines.send(player, "symbiote.voice.tantrum_blood", 3);
            ModNetwork.sendOverrideFx(player, "vignette_red", 40);
            return true;
         case NIGHT:
            if (level.isNight()) {
               BlockPos sky = WalkSeizure.findOpenSkySpot(player, level, 32);
               if (sky != null && WalkSeizure.start(player, level, p, sky)) {
                  return true;
               }
            }

            return false;
         default:
            return false;
      }
   }

   private static void tickBloodTantrum(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      long[] state = BLOOD_TANTRUM.get(player.getUUID());
      if (state != null) {
         Entity e = level.getEntity((int)state[0]);
         if (now < state[1] && e instanceof LivingEntity target && target.isAlive()) {
            boolean seen = hasLine(player, target);
            if (seen) {
               state[4] = now;
            }

            if (now - state[4] > 60L) {
               BLOOD_TANTRUM.remove(player.getUUID());
               if (WalkSeizure.isActive(player.getUUID())) {
                  WalkSeizure.abort(player, level, p, "blood_tantrum_lost");
               }

               SymbioteLog.event("BLOOD_TANTRUM_LOST player={} reason=no_sight", player.getUUID());
            } else {
               if (target.distanceToSqr(player) > 12.25 && !WalkSeizure.isActive(player.getUUID()) && now - state[3] > 10L) {
                  state[3] = now;
                  WalkSeizure.start(player, level, p, BlockPos.containing(target.position()), true);
               }

               if (seen && now - state[2] >= 10L && target.distanceToSqr(player) <= 196.0) {
                  state[2] = now;
                  if (TendrilMantle.strike(player, level, target.position().add(0.0, target.getBbHeight() * 0.5, 0.0)) == null) {
                     TendrilFxEntity.spawnWhip(level, player, target, 12, p.strain);
                  }

                  target.hurt(level.damageSources().playerAttack(player), 4.0F * (float)p.stageIntensity());
               }
            }
         } else {
            BLOOD_TANTRUM.remove(player.getUUID());
            if (WalkSeizure.isActive(player.getUUID())) {
               WalkSeizure.abort(player, level, p, "blood_tantrum_end");
            }

            if (e instanceof LivingEntity le && !le.isAlive()) {
               SymbioteTracker.adjustStress(level, player, -6, "stress_tantrum_sated");
               VoiceLines.send(player, "symbiote.voice.desire_taken_done", 3);
            }
         }
      }
   }

   private static boolean hasLine(ServerPlayer player, LivingEntity target) {
      return player.serverLevel()
            .clip(new ClipContext(player.getEyePosition(), target.position().add(0.0, target.getBbHeight() * 0.5, 0.0), Block.COLLIDER, Fluid.NONE, player))
            .getType()
         == Type.MISS;
   }

   private static LivingEntity nearestHostile(ServerPlayer player, ServerLevel level, double range) {
      AABB box = player.getBoundingBox().inflate(range);
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(
         LivingEntity.class, box, en -> en != player && en.isAlive() && en instanceof Enemy && HostileTargets.mayOpenOn(en, player)
      )) {
         if (hasLine(player, e)) {
            double d = e.distanceToSqr(player);
            if (d < bestSq) {
               bestSq = d;
               best = e;
            }
         }
      }

      return best;
   }

   private static void ignored(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, SymbioteDesires.Desire d) {
      clear(player, p, now, null);
      int stressCost = SymbioteConfig.STRESS_DESIRE_IGNORED.get();
      if (p.stage == BondStage.DOMINANT) {
         stressCost = stressCost * 3 / 2;
      }

      SymbioteTracker.adjustStress(level, player, stressCost, "stress_desire_ignored");
      p.addBeat(MoodEngine.BeatType.DESIRE_IGNORED, now, d.name());
      VoiceLines.send(player, "symbiote.voice.desire_denied", 2);
      player.sendSystemMessage(
         Component.literal("(its ask went unanswered. stress rises)").withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
      );
      SymbioteLog.event("DESIRE_IGNORED player={} desire={}", player.getUUID(), d);
      SymbioteTracker.get(level).setDirty();
   }

   private static void clear(ServerPlayer player, SymbioteProfile p, long now, String staleReason) {
      TAKE_SINCE.remove(player.getUUID());
      p.desireType = -1;
      p.desireDeadline = 0L;
      p.desireProgress = 0;
      p.lastDesireTick = now;
      REMINDED.remove(player.getUUID());
      if (staleReason != null) {
         SymbioteLog.event("DESIRE_CLEARED player={} reason={}", player.getUUID(), staleReason);
      }
   }

   private static void askHint(ServerPlayer player, SymbioteDesires.Desire d) {
      if ((Boolean)SymbioteConfig.DESIRE_HINTS.get()) {
         String hint = switch (d) {
            case DEEP -> "(stay underground for five full seconds)";
            case SHELL -> "(wear living armor for a full minute)";
            case FLESH -> "(it hungers. feed it meat)";
            case BLOOD -> "(it wants a kill)";
            case NIGHT -> "(it wants a kill under the open night sky)";
         };
         player.sendSystemMessage(Component.literal(hint).withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC}));
      }
   }

   private static String askPool(SymbioteDesires.Desire d) {
      return switch (d) {
         case DEEP -> "symbiote.voice.desire_deep";
         case SHELL -> "symbiote.voice.desire_shell";
         case FLESH -> "symbiote.voice.desire_flesh";
         case BLOOD -> "symbiote.voice.desire_blood";
         case NIGHT -> "symbiote.voice.desire_night";
      };
   }

   public static void onLogout(UUID player) {
      REMINDED.remove(player);
      BLOOD_TANTRUM.remove(player);
      TAKE_SINCE.remove(player);
   }

   private SymbioteDesires() {
   }

   public enum Desire {
      FLESH,
      BLOOD,
      DEEP,
      NIGHT,
      SHELL;
   }
}
