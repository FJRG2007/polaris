package com.scout.symbiote.override;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

public final class HazardReflexes {
   private static final Map<UUID, Long> LAST_DIG = new HashMap<>();
   private static final Map<UUID, Long> LAST_THAW = new HashMap<>();
   private static final int DIG_COOLDOWN = 15;
   private static final int THAW_COOLDOWN = 100;
   private static final int FREEZE_TRIGGER = 100;

   public static void onSuffocation(ServerPlayer player, ServerLevel level) {
      if ((Boolean)SymbioteConfig.SUFFOCATION_DIG_ENABLED.get()) {
         if (!player.isCreative() && !player.isSpectator()) {
            SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
            if (p != null && p.stage.isBonded() && !p.isDormant(level.getGameTime())) {
               long now = level.getGameTime();
               if (now - LAST_DIG.getOrDefault(player.getUUID(), 0L) >= 15L) {
                  BlockPos head = BlockPos.containing(player.getEyePosition());
                  int burst = 0;

                  for (BlockPos pos : new BlockPos[]{head, head.above(), player.blockPosition()}) {
                     BlockState state = level.getBlockState(pos);
                     if (!state.isAir() && state.isSuffocating(level, pos) && !(state.getDestroySpeed(level, pos) < 0.0F)) {
                        level.destroyBlock(pos, true, player);
                        burst++;
                     }
                  }

                  if (burst != 0) {
                     LAST_DIG.put(player.getUUID(), now);
                     level.playSound(null, head, (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 0.8F, 1.1F);
                     VoiceLines.send(player, "symbiote.voice.suffocate_out", 3);
                     SymbioteLog.overrideFired(player.getUUID(), "suffocation_dig", "in_wall_damage", "blocks", burst);
                  }
               }
            }
         }
      }
   }

   public static void tickFreeze(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if ((Boolean)SymbioteConfig.FREEZE_ESCAPE_ENABLED.get()) {
         if (player.getTicksFrozen() >= 100 && player.isInPowderSnow) {
            if (now - LAST_THAW.getOrDefault(player.getUUID(), 0L) >= 100L) {
               LAST_THAW.put(player.getUUID(), now);
               BlockPos base = player.blockPosition();
               int smashed = 0;

               for (int dx = -1; dx <= 1; dx++) {
                  for (int dz = -1; dz <= 1; dz++) {
                     for (int dy = 0; dy <= 1; dy++) {
                        BlockPos pos = base.offset(dx, dy, dz);
                        if (level.getBlockState(pos).is(Blocks.POWDER_SNOW)) {
                           level.destroyBlock(pos, false, player);
                           smashed++;
                        }
                     }
                  }
               }

               Vec3 look = player.getLookAngle();
               player.setDeltaMovement(look.x * 0.45, 0.5, look.z * 0.45);
               player.hurtMarked = true;
               level.playSound(null, base, (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 0.8F, 0.9F);
               VoiceLines.send(player, "symbiote.voice.freeze_escape", 3);
               SymbioteLog.overrideFired(player.getUUID(), "freeze_escape", "ticks_frozen", "frozen", player.getTicksFrozen(), "smashed", smashed);
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      LAST_DIG.remove(player);
      LAST_THAW.remove(player);
   }

   private HazardReflexes() {
   }
}
