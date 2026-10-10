package com.scout.symbiote.event;

import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.common.Tags.Blocks;
import net.neoforged.neoforge.event.level.BlockEvent.BreakEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class ArmVeinListener {
   @SubscribeEvent
   public static void onBreak(BreakEvent event) {
      if (!event.isCanceled()) {
         if (SymbioteConfig.ARMS_ENABLED.get() && SymbioteConfig.ARMS_VEIN_ASSIST.get()) {
            if (event.getPlayer() instanceof ServerPlayer player) {
               if (event.getLevel() instanceof ServerLevel level) {
                  BlockState broken = event.getState();
                  if (broken.is(Blocks.ORES)) {
                     SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
                     if (p != null && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
                        if (!SymbioteArmsController.isBusy(player.getUUID())) {
                           int slot = SymbioteArmsController.pickToolSlot(p, broken);
                           if (slot >= 0) {
                              ItemStack tool = p.armSlots[slot];
                              if (!tool.isEmpty() && tool.isCorrectToolForDrops(broken)) {
                                 List<BlockPos> vein = floodFill(level, event.getPos(), broken.getBlock(), player, SymbioteConfig.ARMS_VEIN_MAX.get());
                                 if (!vein.isEmpty()) {
                                    SymbioteArmsController.enqueueVein(player, p, slot, vein);
                                 }
                              }
                           }
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static List<BlockPos> floodFill(ServerLevel level, BlockPos start, Block block, ServerPlayer player, int max) {
      List<BlockPos> result = new ArrayList<>();
      Set<BlockPos> seen = new HashSet<>();
      Deque<BlockPos> q = new ArrayDeque<>();
      BlockPos s = start.immutable();
      seen.add(s);
      q.add(s);
      Vec3 eye = player.getEyePosition();
      double maxSq = 56.25;

      while (!q.isEmpty() && result.size() < max) {
         BlockPos cur = q.poll();

         for (int dx = -1; dx <= 1; dx++) {
            for (int dy = -1; dy <= 1; dy++) {
               for (int dz = -1; dz <= 1; dz++) {
                  if (dx != 0 || dy != 0 || dz != 0) {
                     BlockPos pos = cur.offset(dx, dy, dz);
                     if (seen.add(pos) && level.getBlockState(pos).is(block) && eye.distanceToSqr(Vec3.atCenterOf(pos)) <= maxSq) {
                        result.add(pos);
                        q.add(pos);
                        if (result.size() >= max) {
                           return result;
                        }
                     }
                  }
               }
            }
         }
      }

      return result;
   }

   private ArmVeinListener() {
   }
}
