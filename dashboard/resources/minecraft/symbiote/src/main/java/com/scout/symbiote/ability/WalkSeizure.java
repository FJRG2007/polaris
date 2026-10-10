package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.NavigatorEntity;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModEntities;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class WalkSeizure {
   private static final int MAX_TICKS = 600;
   private static final double NODE_REACHED_DIST = 0.75;
   private static final double STEER_SPEED = 0.27;
   private static final double ESCAPE_DIST = 6.0;
   private static final int STALL_WINDOW = 30;
   private static final int REPATH_LIMIT = 3;
   private static final int DIAG_EVERY = 40;
   private static final int DOOR_RIP_TICKS = 14;
   private static final double DOOR_SCAN_RADIUS = 3.0;
   private static final double DOOR_SEEK_RADIUS = 16.0;
   private static final int DOOR_SEEK_LIMIT = 2;
   private static final Map<UUID, WalkSeizure.Session> ACTIVE = new HashMap<>();
   private static final Set<UUID> ATTACKED = new HashSet<>();

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static void notifyHostAttacked(UUID player) {
      if (ACTIVE.containsKey(player)) {
         ATTACKED.add(player);
      }
   }

   public static boolean isNavigator(int entityId) {
      return false;
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p, BlockPos target) {
      return start(player, level, p, target, false);
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p, BlockPos target, boolean quiet) {
      if (ACTIVE.containsKey(player.getUUID())) {
         return false;
      }

      if (DeepSeizure.isActive(player.getUUID())) {
         return false;
      }

      if (TendrilSceneController.isInScene(player.getUUID())) {
         return false;
      }

      if (FirePanicEscape.isActive(player.getUUID())) {
         return false;
      }

      if (DrowningSave.isActive(player.getUUID())) {
         return false;
      }

      if (player.isPassenger()) {
         return false;
      }

      List<BlockPos> nodes = computePath(player, level, target);
      if (nodes != null && !nodes.isEmpty()) {
         ACTIVE.put(player.getUUID(), new WalkSeizure.Session(target, nodes, player, quiet));
         ModNetwork.sendBodySeized(player, true, true);
         OverrideGate.seize(player, level, p, "walk_seizure");
         if (!quiet) {
            VoiceLines.send(player, "symbiote.voice.seizure_walk", 3);
         }

         ModNetwork.sendOverrideFx(player, "vignette_black", 40);
         SymbioteLog.event("WALK_SEIZURE_START player={} target={} nodes={} quiet={}", player.getUUID(), target, nodes.size(), quiet);
         return true;
      } else {
         return false;
      }
   }

   private static List<BlockPos> computePath(ServerPlayer player, ServerLevel level, BlockPos target) {
      NavigatorEntity nav = new NavigatorEntity((EntityType<? extends PathfinderMob>)ModEntities.NAVIGATOR.get(), level);
      nav.moveTo(player.getX(), player.getY(), player.getZ(), player.getYRot(), 0.0F);
      level.addFreshEntity(nav);
      nav.setOnGround(true);
      Path path = nav.getNavigation().createPath(target, 1);
      List<BlockPos> nodes = null;
      if (path != null && path.getNodeCount() > 0) {
         nodes = new ArrayList<>(path.getNodeCount());

         for (int i = 0; i < path.getNodeCount(); i++) {
            nodes.add(path.getNodePos(i));
         }
      }

      nav.discard();
      return nodes;
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      WalkSeizure.Session s = ACTIVE.get(player.getUUID());
      if (s != null) {
         s.age++;
         if (s.age % 40 == 0) {
            ModNetwork.sendBodySeized(player, true, true);
         }

         if (s.age % 20 == 0) {
            LivingArmor.autoSheathIfThreatened(player, level, p);
            marchGuard(player, level, p);
         }

         if (ATTACKED.remove(player.getUUID()) && s.age > 10 && !HungerOverride.isStalking(player.getUUID())) {
            release(player, level, p, false, "host_attacked");
         } else if (s.age > 600) {
            release(player, level, p, false, "timeout");
         } else if (s.ripDoor != null) {
            if (s.age >= s.ripTearAge) {
               tearDoor(player, level, s);
               s.repaths = 0;
               s.stallTicks = 0;
               if (!repath(player, level, s)) {
                  release(player, level, p, false, "no_path_after_rip");
               }
            }
         } else {
            while (s.nodeIdx < s.nodes.size() && horizDistSq(player, s.nodes.get(s.nodeIdx)) < 0.5625) {
               s.nodeIdx++;
            }

            if (s.nodeIdx >= s.nodes.size()) {
               boolean arrived = horizDistSq(player, s.target) < 6.25;
               if (!arrived || targetObstructed(player, level, s.target) && tryStartDoorRip(player, level, p, s)) {
                  if (!arrived && !tryStartDoorRip(player, level, p, s) && !repath(player, level, s)) {
                     release(player, level, p, false, "no_path_onward");
                  }
               } else {
                  release(player, level, p, true, "arrived");
               }
            } else {
               BlockPos node = s.nodes.get(s.nodeIdx);
               double dx = node.getX() + 0.5 - player.getX();
               double dz = node.getZ() + 0.5 - player.getZ();
               double distSq = dx * dx + dz * dz;
               if (distSq > 36.0) {
                  if (!repath(player, level, s)) {
                     release(player, level, p, false, "lost_path");
                  }
               } else {
                  double len = Math.sqrt(distSq);
                  double nx = dx / len;
                  double nz = dz / len;
                  if (!player.isSprinting()) {
                     player.setSprinting(true);
                  }

                  if (player.onGround()) {
                     if (node.getY() > player.getBlockY()) {
                        player.setDeltaMovement(nx * 0.4, 0.42, nz * 0.4);
                     } else {
                        player.setDeltaMovement(nx * 0.27, -0.08, nz * 0.27);
                     }

                     player.hurtMarked = true;
                  }

                  double moved = Math.abs(player.getX() - s.lastX) + Math.abs(player.getZ() - s.lastZ);
                  s.lastX = player.getX();
                  s.lastZ = player.getZ();
                  if (moved < 0.03) {
                     s.stallTicks++;
                  } else {
                     s.stallTicks = Math.max(0, s.stallTicks - 2);
                  }

                  if (s.stallTicks > 30) {
                     s.stallTicks = 0;
                     if (tryStartDoorRip(player, level, p, s)) {
                        return;
                     }

                     if (tryTerrainBite(player, level, p, s)) {
                        return;
                     }

                     if (player.horizontalCollision && !level.noCollision(player, player.getBoundingBox().move(0.0, 0.9, 0.0))) {
                        release(player, level, p, false, "wedged");
                        return;
                     }

                     if (!repath(player, level, s)) {
                        release(player, level, p, false, "blocked");
                     }
                  }

                  if (s.age % 40 == 0) {
                     SymbioteLog.event(
                        "WALK_SEIZURE_DIAG player={} node={}/{} distToNode={} stall={} repaths={}",
                        player.getUUID(),
                        s.nodeIdx,
                        s.nodes.size(),
                        String.format("%.2f", len),
                        s.stallTicks,
                        s.repaths
                     );
                  }
               }
            }
         }
      }
   }

   private static boolean tryTerrainBite(ServerPlayer player, ServerLevel level, SymbioteProfile p, WalkSeizure.Session s) {
      if (!(Boolean)SymbioteConfig.WALK_TERRAIN_BITE.get()) {
         return false;
      }

      if (s.terrainBites >= 4) {
         return false;
      }

      if (s.nodeIdx >= s.nodes.size()) {
         return false;
      }

      BlockPos node = s.nodes.get(s.nodeIdx);
      Vec3 dir = new Vec3(node.getX() + 0.5 - player.getX(), 0.0, node.getZ() + 0.5 - player.getZ());
      if (dir.lengthSqr() < 1.0E-4) {
         return false;
      }

      dir = dir.normalize();
      BlockPos feet = BlockPos.containing(player.getX() + dir.x * 0.8, player.getY() + 0.2, player.getZ() + dir.z * 0.8);
      List<BlockPos> candidates = new ArrayList<>(3);
      candidates.add(feet);
      candidates.add(feet.above());
      candidates.add(BlockPos.containing(player.getX(), player.getY() + player.getBbHeight() + 0.6, player.getZ()));
      int bitten = 0;

      for (BlockPos pos : candidates) {
         if (bitten >= 2 || s.terrainBites >= 4) {
            break;
         }

         BlockState state = level.getBlockState(pos);
         if (!state.isAir() && state.getFluidState().isEmpty() && !(state.getDestroySpeed(level, pos) < 0.0F) && !state.is(BlockTags.DOORS)) {
            TendrilMantle.strike(player, level, Vec3.atCenterOf(pos));
            level.destroyBlock(pos, true, player);
            bitten++;
            s.terrainBites++;
            SymbioteLog.event("WALK_TERRAIN_BITE player={} pos={} block={} total={}", player.getUUID(), pos.toShortString(), state.getBlock(), s.terrainBites);
         }
      }

      return bitten > 0;
   }

   public static void abort(ServerPlayer player, ServerLevel level, SymbioteProfile p, String reason) {
      if (ACTIVE.containsKey(player.getUUID())) {
         release(player, level, p, false, reason);
      }
   }

   private static void marchGuard(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      LivingEntity threat = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(
         LivingEntity.class, player.getBoundingBox().inflate(3.5), en -> en != player && en.isAlive() && en instanceof Enemy && HostileTargets.mayOpenOn(en, player)
      )) {
         double d = e.distanceToSqr(player);
         if (d < bestSq) {
            bestSq = d;
            threat = e;
         }
      }

      if (threat != null) {
         if (TendrilMantle.strike(player, level, threat.position().add(0.0, threat.getBbHeight() * 0.5, 0.0)) == null) {
            TendrilFxEntity.spawnWhip(level, player, threat, 12, p.strain);
         }

         threat.hurt(level.damageSources().playerAttack(player), 4.0F * (float)p.stageIntensity());
         Vec3 away = threat.position().subtract(player.position());
         if (away.lengthSqr() > 1.0E-4) {
            Vec3 n = away.normalize();
            threat.setDeltaMovement(n.x * 0.8, 0.3, n.z * 0.8);
            threat.hurtMarked = true;
         }
      }
   }

   private static boolean tryStartDoorRip(ServerPlayer player, ServerLevel level, SymbioteProfile p, WalkSeizure.Session s) {
      if (!(Boolean)SymbioteConfig.WALK_DOOR_RIP.get()) {
         return false;
      }

      BlockPos door = findClosedWoodenDoor(player, level, s, 3.0, true);
      if (door != null) {
         s.ripDoor = door;
         s.ripTearAge = s.age + 14;
         s.rippedDoors.add(door);
         if (TendrilMantle.timedJob(player, level, Vec3.atCenterOf(door.above()), 6, 16, 2, ItemStack.EMPTY) == null) {
            TendrilFxEntity.spawnGrabAtPoint(level, player, Vec3.atCenterOf(door.above()), 24, p.strain);
         }

         if (TendrilMantle.timedJob(player, level, Vec3.atCenterOf(door), 6, 16, 2, ItemStack.EMPTY) == null) {
            TendrilFxEntity.spawnGrabAtPoint(level, player, Vec3.atCenterOf(door), 24, p.strain);
         }

         VoiceLines.send(player, "symbiote.voice.door_rip", 3);
         SymbioteLog.event("WALK_SEIZURE_DOOR_RIP player={} door={}", player.getUUID(), door);
         return true;
      } else {
         BlockPos entrance = findClosedWoodenDoor(player, level, s, 16.0, false);
         if (entrance == null) {
            SymbioteLog.event("WALK_SEIZURE_DOOR_SEEK_NONE player={} radius={}", player.getUUID(), 16);
            return false;
         } else if (++s.doorSeeks > 2) {
            return false;
         } else {
            List<BlockPos> toDoor = pathToDoorstep(player, level, entrance);
            if (toDoor != null && !toDoor.isEmpty()) {
               s.nodes = toDoor;
               s.nodeIdx = 0;
               s.stallTicks = 0;
               s.repaths = 0;
               SymbioteLog.event("WALK_SEIZURE_DOOR_SEEK player={} door={} nodes={}", player.getUUID(), entrance, toDoor.size());
               return true;
            } else {
               SymbioteLog.event("WALK_SEIZURE_DOOR_SEEK_NOPATH player={} door={}", player.getUUID(), entrance);
               return false;
            }
         }
      }
   }

   private static List<BlockPos> pathToDoorstep(ServerPlayer player, ServerLevel level, BlockPos door) {
      BlockState st = level.getBlockState(door);
      List<BlockPos> path = null;
      if (st.getBlock() instanceof DoorBlock) {
         Direction facing = (Direction)st.getValue(DoorBlock.FACING);
         BlockPos a = door.relative(facing);
         BlockPos b = door.relative(facing.getOpposite());
         BlockPos near = player.distanceToSqr(Vec3.atCenterOf(a)) <= player.distanceToSqr(Vec3.atCenterOf(b)) ? a : b;
         path = computePath(player, level, near);
      }

      if (path == null || path.isEmpty()) {
         path = computePath(player, level, door);
      }

      return path;
   }

   private static void tearDoor(ServerPlayer player, ServerLevel level, WalkSeizure.Session s) {
      BlockPos door = s.ripDoor;
      s.ripDoor = null;
      if (level.getBlockState(door).getBlock() instanceof DoorBlock) {
         level.destroyBlock(door, true, player);
      }

      level.playSound(null, door, (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 0.9F, 0.85F);
      SymbioteLog.event("WALK_SEIZURE_DOOR_TORN player={} door={}", player.getUUID(), door);
   }

   private static BlockPos findClosedWoodenDoor(ServerPlayer player, ServerLevel level, WalkSeizure.Session s, double radius, boolean requireToward) {
      BlockPos base = player.blockPosition();
      double tx = s.target.getX() + 0.5 - player.getX();
      double tz = s.target.getZ() + 0.5 - player.getZ();
      int r = (int)Math.ceil(radius);
      BlockPos best = null;
      double bestSq = Double.MAX_VALUE;

      for (BlockPos pos : BlockPos.betweenClosed(base.offset(-r, -2, -r), base.offset(r, 3, r))) {
         BlockState state = level.getBlockState(pos);
         if (state.getBlock() instanceof DoorBlock && state.is(BlockTags.WOODEN_DOORS) && !(Boolean)state.getValue(DoorBlock.OPEN)) {
            BlockPos lower = state.getValue(DoorBlock.HALF) == DoubleBlockHalf.UPPER ? pos.below() : pos;
            if (!s.rippedDoors.contains(lower)) {
               double dx = lower.getX() + 0.5 - player.getX();
               double dz = lower.getZ() + 0.5 - player.getZ();
               double distSq = dx * dx + dz * dz;
               if (!(distSq > radius * radius) && (!requireToward || !(dx * tx + dz * tz < 0.0)) && distSq < bestSq) {
                  bestSq = distSq;
                  best = lower.immutable();
               }
            }
         }
      }

      return best;
   }

   private static boolean repath(ServerPlayer player, ServerLevel level, WalkSeizure.Session s) {
      if (++s.repaths > 3) {
         return false;
      } else {
         List<BlockPos> fresh = computePath(player, level, s.target);
         if (fresh != null && !fresh.isEmpty()) {
            s.nodes = fresh;
            s.nodeIdx = 0;
            SymbioteLog.event("WALK_SEIZURE_REPATH player={} attempt={} nodes={}", player.getUUID(), s.repaths, fresh.size());
            return true;
         } else {
            return false;
         }
      }
   }

   private static boolean targetObstructed(ServerPlayer player, ServerLevel level, BlockPos target) {
      Vec3 eye = player.getEyePosition();
      Vec3 to = Vec3.atCenterOf(target);
      BlockHitResult hit = level.clip(new ClipContext(eye, to, Block.COLLIDER, Fluid.NONE, player));
      return hit.getType() == Type.MISS ? false : !hit.getBlockPos().equals(target) && !hit.getBlockPos().equals(target.above());
   }

   private static double horizDistSq(ServerPlayer player, BlockPos pos) {
      double dx = pos.getX() + 0.5 - player.getX();
      double dz = pos.getZ() + 0.5 - player.getZ();
      return dx * dx + dz * dz;
   }

   private static void release(ServerPlayer player, ServerLevel level, SymbioteProfile p, boolean sated, String reason) {
      WalkSeizure.Session s = ACTIVE.remove(player.getUUID());
      boolean quiet = s != null && s.quiet;
      ATTACKED.remove(player.getUUID());
      player.setSprinting(false);
      ModNetwork.sendBodySeized(player, false, false);
      if (sated) {
         if (!quiet) {
            SymbioteTracker.adjustStress(level, player, -8, "stress_seizure_sated");
            VoiceLines.send(player, "symbiote.voice.desire_sated", 3);
         }
      } else if (!quiet && !"host_attacked".equals(reason) && !"fire_panic".equals(reason) && !"drowning".equals(reason)) {
         VoiceLines.send(player, "symbiote.voice.seizure_release", 4);
      }

      SymbioteLog.event("WALK_SEIZURE_END player={} sated={} reason={}", player.getUUID(), sated, reason);
   }

   public static void tickCleanup(ServerLevel level) {
      Iterator<Entry<UUID, WalkSeizure.Session>> it = ACTIVE.entrySet().iterator();

      while (it.hasNext()) {
         Entry<UUID, WalkSeizure.Session> e = it.next();
         ServerPlayer pl = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (pl == null || !pl.isAlive()) {
            it.remove();
         }
      }
   }

   public static BlockPos findOpenSkySpot(ServerPlayer player, ServerLevel level, int radius) {
      BlockPos origin = player.blockPosition();

      for (int r = 6; r <= radius; r += 4) {
         for (int i = 0; i < 12; i++) {
            double a = (Math.PI * 2) * i / 12.0;
            int x = origin.getX() + (int)Math.round(Math.cos(a) * r);
            int z = origin.getZ() + (int)Math.round(Math.sin(a) * r);
            int y = level.getHeight(Types.MOTION_BLOCKING, x, z);
            if (Math.abs(y - origin.getY()) <= 10) {
               BlockPos pos = new BlockPos(x, y, z);
               if (level.canSeeSky(pos)) {
                  return pos;
               }
            }
         }
      }

      return null;
   }

   private WalkSeizure() {
   }

   private static final class Session {
      final BlockPos target;
      final boolean quiet;
      List<BlockPos> nodes;
      int nodeIdx = 0;
      int age = 0;
      int repaths = 0;
      int stallTicks = 0;
      double lastX;
      double lastZ;
      BlockPos ripDoor = null;
      int ripTearAge = 0;
      int doorSeeks = 0;
      int terrainBites = 0;
      final Set<BlockPos> rippedDoors = new HashSet<>();

      Session(BlockPos target, List<BlockPos> nodes, ServerPlayer player, boolean quiet) {
         this.target = target;
         this.nodes = nodes;
         this.quiet = quiet;
         this.lastX = player.getX();
         this.lastZ = player.getZ();
      }
   }
}
