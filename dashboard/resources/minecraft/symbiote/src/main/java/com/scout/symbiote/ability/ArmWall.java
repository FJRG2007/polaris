package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;

public final class ArmWall {
   private static final Map<UUID, Long> LAST_BUILD = new HashMap<>();
   private static final int LEN = 5;
   private static final float BUILD_VOICE_CHANCE = 0.3F;

   public static void smartBuild(ServerPlayer player, SymbioteProfile p) {
      if (SymbioteConfig.ARMS_ENABLED.get() && SymbioteConfig.ARMS_WALL_ENABLED.get() && p != null && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
         if (!cooldownReady(player)) {
            VoiceLines.send(player, "symbiote.voice.ability_too_soon", 4);
         } else {
            ServerLevel level = player.serverLevel();
            Item block = pickWallBlock(p, level);
            if (block == null) {
               VoiceLines.send(player, "symbiote.voice.wall_nomaterial", 4);
            } else {
               Vec3 look = player.getLookAngle();
               List<BlockPos> positions;
               String voicePool;
               int voiceTone;
               if (look.y > 0.35) {
                  positions = computeStaircase(level, player, look);
                  voicePool = "symbiote.voice.build_staircase";
                  voiceTone = 0;
               } else if (gapAhead(level, player, look)) {
                  positions = computeBridge(level, player, look);
                  voicePool = "symbiote.voice.build_bridge";
                  voiceTone = 0;
               } else {
                  Vec3 dir = nearestThreatDir(level, player);
                  if (dir == null) {
                     dir = horizontalLook(look);
                  }

                  positions = computeWall(level, player, dir);
                  voicePool = "symbiote.voice.wall";
                  voiceTone = 3;
               }

               if (!positions.isEmpty()) {
                  LAST_BUILD.put(player.getUUID(), level.getGameTime());
                  SymbioteArmsController.enqueueWall(player, positions, block);
                  if (player.getRandom().nextFloat() < 0.3F) {
                     VoiceLines.send(player, voicePool, voiceTone);
                  }
               }
            }
         }
      } else {
         if (p != null && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
            VoiceLines.send(player, "symbiote.voice.arms_locked", 2);
         }
      }
   }

   private static boolean cooldownReady(ServerPlayer player) {
      long now = player.serverLevel().getGameTime();
      Long last = LAST_BUILD.get(player.getUUID());
      return last == null || now - last >= SymbioteConfig.ARMS_WALL_COOLDOWN_TICKS.get().intValue();
   }

   private static List<BlockPos> computeWall(ServerLevel level, ServerPlayer player, Vec3 dir) {
      Direction face = horizontalFacing(dir);
      Direction perp = face.getClockWise();
      BlockPos base = player.blockPosition().relative(face, 2);
      List<BlockPos> out = new ArrayList<>();

      for (int w = -1; w <= 1; w++) {
         for (int h = 0; h <= 2; h++) {
            BlockPos pos = base.relative(perp, w).above(h);
            if (level.getBlockState(pos).canBeReplaced()) {
               out.add(pos);
            }
         }
      }

      return out;
   }

   private static List<BlockPos> computeBridge(ServerLevel level, ServerPlayer player, Vec3 look) {
      Direction face = horizontalFacing(look);
      BlockPos floor = player.blockPosition().below();
      List<BlockPos> out = new ArrayList<>();

      for (int i = 1; i <= 5; i++) {
         BlockPos pos = floor.relative(face, i);
         if (level.getBlockState(pos).canBeReplaced()) {
            out.add(pos);
         }
      }

      return out;
   }

   private static List<BlockPos> computeStaircase(ServerLevel level, ServerPlayer player, Vec3 look) {
      Direction face = horizontalFacing(look);
      BlockPos floor = player.blockPosition().below();
      List<BlockPos> out = new ArrayList<>();

      for (int i = 1; i <= 5; i++) {
         BlockPos pos = floor.relative(face, i).above(i - 1);
         if (level.getBlockState(pos).canBeReplaced()) {
            out.add(pos);
         }
      }

      return out;
   }

   private static boolean gapAhead(ServerLevel level, ServerPlayer player, Vec3 look) {
      Direction face = horizontalFacing(look);
      BlockPos floorAhead = player.blockPosition().below().relative(face);
      return level.getBlockState(floorAhead).canBeReplaced() && level.getBlockState(floorAhead.above()).canBeReplaced();
   }

   private static Direction horizontalFacing(Vec3 v) {
      return Math.abs(v.x) >= Math.abs(v.z)
         ? (v.x >= 0.0 ? Direction.EAST : Direction.WEST)
         : (v.z >= 0.0 ? Direction.SOUTH : Direction.NORTH);
   }

   private static Vec3 horizontalLook(Vec3 look) {
      Vec3 h = new Vec3(look.x, 0.0, look.z);
      return h.lengthSqr() < 1.0E-4 ? new Vec3(0.0, 0.0, 1.0) : h.normalize();
   }

   private static Vec3 nearestThreatDir(ServerLevel level, ServerPlayer player) {
      List<Monster> mobs = level.getEntitiesOfClass(Monster.class, player.getBoundingBox().inflate(11.0), mx -> mx.isAlive());
      if (mobs.isEmpty()) {
         return null;
      }

      Vec3 acc = Vec3.ZERO;

      for (Monster m : mobs) {
         Vec3 d = new Vec3(m.getX() - player.getX(), 0.0, m.getZ() - player.getZ());
         if (d.lengthSqr() > 1.0E-4) {
            acc = acc.add(d.normalize());
         }
      }

      return acc.lengthSqr() < 1.0E-4 ? null : acc.normalize();
   }

   static Item pickWallBlock(SymbioteProfile p, ServerLevel level) {
      Item best = null;
      int bestCount = 0;
      int n = Math.min(p.armSlotCount(), p.armSlots.length);

      for (int i = 0; i < n; i++) {
         ItemStack s = p.armSlots[i];
         if (s != null
            && !s.isEmpty()
            && s.getItem() instanceof BlockItem bi
            && bi.getBlock().defaultBlockState().isCollisionShapeFullBlock(level, BlockPos.ZERO)
            && s.getCount() > bestCount) {
            bestCount = s.getCount();
            best = s.getItem();
         }
      }

      return best;
   }

   public static void clear(UUID player) {
      LAST_BUILD.remove(player);
   }

   private ArmWall() {
   }
}
