package com.scout.symbiote.ability;

import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.LivingHurtListener;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.monster.warden.Warden;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.levelgen.structure.BuiltinStructures;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.phys.Vec3;

public final class StrainPersona {
   private static final double WARDEN_SILENCE_RANGE = 24.0;
   private static final int LEDGE_DROP_BLOCKS = 12;
   private static final int LEDGE_COOLDOWN = 300;
   private static final Map<UUID, Long> SILENCED_UNTIL = new HashMap<>();
   private static final Map<UUID, Long> LAST_LEDGE = new HashMap<>();
   private static final int CITY_CHECK_INTERVAL = 100;
   private static final int CITY_RECUR_COOLDOWN = 12000;
   private static final float CITY_RECUR_CHANCE = 0.15F;
   private static final Set<UUID> CITY_INSIDE = new HashSet<>();
   private static final Map<UUID, Long> CITY_LAST_LINE = new HashMap<>();
   private static final int SHADOW_TORCH_THRESHOLD = 4;
   private static final int SHADOW_DARK_COOLDOWN = 2400;
   private static final Map<UUID, Long> LAST_DARK = new HashMap<>();
   private static final Map<UUID, List<BlockPos>> DARK_WORK = new HashMap<>();

   public static boolean isSilenced(ServerPlayer player) {
      Long until = SILENCED_UNTIL.get(player.getUUID());
      if (until == null) {
         return false;
      } else {
         long now = player.serverLevel().getGameTime();
         if (until - now > 60L) {
            SILENCED_UNTIL.remove(player.getUUID());
            SymbioteLog.event("SCULK_SILENCE_SKEW_HEALED player={}", player.getUUID());
            return false;
         } else {
            return now < until;
         }
      }
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      switch (p.strain) {
         case SCULK:
            tickWardenSilence(player, level, now);
            tickCityRecognition(player, level, now);
            break;
         case SHADOW:
            tickShadowDark(player, level, p, now);
            break;
         case GUARDIAN:
            tickLedgeWorry(player, level, p, now);
      }
   }

   private static void tickCityRecognition(ServerPlayer player, ServerLevel level, long now) {
      if (now % 100L == 0L) {
         Registry<Structure> registry = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
         Structure city = registry.getValue(BuiltinStructures.ANCIENT_CITY);
         boolean inside = city != null && level.structureManager().getStructureAt(player.blockPosition(), city).isValid();
         UUID id = player.getUUID();
         if (!inside) {
            CITY_INSIDE.remove(id);
         } else {
            boolean firstEntry = CITY_INSIDE.add(id);
            Long lastLine = CITY_LAST_LINE.get(id);
            boolean recurReady = (lastLine == null || now - lastLine >= 12000L) && player.getRandom().nextFloat() < 0.15F;
            if (firstEntry && lastLine == null || recurReady) {
               CITY_LAST_LINE.put(id, now);
               VoiceLines.send(player, "symbiote.voice.sculk_city", 0);
               SymbioteLog.event("SCULK_CITY_RECOGNITION player={} first={}", id, firstEntry);
            }
         }
      }
   }

   private static void tickWardenSilence(ServerPlayer player, ServerLevel level, long now) {
      boolean wardenNear = !level.getEntitiesOfClass(Warden.class, player.getBoundingBox().inflate(24.0)).isEmpty();
      if (wardenNear) {
         SymbioteCuriosity.noteEncounter(player, level, "first_warden", "symbiote.voice.warden_silence");
         boolean wasSilent = isSilenced(player);
         SILENCED_UNTIL.put(player.getUUID(), now + 40L);
         if (!wasSilent) {
            SymbioteLog.event("SCULK_SILENCE_START player={}", player.getUUID());
         }
      }
   }

   private static boolean isTorch(BlockState state) {
      return state.is(Blocks.TORCH) || state.is(Blocks.WALL_TORCH) || state.is(Blocks.SOUL_TORCH) || state.is(Blocks.SOUL_WALL_TORCH);
   }

   private static boolean isDousable(BlockState state) {
      return state.is(BlockTags.CAMPFIRES) || state.is(BlockTags.CANDLES);
   }

