package com.scout.symbiote.ability;

import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class FirePanicEscape {
   private static final int MANTLE_HOLD = 260;
   private static final int PULL_DURATION_TICKS = 35;
   private static final int TENDRIL_LIFETIME_TICKS = 90;
   private static final int REACH_DELAY_TICKS = 3;
   private static final double PULL_STRENGTH = 0.65;
   private static final double PULL_UPWARD_BIAS = 0.3;
   private static final double FIRST_PULL_YANK_MULT = 1.6;
   private static final double ANCHOR_SEARCH_RANGE = 8.0;
   private static final int TENDRIL_REACH_TICKS = 6;
   private static final double[][] ANCHOR_DIRECTIONS = new double[][]{
      {-1.208304866765305, -0.55},
      {-Math.PI / 4, -0.7},
      {-Math.PI / 6, -0.15},
      {0.0, -0.4},
      {Math.PI / 6, -0.15},
      {Math.PI / 4, -0.7},
      {1.208304866765305, -0.55}
   };
   private static final Map<UUID, FirePanicEscape.Session> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> LAST_HEAVE = new HashMap<>();
   private static final int HEAVE_INTERVAL_TICKS = 20;
   private static final int SHORE_SEARCH_RADIUS = 12;
   private static final double HEAVE_PUSH = 0.55;
   private static final double HEAVE_LIFT = 0.5;

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p, Vec3 fireSourcePos) {
      if (ACTIVE.containsKey(player.getUUID())) {
         return false;
      }

      if (player.isPassenger()) {
         player.stopRiding();
      }

      List<Vec3> anchors = findEscapeAnchors(player, level, fireSourcePos);
      if (anchors.isEmpty()) {
         return false;
      }

      int n = anchors.size();
      int[] fxIds = new int[n];
      boolean[] borrowed = new boolean[n];

      for (int i = 0; i < n; i++) {
         TendrilFxEntity fx = TendrilMantle.timedJob(player, level, anchors.get(i), 6, 43, 3, ItemStack.EMPTY);
         borrowed[i] = fx != null;
         if (fx == null) {
            float spread = (float)((Math.PI * 2) * i / Math.max(1, n));
            fx = TendrilFxEntity.spawnArm(level, player, anchors.get(i), 90, p.strain, 3, 6, spread, ItemStack.EMPTY);
            fx.setThick(true);
            fx.setGirth(0.8F);
         }

         fxIds[i] = fx.getId();
      }

      ACTIVE.put(player.getUUID(), new FirePanicEscape.Session(level.getGameTime(), anchors, fxIds, borrowed));
      SymbioteLog.event(
         "FIRE_PANIC_ESCAPE_START player={} anchors={} fire_source=({},{},{})",
         player.getUUID(),
         n,
         fireSourcePos.x,
         fireSourcePos.y,
         fireSourcePos.z
      );
      return true;
   }

   public static void tickAll(ServerLevel level) {
      Iterator<Entry<UUID, FirePanicEscape.Session>> it = ACTIVE.entrySet().iterator();
      long now = level.getGameTime();

      while (it.hasNext()) {
         Entry<UUID, FirePanicEscape.Session> e = it.next();
         FirePanicEscape.Session s = e.getValue();
         ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (player != null && player.isAlive()) {
            if (player.serverLevel() == level) {
               if (s.phase == FirePanicEscape.Phase.PULL) {
                  if (tickPull(level, player, s, now)) {
                     transitionToRetract(level, s, now);
                  }
               } else if (now - s.phaseStartTick >= 16L) {
                  discardFx(level, s);
                  SymbioteLog.event("FIRE_PANIC_ESCAPE_END player={} reason=retract_complete", player.getUUID());
                  it.remove();
                  SymbioteProfile mp = SymbioteTracker.get(level).peek(player.getUUID());
                  if (mp != null && mp.stage.isBonded()) {
                     TendrilMantle.ensureUp(player, level, mp, 260);
                  }
               }
            }
         } else {
            discardFx(level, s);
            it.remove();
         }
      }
   }

   private static boolean tickPull(ServerLevel level, ServerPlayer player, FirePanicEscape.Session s, long now) {
      long pullElapsed = now - s.phaseStartTick;
      if (pullElapsed >= 35L) {
         return true;
      }

      if (pullElapsed < 3L) {
         return false;
      }

      Vec3 toCentroid = s.centroid.subtract(player.position());
      Vec3 horiz = new Vec3(toCentroid.x, 0.0, toCentroid.z);
      double horizLen = horiz.length();
      if (horizLen < 0.6) {
         return true;
      }

      Vec3 horizDir = horiz.scale(1.0 / horizLen);
      boolean firstPull = pullElapsed == 3L;
      double mult = firstPull ? 1.6 : 1.0;
      player.setDeltaMovement(horizDir.x * 0.65 * mult, 0.3 * mult, horizDir.z * 0.65 * mult);
      player.hurtMarked = true;
      player.fallDistance = 0.0F;
      return false;
   }

   private static void transitionToRetract(ServerLevel level, FirePanicEscape.Session s, long now) {
      s.phase = FirePanicEscape.Phase.RETRACT;
      s.phaseStartTick = now;

      for (int id : s.tendrilFxIds) {
         if (level.getEntity(id) instanceof TendrilFxEntity tendril) {
            if (tendril.getMantleJobStart() != 0) {
               TendrilMantle.endJob(level, tendril);
            } else {
               Vec3 tip = tendril.getTargetPos();
               tendril.setTransitionFrom(tip.x, tip.y, tip.z, tendril.tickCount);
               tendril.setRetractStartTick(tendril.tickCount);
            }
         }
      }

      SymbioteLog.event("FIRE_PANIC_RETRACT_START player={}", "(level-tick)");
   }

   private static void discardFx(ServerLevel level, FirePanicEscape.Session s) {
      for (int i = 0; i < s.tendrilFxIds.length; i++) {
         if (!s.borrowed[i]) {
            Entity ent = level.getEntity(s.tendrilFxIds[i]);
            if (ent != null && !TendrilMantle.handOff(level, ent)) {
               ent.discard();
            }
         }
      }
   }

   private static Vec3 computeCentroid(List<Vec3> anchors) {
      double cx = 0.0;
      double cy = 0.0;
      double cz = 0.0;

      for (Vec3 a : anchors) {
         cx += a.x;
         cy += a.y;
         cz += a.z;
      }

      int n = Math.max(1, anchors.size());
      return new Vec3(cx / n, cy / n, cz / n);
   }

   private static List<Vec3> findEscapeAnchors(ServerPlayer player, ServerLevel level, Vec3 fireSourcePos) {
      Vec3 playerPos = player.position();
      Vec3 awayDir = playerPos.subtract(fireSourcePos);
      awayDir = new Vec3(awayDir.x, 0.0, awayDir.z);
      if (awayDir.lengthSqr() < 1.0E-4) {
         float yawRad = (float)Math.toRadians(player.getYRot());
         awayDir = new Vec3(-Math.sin(yawRad), 0.0, Math.cos(yawRad));
      }

      awayDir = awayDir.normalize();
      List<Vec3> hits = new ArrayList<>(ANCHOR_DIRECTIONS.length);

      for (double[] offsets : ANCHOR_DIRECTIONS) {
         double yawOff = offsets[0];
         double pitchY = offsets[1];
         Vec3 dir = rotateAroundY(awayDir, yawOff).add(0.0, pitchY, 0.0).normalize();
         Vec3 hit = raycastForAnchor(player, level, dir);
         if (safeAnchor(level, hit, playerPos, fireSourcePos)) {
            hits.add(hit);
         }
      }

      double[] padYaw = new double[]{0.0, 0.55, -0.55, 1.1, -1.1};

      for (int k = 0; hits.size() < 5 && k < padYaw.length; k++) {
         Vec3 dir = rotateAroundY(awayDir, padYaw[k]).add(0.0, -0.85, 0.0).normalize();
         Vec3 hit = raycastForAnchor(player, level, dir);
         if (safeAnchor(level, hit, playerPos, fireSourcePos)) {
            hits.add(hit);
         }
      }

      double[] upPitch = new double[]{0.0, 0.35, 0.8};

      for (double pitch : upPitch) {
         for (int k = 0; hits.size() < 5 && k < padYaw.length; k++) {
            Vec3 dir = rotateAroundY(awayDir, padYaw[k]).add(0.0, pitch, 0.0).normalize();
            Vec3 hit = raycastForAnchor(player, level, dir);
            if (safeAnchor(level, hit, playerPos, fireSourcePos)) {
               hits.add(hit);
            }
         }
      }

      if (!hits.isEmpty() && !further(computeCentroid(hits), playerPos, fireSourcePos, 0.5)) {
         SymbioteLog.event("FIRE_PANIC_ANCHORS_REJECTED player={} reason=centroid_not_clear", player.getUUID());
         return new ArrayList<>();
      } else {
         return hits;
      }
   }

   private static boolean safeAnchor(ServerLevel level, Vec3 hit, Vec3 playerPos, Vec3 firePos) {
      if (hit == null) {
         return false;
      }

      BlockPos at = BlockPos.containing(hit);
      return !hazard(level, at) && !hazard(level, at.above()) && !hazard(level, at.below()) ? further(hit, playerPos, firePos, 0.0) : false;
   }

   private static boolean hazard(ServerLevel level, BlockPos pos) {
      BlockState st = level.getBlockState(pos);
      return st.is(Blocks.LAVA) || !st.getFluidState().isEmpty() && st.getFluidState().is(FluidTags.LAVA);
   }

   private static boolean further(Vec3 point, Vec3 playerPos, Vec3 firePos, double margin) {
      double px = point.x - firePos.x;
      double pz = point.z - firePos.z;
      double hx = playerPos.x - firePos.x;
      double hz = playerPos.z - firePos.z;
      return px * px + pz * pz > hx * hx + hz * hz + margin;
   }

   private static Vec3 rotateAroundY(Vec3 v, double yawRad) {
      double cos = Math.cos(yawRad);
      double sin = Math.sin(yawRad);
      return new Vec3(v.x * cos - v.z * sin, v.y, v.x * sin + v.z * cos);
   }

   private static Vec3 raycastForAnchor(ServerPlayer player, ServerLevel level, Vec3 dir) {
      Vec3 from = player.getEyePosition();
      Vec3 to = from.add(dir.scale(8.0));
      ClipContext ctx = new ClipContext(from, to, Block.COLLIDER, Fluid.ANY, player);
      BlockHitResult hit = level.clip(ctx);
      return hit.getType() == Type.BLOCK ? hit.getLocation() : null;
   }

   public static void heave(ServerPlayer player, ServerLevel level, Vec3 firePos) {
      long now = level.getGameTime();
      Long last = LAST_HEAVE.get(player.getUUID());
      if (last == null || now - last >= 20L) {
         Vec3 shore = findShore(player, level);
         if (shore == null) {
            if (now % 20L == 0L) {
               SymbioteLog.event("FIRE_PANIC_NO_SHORE player={} pos=({},{},{})", player.getUUID(), player.getX(), player.getY(), player.getZ());
            }
         } else {
            LAST_HEAVE.put(player.getUUID(), now);
            Vec3 flat = new Vec3(shore.x - player.getX(), 0.0, shore.z - player.getZ());
            double len = flat.length();
            Vec3 dir = len < 0.001 ? new Vec3(0.0, 0.0, 0.0) : flat.scale(1.0 / len);
            player.push(dir.x * 0.55, 0.5, dir.z * 0.55);
            player.hurtMarked = true;
            SymbioteLog.event("FIRE_PANIC_HEAVE player={} shore=({},{},{}) dist={}", player.getUUID(), shore.x, shore.y, shore.z, len);
         }
      }
   }

   private static Vec3 findShore(ServerPlayer player, ServerLevel level) {
      BlockPos base = player.blockPosition();

      for (int r = 2; r <= 12; r++) {
         for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
               if (Math.max(Math.abs(dx), Math.abs(dz)) == r) {
                  for (int dy = -1; dy <= 3; dy++) {
                     BlockPos foot = base.offset(dx, dy, dz);
                     if (level.isLoaded(foot)) {
                        BlockPos ground = foot.below();
                        if (level.getBlockState(ground).isFaceSturdy(level, ground, Direction.UP)
                           && level.getBlockState(foot).isAir()
                           && level.getBlockState(foot.above()).isAir()
                           && !hazard(level, ground)
                           && !hazard(level, foot)
                           && !hazard(level, foot.above())) {
                           boolean touched = false;

                           for (Direction d : Direction.values()) {
                              if (hazard(level, foot.relative(d))) {
                                 touched = true;
                                 break;
                              }
                           }

                           if (!touched) {
                              return new Vec3(foot.getX() + 0.5, foot.getY(), foot.getZ() + 0.5);
                           }
                        }
                     }
                  }
               }
            }
         }
      }

      return null;
   }

   public static void clear(UUID player) {
      LAST_HEAVE.remove(player);
      ACTIVE.remove(player);
   }

   public static void forceClear(ServerLevel level, UUID player) {
      FirePanicEscape.Session s = ACTIVE.remove(player);
      if (s != null) {
         discardFx(level, s);
      }
   }

   public static void onLogout(UUID player) {
      LAST_HEAVE.remove(player);
      ACTIVE.remove(player);
   }

   private FirePanicEscape() {
   }

   public enum Phase {
      PULL,
      RETRACT;
   }

   public static final class Session {
      public final long startTick;
      public final int[] tendrilFxIds;
      public final boolean[] borrowed;
      public final List<Vec3> anchors;
      public final Vec3 centroid;
      public FirePanicEscape.Phase phase;
      public long phaseStartTick;

      Session(long startTick, List<Vec3> anchors, int[] fxIds, boolean[] borrowed) {
         this.startTick = startTick;
         this.anchors = anchors;
         this.tendrilFxIds = fxIds;
         this.borrowed = borrowed;
         this.centroid = FirePanicEscape.computeCentroid(anchors);
         this.phase = FirePanicEscape.Phase.PULL;
         this.phaseStartTick = startTick;
      }
   }
}
