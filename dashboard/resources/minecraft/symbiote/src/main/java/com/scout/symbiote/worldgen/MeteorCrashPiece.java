package com.scout.symbiote.worldgen;

import com.scout.symbiote.registry.ModStructures;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.StructureManager;
import net.minecraft.world.level.WorldGenLevel;
import net.minecraft.world.level.chunk.ChunkGenerator;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.StructurePiece;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceSerializationContext;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceType;

public class MeteorCrashPiece extends StructurePiece {
   private static final int RADIUS_XZ = 8;
   private static final int RADIUS_Y = 8;
   private final BlockPos center;

   public MeteorCrashPiece(BlockPos center) {
      super(
         (StructurePieceType)ModStructures.METEOR_CRASH_PIECE.get(),
         0,
         new BoundingBox(
            center.getX() - 8, center.getY() - 8, center.getZ() - 8, center.getX() + 8, center.getY() + 8, center.getZ() + 8
         )
      );
      this.center = center;
   }

   public MeteorCrashPiece(CompoundTag tag) {
      super((StructurePieceType)ModStructures.METEOR_CRASH_PIECE.get(), tag);
      this.center = new BlockPos(tag.getInt("CX"), tag.getInt("CY"), tag.getInt("CZ"));
   }

   protected void addAdditionalSaveData(StructurePieceSerializationContext context, CompoundTag tag) {
      tag.putInt("CX", this.center.getX());
      tag.putInt("CY", this.center.getY());
      tag.putInt("CZ", this.center.getZ());
   }

   public void postProcess(
      WorldGenLevel level, StructureManager structureManager, ChunkGenerator generator, RandomSource random, BoundingBox box, ChunkPos chunkPos, BlockPos pos
   ) {
      MeteorCrashGenerator.buildCrater(level, this.center, Types.WORLD_SURFACE_WG, box);
   }
}
