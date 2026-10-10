package com.scout.symbiote.util;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

public final class SafeShove {
   private static final int PATH_STEPS = 3;
   private static final int MAX_FALL = 4;

   public static boolean ok(ServerPlayer player, ServerLevel level, Vec3 dir) {
      if (player.onGround() && !player.isPassenger()) {
         if (dir.horizontalDistanceSqr() < 1.0E-4) {
            return false;
         }

         Vec3 n = dir.normalize();

         for (int step = 1; step <= 3; step++) {
            Vec3 at = player.position().add(n.x * step, 0.0, n.z * step);
            BlockPos feet = BlockPos.containing(at);
            if (hazard(level, feet) || hazard(level, feet.above())) {
               return false;
            }

            int fall = 0;

            BlockPos probe;
            for (probe = feet.below(); fall < 4 && level.getBlockState(probe).isAir(); fall++) {
               probe = probe.below();
            }

            if (fall >= 4) {
               return false;
            }

            if (hazard(level, probe)) {
               return false;
            }
         }

         return true;
      } else {
         return false;
      }
   }

   public static boolean toward(ServerPlayer player, ServerLevel level, Vec3 target, double horizontal, double vertical) {
      Vec3 dir = target.subtract(player.position());
      if (!ok(player, level, dir)) {
         return false;
      }

      Vec3 n = dir.normalize();
      player.setDeltaMovement(n.x * horizontal, Math.max(player.getDeltaMovement().y, vertical), n.z * horizontal);
      player.hurtMarked = true;
      return true;
   }

   public static void hitch(ServerPlayer player) {
      Vec3 v = player.getDeltaMovement();
      player.setDeltaMovement(0.0, v.y, 0.0);
      player.hurtMarked = true;
   }

   public static boolean hazard(ServerLevel level, BlockPos pos) {
      if (level.getFluidState(pos).is(FluidTags.LAVA)) {
         return true;
      }

      BlockState state = level.getBlockState(pos);
      return state.is(Blocks.LAVA)
         || state.is(Blocks.FIRE)
         || state.is(Blocks.SOUL_FIRE)
         || state.is(Blocks.MAGMA_BLOCK)
         || state.is(Blocks.CAMPFIRE)
         || state.is(Blocks.SOUL_CAMPFIRE)
         || state.is(Blocks.CACTUS)
         || state.is(Blocks.SWEET_BERRY_BUSH)
         || state.is(Blocks.POWDER_SNOW)
         || state.is(Blocks.POINTED_DRIPSTONE);
   }

   private SafeShove() {
   }
}
