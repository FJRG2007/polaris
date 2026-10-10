package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Direction.Plane;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class WallCling {
   private static final double DRIFT_SQ = 0.0025;
   private static final double[] GRIP_HEIGHTS = new double[]{0.15, 0.55, 0.95, 1.3, 1.65, 1.9};
   private static final double[] GRIP_SIDES = new double[]{-0.5, 0.4, -0.22, 0.5, -0.42, 0.18};
   private static final Map<UUID, Long> CLINGING_UNTIL = new HashMap<>();
   private static final Map<UUID, Vec3> ANCHOR = new HashMap<>();
   private static final Map<UUID, int[]> CLING_FX = new HashMap<>();

   public static void fire(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (CLINGING_UNTIL.containsKey(player.getUUID())) {
         release(player, "toggle_off");
      } else {
         Direction facing = nearestWallFace(player, level);
         if (facing == null) {
            SymbioteLog.event("ABILITY_REJECTED ability=wall_cling player={} reason=no_wall", player.getUUID());
         } else if (!p.trySpendStamina(SymbioteConfig.STAMINA_COST_CLING.get())) {
            SymbioteLog.event("ABILITY_REJECTED ability=wall_cling player={} reason=exhausted stamina={}", player.getUUID(), p.stamina);
            VoiceLines.send(player, "symbiote.voice.exhausted", 4);
         } else {
            SymbioteTracker.get(level).setDirty();
            ModNetwork.syncToPlayer(level, player);
            int duration = SymbioteConfig.WALL_CLING_DURATION_TICKS.get();
            long until = level.getGameTime() + duration;
            CLINGING_UNTIL.put(player.getUUID(), until);
            ANCHOR.put(player.getUUID(), player.position());
            spawnClingTendrils(player, level, p, facing, duration);
            level.playSound(
               null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.6F, 0.95F
            );
            SymbioteLog.event("ABILITY_FIRED ability=wall_cling player={} until={} face={} duration={}", player.getUUID(), until, facing, duration);
         }
      }
   }

   public static boolean isClinging(UUID player, long currentTick) {
      Long until = CLINGING_UNTIL.get(player);
      return until != null && until > currentTick;
   }

   public static void tick(ServerPlayer player, ServerLevel level) {
      long now = level.getGameTime();
      Long until = CLINGING_UNTIL.get(player.getUUID());
      if (until != null) {
         if (until <= now) {
            release(player, "duration_expired");
         } else if (FirePanicEscape.isActive(player.getUUID())) {
            release(player, "fire_panic");
         } else {
            player.setDeltaMovement(Vec3.ZERO);
            player.resetFallDistance();
            player.hurtMarked = true;
            Vec3 anchor = ANCHOR.get(player.getUUID());
            if (anchor != null && player.position().distanceToSqr(anchor) > 0.0025) {
               player.connection.teleport(anchor.x, anchor.y, anchor.z, player.getYRot(), player.getXRot());
            }
         }
      }
   }

   public static void purgeExpired(long currentTick) {
   }

   public static void forceRelease(ServerPlayer player, String reason) {
      if (CLINGING_UNTIL.containsKey(player.getUUID())) {
         release(player, reason);
      }
   }

   private static void release(ServerPlayer player, String reason) {
      CLINGING_UNTIL.remove(player.getUUID());
      ANCHOR.remove(player.getUUID());
      retractClingTendrils(player.serverLevel(), player.getUUID());
      SymbioteLog.event("ABILITY_RELEASED ability=wall_cling player={} reason={}", player.getUUID(), reason);
   }

   private static void spawnClingTendrils(ServerPlayer player, ServerLevel level, SymbioteProfile p, Direction facing, int duration) {
      Vec3 faceVec = new Vec3(facing.getStepX(), 0.0, facing.getStepZ());
      Vec3 perp = new Vec3(-faceVec.z, 0.0, faceVec.x);
      Vec3 base = player.position();
      int life = duration + 20;
      List<Integer> ids = new ArrayList<>();
      int spawned = 0;

      for (int k = 0; k < GRIP_HEIGHTS.length; k++) {
         Vec3 start = base.add(perp.scale(GRIP_SIDES[k])).add(0.0, GRIP_HEIGHTS[k], 0.0);
         Vec3 end = start.add(faceVec.scale(1.6));
         BlockHitResult hit = level.clip(new ClipContext(start, end, Block.COLLIDER, Fluid.NONE, player));
         if (hit.getType() == Type.BLOCK) {
            Vec3 grip = hit.getLocation().subtract(faceVec.scale(0.03));
            TendrilFxEntity fx = TendrilMantle.beginJob(player, level, grip);
            if (fx != null) {
               fx.setReachTicksOverride(4 + spawned % 3);
            } else {
               fx = TendrilFxEntity.spawnGrabAtPoint(level, player, grip, life, p.strain);
               fx.setReachTicksOverride(4 + spawned % 3);
               fx.setArc(0.14F + 0.1F * (spawned % 2), (float)((Math.PI * 2) * spawned / GRIP_HEIGHTS.length));
            }

            ids.add(fx.getId());
            spawned++;
         }
      }

      int[] arr = new int[ids.size()];

      for (int j = 0; j < arr.length; j++) {
         arr[j] = ids.get(j);
      }

      CLING_FX.put(player.getUUID(), arr);
   }

   private static void retractClingTendrils(ServerLevel level, UUID player) {
      int[] ids = CLING_FX.remove(player);
      if (ids != null) {
         for (int id : ids) {
            if (level.getEntity(id) instanceof TendrilFxEntity fx && !TendrilMantle.handOff(level, fx)) {
               Vec3 tip = fx.getTargetPos();
               fx.setTransitionFrom(tip.x, tip.y, tip.z, fx.tickCount);
               fx.setRetractStartTick(fx.tickCount);
               fx.setLifetime(fx.tickCount + 16);
            }
         }
      }
   }

   private static Direction nearestWallFace(ServerPlayer player, ServerLevel level) {
      BlockPos pos = player.blockPosition();

      for (Direction d : Plane.HORIZONTAL) {
         BlockPos check = pos.relative(d);
         BlockState state = level.getBlockState(check);
         if (!state.isAir() && state.isCollisionShapeFullBlock(level, check)) {
            return d;
         }
      }

      return null;
   }

   public static void onLogout(UUID player) {
      CLINGING_UNTIL.remove(player);
      ANCHOR.remove(player);
      CLING_FX.remove(player);
   }

   private WallCling() {
   }
}
