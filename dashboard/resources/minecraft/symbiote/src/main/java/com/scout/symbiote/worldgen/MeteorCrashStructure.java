package com.scout.symbiote.worldgen;

import com.mojang.serialization.Codec;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.registry.ModStructures;
import com.scout.symbiote.util.SymbioteLog;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.levelgen.Heightmap.Types;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureType;
import net.minecraft.world.level.levelgen.structure.Structure.GenerationContext;
import net.minecraft.world.level.levelgen.structure.Structure.GenerationStub;
import net.minecraft.world.level.levelgen.structure.Structure.StructureSettings;

public class MeteorCrashStructure extends Structure {
   public static final com.mojang.serialization.MapCodec<MeteorCrashStructure> CODEC = simpleCodec(MeteorCrashStructure::new);
   private static final int FOOT = 7;
   private static final int MAX_UNEVENNESS = 4;

   public MeteorCrashStructure(StructureSettings settings) {
      super(settings);
   }

   public Optional<GenerationStub> findGenerationPoint(GenerationContext context) {
      ChunkPos chunkPos = context.chunkPos();
      int rarity = (Integer)SymbioteConfig.CRATER_RARITY.get();
      if (rarity > 1) {
         long h = chunkPos.toLong() * -7046029254386353131L ^ context.seed();
         h ^= h >>> 31;
         if (Math.floorMod(h, rarity) != 0) {
            return Optional.empty();
         }
      }

      int cx = chunkPos.getMiddleBlockX();
      int cz = chunkPos.getMiddleBlockZ();
      int[][] candidates = new int[][]{{0, 0}, {-12, -12}, {-12, 12}, {12, -12}, {12, 12}};
      String lastReject = "no_candidate_seated";

      for (int[] cand : candidates) {
         int x = cx + cand[0];
         int z = cz + cand[1];
         int minY = Integer.MAX_VALUE;
         int maxY = Integer.MIN_VALUE;
         int drySum = 0;
         int dryCount = 0;
         int wetCount = 0;
         boolean centerWet = false;

         for (int px = -7; px <= 7; px += 7) {
            for (int pz = -7; pz <= 7; pz += 7) {
               int wx = x + px;
               int wz = z + pz;
               int surfaceY = context.chunkGenerator().getFirstOccupiedHeight(wx, wz, Types.WORLD_SURFACE_WG, context.heightAccessor(), context.randomState());
               int floorY = context.chunkGenerator().getFirstOccupiedHeight(wx, wz, Types.OCEAN_FLOOR_WG, context.heightAccessor(), context.randomState());
               if (surfaceY != floorY) {
                  wetCount++;
                  if (px == 0 && pz == 0) {
                     centerWet = true;
                  }
               } else {
                  minY = Math.min(minY, surfaceY);
                  maxY = Math.max(maxY, surfaceY);
                  drySum += surfaceY;
                  dryCount++;
               }
            }
         }

         if (centerWet) {
            lastReject = "center_wet";
         } else if (wetCount > 2) {
            lastReject = "too_wet";
         } else if (dryCount != 0 && minY >= 50) {
            if (maxY - minY <= 4) {
               BlockPos center = new BlockPos(x, minY + 1, z);
               return Optional.of(new GenerationStub(center, builder -> builder.addPiece(new MeteorCrashPiece(center))));
            }

            lastReject = "too_uneven spread=" + (maxY - minY);
         } else {
            lastReject = "too_low";
         }
      }

      reject(context, lastReject);
      return Optional.empty();
   }

   private static void reject(GenerationContext context, String why) {
      if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
         SymbioteLog.debug("METEOR_SITE_REJECTED chunk={},{} reason={}", context.chunkPos().x, context.chunkPos().z, why);
      }
   }

   public StructureType<?> type() {
      return (StructureType<?>)ModStructures.METEOR_CRASH.get();
   }
}
