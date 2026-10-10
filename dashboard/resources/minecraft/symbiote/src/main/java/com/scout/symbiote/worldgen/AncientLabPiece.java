package com.scout.symbiote.worldgen;

import com.scout.symbiote.block.DormantSampleBlock;
import com.scout.symbiote.entity.InfectedZombieEntity;
import com.scout.symbiote.registry.ModBlocks;
import com.scout.symbiote.registry.ModEntities;
import com.scout.symbiote.registry.ModStructures;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.StructureManager;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.ChunkGenerator;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.ScatteredFeaturePiece;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceType;
import net.minecraft.world.level.storage.loot.BuiltInLootTables;

public class AncientLabPiece extends ScatteredFeaturePiece {
   private static final int WIDTH = 9;
   private static final int HEIGHT = 6;
   private static final int DEPTH = 9;

   public AncientLabPiece(RandomSource random, int x, int y, int z) {
      super((StructurePieceType)ModStructures.ANCIENT_LAB_PIECE.get(), x, y, z, 9, 6, 9, getRandomHorizontalDirection(random));
   }

   public AncientLabPiece(CompoundTag tag) {
      super((StructurePieceType)ModStructures.ANCIENT_LAB_PIECE.get(), tag);
   }

   public void postProcess(
      WorldGenLevel level, StructureManager structureManager, ChunkGenerator generator, RandomSource random, BoundingBox box, ChunkPos chunkPos, BlockPos pos
   ) {
      BlockState bricks = Blocks.DEEPSLATE_BRICKS.defaultBlockState();
      BlockState crackedBricks = Blocks.CRACKED_DEEPSLATE_BRICKS.defaultBlockState();
      BlockState tiles = Blocks.DEEPSLATE_TILES.defaultBlockState();
      BlockState air = Blocks.CAVE_AIR.defaultBlockState();
      this.generateBox(level, box, 0, 0, 0, 8, 5, 8, bricks, air, false);
      this.generateBox(level, box, 1, 0, 1, 7, 0, 7, tiles, tiles, false);

      for (int i = 0; i < 14; i++) {
         int wx = random.nextInt(9);
         int wy = 1 + random.nextInt(4);
         int wz = wx != 0 && wx != 8 ? (random.nextBoolean() ? 0 : 8) : random.nextInt(9);
         this.placeBlock(level, crackedBricks, wx, wy, wz, box);
      }

      for (int y = 1; y <= 3; y++) {
         this.placeBlock(level, Blocks.POLISHED_DEEPSLATE.defaultBlockState(), 1, y, 1, box);
         this.placeBlock(level, Blocks.POLISHED_DEEPSLATE.defaultBlockState(), 1, y, 7, box);
         this.placeBlock(level, Blocks.POLISHED_DEEPSLATE.defaultBlockState(), 7, y, 1, box);
         this.placeBlock(level, Blocks.POLISHED_DEEPSLATE.defaultBlockState(), 7, y, 7, box);
      }

      SymbioteStrain[] strains = SymbioteStrain.values();
      BlockState sampleA = (BlockState)((DormantSampleBlock)ModBlocks.DORMANT_SAMPLE.get())
         .defaultBlockState()
         .setValue(DormantSampleBlock.STRAIN, strains[random.nextInt(strains.length)]);
      BlockState sampleB = (BlockState)((DormantSampleBlock)ModBlocks.DORMANT_SAMPLE.get())
         .defaultBlockState()
         .setValue(DormantSampleBlock.STRAIN, strains[random.nextInt(strains.length)]);
      boolean secondZombie = random.nextBoolean();
      this.placeBlock(level, Blocks.CRYING_OBSIDIAN.defaultBlockState(), 4, 1, 4, box);
      this.placeBlock(level, sampleA, 2, 1, 2, box);
      this.placeBlock(level, sampleB, 6, 1, 6, box);
      this.placeBlock(level, (BlockState)Blocks.SOUL_LANTERN.defaultBlockState().setValue(LanternBlock.HANGING, Boolean.TRUE), 4, 4, 4, box);
      this.createChest(level, box, random, 6, 1, 2, BuiltInLootTables.SIMPLE_DUNGEON);
      this.spawnInfectedZombie(level, box, 2, 1, 6);
      if (secondZombie) {
         this.spawnInfectedZombie(level, box, 5, 1, 3);
      }

      BlockPos chamber = new BlockPos(this.getWorldX(4, 4), this.getWorldY(1), this.getWorldZ(4, 4));
      if (box.isInside(chamber)) {
         SymbioteLog.event(
            "ANCIENT_LAB_GENERATED chamber=({},{},{}) zombies={} chunk=({},{})",
            chamber.getX(),
            chamber.getY(),
            chamber.getZ(),
            secondZombie ? 2 : 1,
            chamber.getX() >> 4,
            chamber.getZ() >> 4
         );
      }
   }

   private void spawnInfectedZombie(WorldGenLevel level, BoundingBox box, int x, int y, int z) {
      BlockPos spawn = new BlockPos(this.getWorldX(x, z), this.getWorldY(y), this.getWorldZ(x, z));
      if (box.isInside(spawn)) {
         InfectedZombieEntity zombie = ModEntities.INFECTED_ZOMBIE.get().create(level.getLevel(), EntitySpawnReason.STRUCTURE);
         if (zombie != null) {
            zombie.moveTo(spawn.getX() + 0.5, spawn.getY(), spawn.getZ() + 0.5);
            zombie.finalizeSpawn(level, level.getCurrentDifficultyAt(spawn), EntitySpawnReason.STRUCTURE, null);
            zombie.setPersistenceRequired();
            level.addFreshEntity(zombie);
         }
      }
   }
}
