package com.scout.symbiote.registry;

import com.mojang.serialization.MapCodec;
import com.scout.symbiote.worldgen.AncientLabPiece;
import com.scout.symbiote.worldgen.AncientLabStructure;
import com.scout.symbiote.worldgen.MeteorCrashPiece;
import com.scout.symbiote.worldgen.MeteorCrashStructure;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureType;
import net.minecraft.world.level.levelgen.structure.pieces.StructurePieceType;
import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredHolder;

public final class ModStructures {
   public static final DeferredRegister<StructureType<?>> STRUCTURE_TYPES = DeferredRegister.create(Registries.STRUCTURE_TYPE, "symbiote");
   public static final DeferredRegister<StructurePieceType> STRUCTURE_PIECES = DeferredRegister.create(Registries.STRUCTURE_PIECE, "symbiote");
   public static final DeferredHolder<StructureType<?>, StructureType<MeteorCrashStructure>> METEOR_CRASH = STRUCTURE_TYPES.register(
      "meteor_crash", () -> ModStructures.<MeteorCrashStructure>typed(MeteorCrashStructure.CODEC)
   );
   public static final DeferredHolder<StructureType<?>, StructureType<AncientLabStructure>> ANCIENT_LAB = STRUCTURE_TYPES.register(
      "ancient_lab", () -> ModStructures.<AncientLabStructure>typed(AncientLabStructure.CODEC)
   );
   public static final DeferredHolder<StructurePieceType, StructurePieceType> METEOR_CRASH_PIECE = STRUCTURE_PIECES.register("meteor_crash_piece", () -> (StructurePieceType.ContextlessType) MeteorCrashPiece::new);
   public static final DeferredHolder<StructurePieceType, StructurePieceType> ANCIENT_LAB_PIECE = STRUCTURE_PIECES.register("ancient_lab_piece", () -> (StructurePieceType.ContextlessType) AncientLabPiece::new);
   public static final TagKey<Structure> METEOR_CRASH_TAG = TagKey.create(Registries.STRUCTURE, ResourceLocation.fromNamespaceAndPath("symbiote", "meteor_crash"));
   public static final TagKey<Structure> ANCIENT_LAB_TAG = TagKey.create(Registries.STRUCTURE, ResourceLocation.fromNamespaceAndPath("symbiote", "ancient_lab"));

   private static <S extends Structure> StructureType<S> typed(MapCodec<S> codec) {
      return () -> codec;
   }

   private ModStructures() {
   }
}