   private static void tickShadowDark(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      List<BlockPos> work = DARK_WORK.remove(player.getUUID());
      if (work != null) {
         int popped = 0;

         for (BlockPos pos : work) {
            BlockState state = level.getBlockState(pos);
            if (isTorch(state)) {
               level.destroyBlock(pos, true, player);
            } else {
               if (!state.hasProperty(BlockStateProperties.LIT) || !(Boolean)state.getValue(BlockStateProperties.LIT) || !isDousable(state)) {
                  continue;
               }

               level.setBlock(pos, (BlockState)state.setValue(BlockStateProperties.LIT, false), 3);
            }

            level.playSound(null, pos, SoundEvents.FIRE_EXTINGUISH, SoundSource.PLAYERS, 0.6F, 0.8F);
            popped++;
         }

         if (popped > 0) {
            SymbioteLog.event("SHADOW_DARK player={} lights={}", player.getUUID(), popped);
         }
      } else if (!player.isSleeping()) {
         if (now - LAST_DARK.getOrDefault(player.getUUID(), 0L) >= 2400L) {
            if (!WalkSeizure.isActive(player.getUUID())
               && !DeepSeizure.isActive(player.getUUID())
               && !SymbioteCuriosity.isStaring(player.getUUID())
               && !TendrilSceneController.isInScene(player.getUUID())) {
               BlockPos base = player.blockPosition();
               boolean day = level.isDay();
               List<BlockPos> torches = new ArrayList<>();

               for (BlockPos pos : BlockPos.betweenClosed(base.offset(-7, -2, -7), base.offset(7, 3, 7))) {
                  BlockState state = level.getBlockState(pos);
                  boolean lit = isTorch(state)
                     || isDousable(state) && state.hasProperty(BlockStateProperties.LIT) && (Boolean)state.getValue(BlockStateProperties.LIT);
                  if (lit && (!day || !level.canSeeSky(pos.above()))) {
                     torches.add(pos.immutable());
                  }
               }

               if (torches.size() >= 4) {
                  LAST_DARK.put(player.getUUID(), now);
                  torches.sort(Comparator.comparingDouble(posx -> posx.distSqr(base)));
                  List<BlockPos> picked = torches.subList(0, Math.min(2, torches.size()));

                  for (BlockPos pos : picked) {
                     if (TendrilMantle.timedJob(player, level, Vec3.atCenterOf(pos), 6, 22, 2, ItemStack.EMPTY) == null) {
                        TendrilFxEntity.spawnGrabAtPoint(level, player, Vec3.atCenterOf(pos), 40, p.strain);
                     }
                  }

                  DARK_WORK.put(player.getUUID(), new ArrayList<>(picked));
                  VoiceLines.send(player, "symbiote.voice.shadow_dark", 0);
               }
            }
         }
      }
   }

   private static void tickLedgeWorry(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (player.onGround() && !player.isShiftKeyDown() && !(player.getXRot() < 40.0F)) {
         if (!LivingHurtListener.fallDamageImmune(player, p, now)) {
            if (now - LAST_LEDGE.getOrDefault(player.getUUID(), 0L) >= 300L) {
               if (!WalkSeizure.isActive(player.getUUID())
                  && !DeepSeizure.isActive(player.getUUID())
                  && !SymbioteCuriosity.isStaring(player.getUUID())
                  && !TendrilSceneController.isInScene(player.getUUID())) {
                  Vec3 look = player.getLookAngle();
                  int dx = Math.abs(look.x) > 0.35 ? (look.x > 0.0 ? 1 : -1) : 0;
                  int dz = Math.abs(look.z) > 0.35 ? (look.z > 0.0 ? 1 : -1) : 0;
                  if (dx != 0 || dz != 0) {
                     BlockPos probe = player.blockPosition().offset(dx, -1, dz);
                     int depth = 0;

                     while (depth < 12 && level.getBlockState(probe.below(depth)).isAir()) {
                        depth++;
                     }

                     if (depth >= 12) {
                        LAST_LEDGE.put(player.getUUID(), now);
                        ModNetwork.sendOverrideFx(player, "ledge_pull", 30);
                        VoiceLines.send(player, "symbiote.voice.guardian_ledge", 4);
                        SymbioteLog.event("GUARDIAN_LEDGE player={} depth={}+", player.getUUID(), depth);
                     }
                  }
               }
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      SILENCED_UNTIL.remove(player);
      LAST_LEDGE.remove(player);
      LAST_DARK.remove(player);
      DARK_WORK.remove(player);
      CITY_INSIDE.remove(player);
      CITY_LAST_LINE.remove(player);
   }

   private StrainPersona() {
   }
}
