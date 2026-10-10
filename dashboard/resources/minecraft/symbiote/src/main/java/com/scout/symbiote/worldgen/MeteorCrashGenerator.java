package com.scout.symbiote.worldgen;

import com.scout.symbiote.block.DormantSampleBlock;
import com.scout.symbiote.registry.ModBlocks;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.Arrays;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplateManager;

public final class MeteorCrashGenerator {
   private static final ResourceLocation SITE_TEMPLATE = ResourceLocation.fromNamespaceAndPath("symbiote", "meteor_site");
   private static final BlockPos SAMPLE_REL = new BlockPos(5, 2, 5);
   private static final BlockPos PIVOT = new BlockPos(6, 0, 5);
   private static final int SEAT_DEPTH = 5;

   private MeteorCrashGenerator() {
   }

   public static void place(ServerLevel level, BlockPos center) {
      int y = level.getHeight(Types.MOTION_BLOCKING_NO_LEAVES, center.getX(), center.getZ());
      buildCrater(level, new BlockPos(center.getX(), y, center.getZ()), null, null);
   }

   public static void buildCrater(WorldGenLevel level, BlockPos center, Types ignoredHeightmap, BoundingBox clip) {
      if (clip != null) {
         int[] hs = new int[]{
            level.getHeight(Types.WORLD_SURFACE_WG, center.getX() + 10, center.getZ()),
            level.getHeight(Types.WORLD_SURFACE_WG, center.getX() - 10, center.getZ()),
            level.getHeight(Types.WORLD_SURFACE_WG, center.getX(), center.getZ() + 10)
         };
         Arrays.sort(hs);
         int median = hs[1];
         if (Math.abs(median - center.getY()) > 5) {
            SymbioteLog.event("METEOR_REBASED x={} z={} old_y={} new_y={}", center.getX(), center.getZ(), center.getY(), median);
            center = new BlockPos(center.getX(), median, center.getZ());
         }
      }

      RandomSource random = RandomSource.create(level.getSeed() ^ center.asLong());
      SymbioteStrain[] strains = SymbioteStrain.values();
      SymbioteStrain strain = strains[random.nextInt(strains.length)];
      Rotation rotation = Rotation.getRandom(random);
      StructureTemplateManager mgr = level.getLevel().getServer().getStructureManager();
      StructureTemplate template = mgr.getOrCreate(SITE_TEMPLATE);
      BlockPos origin = new BlockPos(center.getX() - PIVOT.getX(), center.getY() - 5, center.getZ() - PIVOT.getZ());
      StructurePlaceSettings settings = new StructurePlaceSettings().setRotation(rotation).setMirror(Mirror.NONE).setRotationPivot(PIVOT).setKnownShape(true);
      if (clip != null) {
         settings.setBoundingBox(clip);
      }

      template.placeInWorld(level, origin, origin, settings, random, 2);
      int grade = center.getY();

      for (int dx = -8; dx <= 8; dx++) {
         for (int dz = -8; dz <= 8; dz++) {
            if (dx * dx + dz * dz <= 72) {
               for (int dy = 1; dy <= 4; dy++) {
                  BlockPos sp = new BlockPos(center.getX() + dx, grade + dy, center.getZ() + dz);
                  if (clip == null || clip.isInside(sp)) {
                     BlockState st = level.getBlockState(sp);
                     if (!st.isAir() && !st.is(Blocks.FIRE)) {
                        level.setBlock(sp, Blocks.AIR.defaultBlockState(), 2);
                     }
                  }
               }

               int x = center.getX() + dx;
               int z = center.getZ() + dz;
               int bottom = Integer.MIN_VALUE;

               for (int y = grade - 5; y <= grade; y++) {
                  if (!level.getBlockState(new BlockPos(x, y, z)).isAir()) {
                     bottom = y;
                     break;
                  }
               }

               if (bottom != Integer.MIN_VALUE) {
                  BlockPos underFirst = new BlockPos(x, bottom - 1, z);
                  if (level.getBlockState(underFirst).isAir()) {
                     int groundY = Integer.MIN_VALUE;

                     for (int y = bottom - 2; y >= bottom - 7; y--) {
                        if (!level.getBlockState(new BlockPos(x, y, z)).isAir()) {
                           groundY = y;
                           break;
                        }
                     }

                     if (groundY != Integer.MIN_VALUE) {
                        BlockState legMat = level.getBlockState(new BlockPos(x, groundY, z));

                        for (int y = groundY + 1; y < bottom; y++) {
                           BlockPos fp = new BlockPos(x, y, z);
                           if (clip == null || clip.isInside(fp)) {
                              level.setBlock(fp, legMat, 2);
                           }
                        }
                     }
                  }
               }
            }
         }
      }

      BlockPos sampleWorld = origin.offset(StructureTemplate.transform(SAMPLE_REL, Mirror.NONE, rotation, PIVOT));
      if (clip == null || clip.isInside(sampleWorld)) {
         level.setBlock(sampleWorld, (BlockState)((DormantSampleBlock)ModBlocks.DORMANT_SAMPLE.get()).defaultBlockState().setValue(DormantSampleBlock.STRAIN, strain), 2);
         level.scheduleTick(sampleWorld, (Block)ModBlocks.DORMANT_SAMPLE.get(), 10);
         SymbioteLog.event(
            "METEOR_GENERATED center=({},{},{}) sample=({},{},{}) strain={} rot={} chunk=({},{})",
            center.getX(),
            center.getY(),
            center.getZ(),
            sampleWorld.getX(),
            sampleWorld.getY(),
            sampleWorld.getZ(),
            strain,
            rotation,
            sampleWorld.getX() >> 4,
            sampleWorld.getZ() >> 4
         );
      }
   }
}
