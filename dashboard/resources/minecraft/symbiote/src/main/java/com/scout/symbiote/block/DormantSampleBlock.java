package com.scout.symbiote.block;

import com.scout.symbiote.ability.GraftFlow;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.registry.ModBlocks;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.core.BlockPos.MutableBlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.BlockBehaviour.Properties;
import net.minecraft.world.level.block.state.StateDefinition.Builder;
import net.minecraft.world.level.block.state.properties.EnumProperty;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

public class DormantSampleBlock extends Block implements EntityBlock {
   public static final EnumProperty<SymbioteStrain> STRAIN = EnumProperty.create("strain", SymbioteStrain.class);
   private static final double TRIGGER_RANGE = 4.0;
   private static final Set<Long> BURIED_LOGGED = new HashSet<>();
   private static final int POLL_INTERVAL = 10;
   private static final VoxelShape SHAPE = Block.box(1.5, 0.0, 1.5, 14.5, 9.0, 14.5);
   private static final Map<ServerLevel, Map<Long, int[]>> PERMANENT_LOOPS = new WeakHashMap<>();
   private static final int ENTITY_LIFE_SAMPLE_LIMIT = 8;
   private static final int PERMANENT_LIFETIME = 2400;

   public DormantSampleBlock(Properties props) {
      super(props.noOcclusion().noLootTable().strength(1.5F).randomTicks().lightLevel(state -> 4));
      this.registerDefaultState((BlockState)((BlockState)this.stateDefinition.any()).setValue(STRAIN, SymbioteStrain.GUARDIAN));
   }

   public BlockEntity newBlockEntity(BlockPos pos, BlockState state) {
      return new DormantSampleBlock.Entity(pos, state);
   }

   protected void createBlockStateDefinition(Builder<Block, BlockState> builder) {
      builder.add(new Property[]{STRAIN});
   }

   public void onPlace(BlockState state, Level level, BlockPos pos, BlockState oldState, boolean isMoving) {
      super.onPlace(state, level, pos, oldState, isMoving);
      if (level instanceof ServerLevel sl) {
         sl.scheduleTick(pos, this, 10);
      }
   }

   public void randomTick(BlockState state, ServerLevel level, BlockPos pos, RandomSource random) {
      level.scheduleTick(pos, this, 1);
   }

   public void tick(BlockState state, ServerLevel level, BlockPos pos, RandomSource random) {
      super.tick(state, level, pos, random);
      if (BURIED_LOGGED.add(pos.asLong())) {
         int surface = level.getHeight(Types.MOTION_BLOCKING, pos.getX(), pos.getZ());
         if (surface > pos.getY() + 7) {
            SymbioteLog.event(
               "METEOR_SAMPLE_BURIED pos=({},{},{}) surface_y={} depth={}",
               pos.getX(),
               pos.getY(),
               pos.getZ(),
               surface,
               surface - pos.getY()
            );
         }

         MutableBlockPos m = new MutableBlockPos();

         for (int dx = -8; dx <= 8; dx++) {
            for (int dz = -8; dz <= 8; dz++) {
               if (dx * dx + dz * dz <= 72) {
                  for (int dy = 2; dy <= 8; dy++) {
                     m.set(pos.getX() + dx, pos.getY() + dy, pos.getZ() + dz);
                     BlockState st = level.getBlockState(m);
                     if (!st.isAir() && st.canBeReplaced() && level.getBlockState(m.below()).isAir()) {
                        level.setBlock(m, Blocks.AIR.defaultBlockState(), 2);
                     }
                  }
               }
            }
         }
      }

      if (TendrilSceneController.isSampleClaimed(pos)) {
         level.scheduleTick(pos, this, 10);
      } else {
         boolean hasEntityLife = ensurePermanentLoops(level, pos, state);
         if (hasEntityLife && random.nextInt(10) == 0) {
            double yaw = random.nextDouble() * Math.PI * 2.0;
            double reach = 1.2 + random.nextDouble() * 1.2;
            Vec3 origin = new Vec3(pos.getX() + 0.5, pos.getY() + 0.45, pos.getZ() + 0.5);
            double tx = origin.x + Math.cos(yaw) * reach;
            double tz = origin.z + Math.sin(yaw) * reach;
            double ty = pos.getY() + 0.1 + random.nextDouble() * 0.5;
            Vec3 tip = null;

            for (int dy = 0; dy <= 3 && tip == null; dy++) {
               Vec3 candidate = new Vec3(tx, ty + dy, tz);
               boolean clear = true;

               for (double t = 0.35; t <= 1.0; t += 0.325) {
                  Vec3 point = new Vec3(
                     origin.x + (candidate.x - origin.x) * t,
                     origin.y + (candidate.y - origin.y) * t,
                     origin.z + (candidate.z - origin.z) * t
                  );
                  if (!level.getBlockState(BlockPos.containing(point)).isAir()) {
                     clear = false;
                     break;
                  }
               }

               if (clear) {
                  tip = candidate;
               }
            }

            if (tip != null) {
               TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(
                  level,
                  origin,
                  tip,
                  70,
                  (SymbioteStrain)state.getValue(STRAIN),
                  0.45F + random.nextFloat() * 0.3F,
                  (float)(random.nextDouble() * Math.PI * 2.0)
               );
               fx.scheduleRetract(45);
            }
         }

         ServerPlayer target = findNearestUnbondedPlayer(level, pos);
         if (target == null) {
            ServerPlayer bonded = findNearestBondedPlayer(level, pos);
            if (bonded != null && !TendrilSceneController.isInScene(bonded.getUUID())) {
               triggerGraft(bonded, level, pos, (SymbioteStrain)state.getValue(STRAIN));
            } else {
               level.scheduleTick(pos, this, 10);
            }
         } else if (TendrilSceneController.isInScene(target.getUUID())) {
            level.scheduleTick(pos, this, 10);
         } else {
            this.triggerRitual(target, level, pos, (SymbioteStrain)state.getValue(STRAIN));
         }
      }
   }

