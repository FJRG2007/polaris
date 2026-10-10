package com.scout.symbiote.util;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

public final class Footing {
   private static final int REQUIRED_DEPTH = 5;
   private static final int REQUIRED_NEIGHBOURS = 3;

   public static boolean planted(ServerPlayer player) {
      if (player.isPassenger()) {
         return false;
      } else if (player.onClimbable()) {
         return false;
      } else if (player.isInWater() || player.isInLava()) {
         return false;
      } else if (player.isFallFlying() || player.getAbilities().flying) {
         return false;
      } else if (!player.onGround()) {
         return false;
      } else {
         Level level = player.level();
         BlockPos below = player.blockPosition().below();
         BlockState ground = level.getBlockState(below);
         if (!ground.isFaceSturdy(level, below, Direction.UP)) {
            return false;
         } else if (!ground.is(BlockTags.LEAVES) && !ground.is(BlockTags.LOGS)) {
            return depth(level, below) < 5 ? false : broad(level, below);
         } else {
            return false;
         }
      }
   }

   private static boolean broad(Level level, BlockPos below) {
      int solid = 0;

      for (int dx = -1; dx <= 1; dx++) {
         for (int dz = -1; dz <= 1; dz++) {
            if (dx != 0 || dz != 0) {
               BlockPos side = below.offset(dx, 0, dz);
               if (level.isLoaded(side)) {
                  BlockState st = level.getBlockState(side);
                  if (!st.isAir()
                     && st.getFluidState().isEmpty()
                     && !st.is(BlockTags.LEAVES)
                     && !st.is(BlockTags.LOGS)
                     && st.isFaceSturdy(level, side, Direction.UP)) {
                     solid++;
                  }
               }
            }
         }
      }

      return solid >= 3;
   }

   private static int depth(Level level, BlockPos first) {
      int found = 0;
      BlockPos pos = first;

      for (int i = 0; i < 5 && level.isLoaded(pos); i++) {
         BlockState st = level.getBlockState(pos);
         if (st.isAir() || !st.getFluidState().isEmpty() || !st.isFaceSturdy(level, pos, Direction.UP)) {
            break;
         }

         found++;
         pos = pos.below();
      }

      return found;
   }

   private Footing() {
   }
}
