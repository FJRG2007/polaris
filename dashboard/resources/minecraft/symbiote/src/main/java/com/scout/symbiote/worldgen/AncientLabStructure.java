package com.scout.symbiote.worldgen;

import com.mojang.serialization.Codec;
import com.scout.symbiote.registry.ModStructures;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureType;
import net.minecraft.world.level.levelgen.structure.Structure.GenerationContext;
import net.minecraft.world.level.levelgen.structure.Structure.GenerationStub;
import net.minecraft.world.level.levelgen.structure.Structure.StructureSettings;

public class AncientLabStructure extends Structure {
   public static final com.mojang.serialization.MapCodec<AncientLabStructure> CODEC = simpleCodec(AncientLabStructure::new);

   public AncientLabStructure(StructureSettings settings) {
      super(settings);
   }

   public Optional<GenerationStub> findGenerationPoint(GenerationContext context) {
      ChunkPos chunkPos = context.chunkPos();
      int centerX = chunkPos.getMiddleBlockX();
      int centerZ = chunkPos.getMiddleBlockZ();
      int floorY = context.chunkGenerator().getFirstOccupiedHeight(centerX, centerZ, Types.OCEAN_FLOOR_WG, context.heightAccessor(), context.randomState());
      int baseY = floorY - 8 - context.random().nextInt(5);
      if (baseY <= context.heightAccessor().getMinY() + 6) {
         return Optional.empty();
      }

      BlockPos origin = new BlockPos(centerX - 4, baseY, centerZ - 4);
      return Optional.of(
         new GenerationStub(
            origin, builder -> builder.addPiece(new AncientLabPiece(context.random(), origin.getX(), origin.getY(), origin.getZ()))
         )
      );
   }

   public StructureType<?> type() {
      return (StructureType<?>)ModStructures.ANCIENT_LAB.get();
   }
}