   public VoxelShape getShape(BlockState state, BlockGetter getter, BlockPos pos, CollisionContext ctx) {
      return SHAPE;
   }

   public VoxelShape getCollisionShape(BlockState state, BlockGetter getter, BlockPos pos, CollisionContext ctx) {
      return SHAPE;
   }

   @Override
   protected InteractionResult useWithoutItem(BlockState state, Level level, BlockPos pos, Player player, BlockHitResult hit) {
      if (level.isClientSide) {
         return InteractionResult.SUCCESS;
      }

      if (player instanceof ServerPlayer sp) {
         if (level instanceof ServerLevel sl) {
            SymbioteProfile profile = SymbioteTracker.get(sl).peek(sp.getUUID());
            if (profile != null && profile.stage.isBonded()) {
               return InteractionResult.PASS;
            }

            if (TendrilSceneController.isInScene(sp.getUUID())) {
               return InteractionResult.PASS;
            }

            if (TendrilSceneController.isSampleClaimed(pos)) {
               return InteractionResult.PASS;
            }

            this.triggerRitual(sp, sl, pos, (SymbioteStrain)state.getValue(STRAIN));
            return InteractionResult.CONSUME;
         } else {
            return InteractionResult.PASS;
         }
      } else {
         return InteractionResult.PASS;
      }
   }

   private void triggerRitual(ServerPlayer player, ServerLevel level, BlockPos pos, SymbioteStrain strain) {
      Vec3 samplePos = new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
      level.playSound(null, pos, SoundEvents.SLIME_BLOCK_BREAK, SoundSource.BLOCKS, 1.0F, 0.6F);
      SymbioteLog.event(
         "DORMANT_SAMPLE_TRIGGERED player={} strain={} pos=({},{},{}) trigger=proximity_or_use",
         player.getUUID(),
         strain,
         pos.getX(),
         pos.getY(),
         pos.getZ()
      );
      TendrilSceneController.startBondingRitual(player, level, samplePos, strain);
   }

