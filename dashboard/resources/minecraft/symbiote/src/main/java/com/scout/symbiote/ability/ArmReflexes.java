package com.scout.symbiote.ability;

import net.minecraft.core.registries.BuiltInRegistries;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.TorchBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

public final class ArmReflexes {
   private static final double ARROW_SCAN_RANGE = 28.0;
   private static final double ARROW_MISS_DIST = 1.6;
   private static final int ARROW_MIN_ETA = 5;
   private static final int ARROW_MAX_ETA = 45;
   public static final boolean ARROW_WALL_VAULTED = true;
   private static final int ARROW_COOLDOWN = 60;
   private static final int TORCH_COOLDOWN = 240;
   private static final int TORCH_DARK = 5;
   private static final int TORCH_SKY_MAX = 4;
   private static final float TORCH_VOICE_CHANCE = 0.25F;
   private static final Map<UUID, Long> LAST_ARROW_WALL = new HashMap<>();
   private static final Map<UUID, Long> LAST_TORCH = new HashMap<>();
   private static final Map<UUID, Vec3> LAST_POS = new HashMap<>();
   private static final Map<UUID, Set<Integer>> ROLLED = new HashMap<>();

   public static void tickArrow(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      Vec3 pos = player.position();
      Vec3 prev = LAST_POS.put(player.getUUID(), pos);
      Vec3 measuredVel = prev == null ? Vec3.ZERO : pos.subtract(prev);
      boolean canWall = false;
      AbstractArrow threat = null;
      double threatEta = 0.0;

      for (AbstractArrow arrow : level.getEntitiesOfClass(AbstractArrow.class, player.getBoundingBox().inflate(28.0))) {
         if (arrow.getOwner() != player && !(arrow.getOwner() instanceof Player)) {
            Vec3 vel = arrow.getDeltaMovement();
            double speed = vel.length();
            if (!(speed < 0.5)) {
               Vec3 toPlayer = player.getEyePosition().subtract(arrow.position());
               double dist = toPlayer.length();
               if (!(toPlayer.dot(vel) <= 0.0)) {
                  Vec3 vhat = vel.scale(1.0 / speed);
                  double along = toPlayer.dot(vhat);
                  double missSq = toPlayer.subtract(vhat.scale(along)).lengthSqr();
                  if (!(missSq > 2.5600000000000005)) {
                     double eta = dist / speed;
                     if (!(eta < 5.0) && !(eta > 45.0)) {
                        CombatSense.note(player);
                        if (canWall) {
                           Set<Integer> rolled = ROLLED.computeIfAbsent(player.getUUID(), k -> new HashSet<>());
                           if (rolled.add(arrow.getId())) {
                              if (rolled.size() > 128) {
                                 rolled.clear();
                                 rolled.add(arrow.getId());
                              }

                              if (!(level.random.nextDouble() > SymbioteConfig.ARROW_WALL_CHANCE.get())) {
                                 threat = arrow;
                                 threatEta = eta;
                                 break;
                              }
                           }
                        }
                     }
                  }
               }
            }
         }
      }

      if (threat != null) {
         Item block = ArmWall.pickWallBlock(p, level);
         if (block != null) {
            double lead = Math.min(threatEta, 20.0);
            Vec3 predicted = pos.add(measuredVel.scale(lead));
            Vec3 toArrow = new Vec3(threat.getX() - predicted.x, 0.0, threat.getZ() - predicted.z);
            if (!(toArrow.lengthSqr() < 1.0E-4)) {
               Direction face = Math.abs(toArrow.x) >= Math.abs(toArrow.z)
                  ? (toArrow.x >= 0.0 ? Direction.EAST : Direction.WEST)
                  : (toArrow.z >= 0.0 ? Direction.SOUTH : Direction.NORTH);
               BlockPos base = BlockPos.containing(predicted.x, predicted.y, predicted.z).relative(face, 2);

               for (int drop = 0; drop < 3 && level.getBlockState(base.below()).canBeReplaced(); drop++) {
                  base = base.below();
               }

               List<BlockPos> pillar = new ArrayList<>();

               for (BlockPos bp : new BlockPos[]{base.above(1), base, base.above(2)}) {
                  if (level.getBlockState(bp).canBeReplaced()) {
                     pillar.add(bp);
                  }
               }

               if (!pillar.isEmpty()) {
                  LAST_ARROW_WALL.put(player.getUUID(), now);
                  SymbioteArmsController.enqueueWall(player, pillar, block, true);
                  SymbioteLog.event(
                     "ARM_ARROW_WALL player={} block={} eta={}", player.getUUID(), BuiltInRegistries.ITEM.getKey(block), String.format("%.1f", threatEta)
                  );
               }
            }
         }
      }
   }

   public static void tickTorch(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (SymbioteConfig.ARMS_ENABLED.get() && SymbioteConfig.TORCH_REFLEX_ENABLED.get()) {
         if (p.stage.isAtLeast(BondStage.COOPERATIVE)) {
            if (p.strain != SymbioteStrain.SHADOW) {
               if (now - LAST_TORCH.getOrDefault(player.getUUID(), 0L) >= 240L) {
                  if (!WalkSeizure.isActive(player.getUUID())
                     && !DeepSeizure.isActive(player.getUUID())
                     && !TendrilSceneController.isInScene(player.getUUID())) {
                     BlockPos at = player.blockPosition();
                     if (level.dimensionType().hasSkyLight()) {
                        if (level.getBrightness(LightLayer.BLOCK, at) < 5 && level.getBrightness(LightLayer.SKY, at) <= 4) {
                           Item torch = null;
                           int usable = Math.min(p.armSlotCount(), p.armSlots.length);

                           for (int i = 0; i < usable; i++) {
                              ItemStack s = p.armSlots[i];
                              if (s != null && !s.isEmpty() && s.getItem() instanceof BlockItem bi && bi.getBlock() instanceof TorchBlock) {
                                 torch = s.getItem();
                                 break;
                              }
                           }

                           if (torch != null) {
                              Vec3 look = player.getLookAngle();
                              Direction face = Math.abs(look.x) >= Math.abs(look.z)
                                 ? (look.x >= 0.0 ? Direction.EAST : Direction.WEST)
                                 : (look.z >= 0.0 ? Direction.SOUTH : Direction.NORTH);
                              BlockPos spot = null;
                              BlockState torchState = ((BlockItem)torch).getBlock().defaultBlockState();

                              for (BlockPos cand : new BlockPos[]{
                                 at.relative(face, 2), at.relative(face, 1), at, at.relative(face.getClockWise()), at.relative(face.getCounterClockWise())
                              }) {
                                 if (level.getBlockState(cand).canBeReplaced()
                                    && level.getFluidState(cand).isEmpty()
                                    && torchState.canSurvive(level, cand)
                                    && level.getBrightness(LightLayer.BLOCK, cand) < 5) {
                                    spot = cand.immutable();
                                    break;
                                 }
                              }

                              if (spot != null) {
                                 LAST_TORCH.put(player.getUUID(), now);
                                 SymbioteArmsController.enqueueWall(player, List.of(spot), torch);
                                 if (player.getRandom().nextFloat() < 0.25F) {
                                    VoiceLines.send(player, "symbiote.voice.torch_place", 0);
                                 }

                                 SymbioteLog.event("ARM_TORCH player={} pos={}", player.getUUID(), spot);
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

   public static void onLogout(UUID player) {
      LAST_ARROW_WALL.remove(player);
      LAST_TORCH.remove(player);
      LAST_POS.remove(player);
      ROLLED.remove(player);
   }

   private ArmReflexes() {
   }
}