   private static void triggerGraft(ServerPlayer player, ServerLevel level, BlockPos pos, SymbioteStrain sampleStrain) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      GraftFlow.Eligibility e = GraftFlow.check(p);
      Vec3 samplePos = new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
      switch (e) {
         case CAN_GRAFT:
            SymbioteLog.event("GRAFT_APPROACH player={} sample={} strain={}", player.getUUID(), pos, sampleStrain);
            TendrilSceneController.startGraftRitual(player, level, samplePos, p.strain, sampleStrain);
            break;
         case REFUSED_TOO_DEEP:
            SymbioteLog.event("GRAFT_REFUSED player={} stage={} sample={}", player.getUUID(), p.stage, pos);
            TendrilSceneController.startGraftRefused(player, level, samplePos, p.strain);
            break;
         default:
            level.scheduleTick(pos, this_(), 10);
      }
   }

   private static DormantSampleBlock this_() {
      return (DormantSampleBlock)ModBlocks.DORMANT_SAMPLE.get();
   }

   private static ServerPlayer findNearestBondedPlayer(ServerLevel level, BlockPos pos) {
      double cx = pos.getX() + 0.5;
      double cy = pos.getY() + 0.5;
      double cz = pos.getZ() + 0.5;
      double rSq = 16.0;
      AABB box = new AABB(pos).inflate(4.0);
      ServerPlayer best = null;
      double bestSq = Double.MAX_VALUE;

      for (ServerPlayer p : level.getEntitiesOfClass(ServerPlayer.class, box, pl -> pl.isAlive() && pl.distanceToSqr(cx, cy, cz) <= rSq)) {
         SymbioteProfile prof = SymbioteTracker.get(level).peek(p.getUUID());
         if (prof != null && prof.stage.isBonded() && prof.graft == null && canSeeSample(level, p, pos, cx, cy, cz)) {
            double d = p.distanceToSqr(cx, cy, cz);
            if (d < bestSq) {
               bestSq = d;
               best = p;
            }
         }
      }

      return best;
   }

   public static boolean ensurePermanentLoops(ServerLevel level, BlockPos pos, BlockState state) {
      Map<Long, int[]> levelLoops = PERMANENT_LOOPS.computeIfAbsent(level, ignored -> new HashMap<>());
      long key = pos.asLong();
      int[] ids = levelLoops.get(key);
      if (ids == null || !hasLiveLoop(level, ids)) {
         int activeOwners = 0;

         for (Entry<Long, int[]> entry : levelLoops.entrySet()) {
            if (entry.getKey() != key && hasLiveLoop(level, entry.getValue())) {
               activeOwners++;
            }
         }

         if (activeOwners >= 8) {
            return false;
         }

         if (ids == null) {
            ids = new int[]{-1, -1, -1};
            levelLoops.put(key, ids);
         }
      }

      RandomSource seeded = RandomSource.create(pos.asLong() * 31L);

      for (int i = 0; i < 3; i++) {
         double yaw = seeded.nextDouble() * Math.PI * 2.0 + i * (Math.PI * 2.0 / 3.0);
         double span = 0.9 + seeded.nextDouble() * 0.5;
         float arcAmp = 1.0F + seeded.nextFloat() * 0.3F;
         float arcAngle = (float)(seeded.nextDouble() * 0.8 - 0.4);
         if (ids[i] < 0 || !(level.getEntity(ids[i]) instanceof TendrilFxEntity t) || !t.isAlive()) {
            Vec3 center = new Vec3(pos.getX() + 0.5, pos.getY() + 0.35, pos.getZ() + 0.5);
            Vec3 origin = center.add(Math.cos(yaw) * 0.35, 0.2, Math.sin(yaw) * 0.35);
            Vec3 tip = center.add(Math.cos(yaw + 1.0) * 0.45, -0.15, Math.sin(yaw + 1.0) * 0.45);
            TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(level, origin, tip, 2400, (SymbioteStrain)state.getValue(STRAIN), arcAmp, arcAngle);
            fx.setReachTicksOverride(14);
            ids[i] = fx.getId();
            return true;
         }
      }

      return true;
   }

   private static boolean hasLiveLoop(ServerLevel level, int[] ids) {
      for (int id : ids) {
         if (id >= 0 && level.getEntity(id) instanceof TendrilFxEntity t && t.isAlive()) {
            return true;
         }
      }

      return false;
   }

   public void onRemove(BlockState state, Level level, BlockPos pos, BlockState newState, boolean isMoving) {
      if (!level.isClientSide && !state.is(newState.getBlock()) && level instanceof ServerLevel sl) {
         releasePermanentLoops(sl, pos);
      }

      super.onRemove(state, level, pos, newState, isMoving);
   }

   public static void releasePermanentLoops(ServerLevel sl, BlockPos pos) {
      Map<Long, int[]> levelLoops = PERMANENT_LOOPS.get(sl);
      int[] ids = levelLoops == null ? null : levelLoops.remove(pos.asLong());
      if (levelLoops != null && levelLoops.isEmpty()) {
         PERMANENT_LOOPS.remove(sl);
      }

      if (ids != null) {
         for (int id : ids) {
            if (id >= 0 && sl.getEntity(id) instanceof TendrilFxEntity t && t.isAlive()) {
               t.scheduleRetract(t.tickCount);
               t.setLifetime(t.tickCount + 40);
            }
         }
      }
   }

   private static ServerPlayer findNearestUnbondedPlayer(ServerLevel level, BlockPos pos) {
      double cx = pos.getX() + 0.5;
      double cy = pos.getY() + 0.5;
      double cz = pos.getZ() + 0.5;
      double rSq = 16.0;
      AABB box = new AABB(pos).inflate(4.0);
      List<ServerPlayer> candidates = level.getEntitiesOfClass(ServerPlayer.class, box, px -> px.isAlive() && px.distanceToSqr(cx, cy, cz) <= rSq);
      ServerPlayer best = null;
      double bestSq = Double.MAX_VALUE;

      for (ServerPlayer p : candidates) {
         SymbioteProfile profile = SymbioteTracker.get(level).peek(p.getUUID());
         if ((profile == null || !profile.stage.isBonded()) && canSeeSample(level, p, pos, cx, cy, cz)) {
            double d = p.distanceToSqr(cx, cy, cz);
            if (d < bestSq) {
               bestSq = d;
               best = p;
            }
         }
      }

      return best;
   }

   public static boolean canSeeSample(ServerLevel level, ServerPlayer p, BlockPos pos, double cx, double cy, double cz) {
      BlockHitResult hit = level.clip(
         new ClipContext(p.getEyePosition(), new Vec3(cx, cy, cz), net.minecraft.world.level.ClipContext.Block.COLLIDER, Fluid.NONE, p)
      );
      return hit.getType() == Type.MISS || hit.getBlockPos().equals(pos);
   }

   public static class Entity extends BlockEntity {
      public static BlockEntityType<DormantSampleBlock.Entity> TYPE;

      public Entity(BlockPos pos, BlockState state) {
         super(TYPE, pos, state);
      }
   }
}
