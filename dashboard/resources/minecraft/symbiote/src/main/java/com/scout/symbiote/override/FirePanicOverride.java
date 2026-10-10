package com.scout.symbiote.override;

import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.FirePanicEscape;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class FirePanicOverride {
   private static final int PULL_STRESS_FLOOR = 25;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (p.stage.isBonded() && !p.isDormant(level.getGameTime())) {
         if (!player.hasEffect(MobEffects.FIRE_RESISTANCE)) {
            if ((Boolean)SymbioteConfig.FIRE_PANIC_CONTACT_ONLY.get()) {
               if (!player.isOnFire() && !player.isInLava()) {
                  return;
               }
            } else if (level.dimensionType().ultraWarm() && !player.isOnFire() && !player.isInLava()) {
               return;
            }

            BlockPos fire = nearestFireSource(player, level);
            if (fire != null) {
               PlayerCommandDispatcher.CommandMode mode = PlayerCommandDispatcher.getMode(player.getUUID());
               if (mode != PlayerCommandDispatcher.CommandMode.HIDE) {
                  SymbioteTracker.adjustStress(level, player, SymbioteConfig.STRESS_FIRE_PER_TICK.get(), "stress_fire");
                  if (player.tickCount % 30 == 0) {
                     VoiceLines.send(player, "symbiote.voice.fire_panic", 4);
                     ModNetwork.sendOverrideFx(player, "fire_panic_pulse", 25);
                  }

                  if ((Boolean)SymbioteConfig.FIRE_PANIC_PULL.get()) {
                     int floor = mode == PlayerCommandDispatcher.CommandMode.PROTECT_ME ? 12 : 25;
                     floor = (int)Math.round(floor / p.stageIntensity());
                     if (p.stress >= floor) {
                        if (!FirePanicEscape.isActive(player.getUUID())) {
                           WalkSeizure.abort(player, level, p, "fire_panic");
                           DeepSeizure.abort(player, level, p, "fire_panic");
                           SymbioteCuriosity.abortStare(player);
                           Vec3 firePos = new Vec3(fire.getX() + 0.5, fire.getY() + 0.5, fire.getZ() + 0.5);
                           boolean started = FirePanicEscape.start(player, level, p, firePos);
                           if (started) {
                              SymbioteLog.overrideFired(player.getUUID(), "fire_panic", "escape_pull", "fire_pos", fire, "stress", p.stress);
                           } else {
                              FirePanicEscape.heave(player, level, firePos);
                           }
                        }
                     }
                  }
               }
            }
         }
      }
   }

   public static boolean forceTrigger(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.stage.isBonded()) {
         return false;
      }

      Vec3 firePos = player.position().add(2.0, 0.0, 0.0);
      boolean started = FirePanicEscape.start(player, level, p, firePos);
      ModNetwork.sendOverrideFx(player, "fire_panic_pulse", 30);
      VoiceLines.send(player, "symbiote.voice.fire_panic", 4);
      if (!started) {
         Vec3 away = player.position().subtract(firePos).normalize().scale(1.0);
         player.push(away.x, 0.2, away.z);
      }

      SymbioteLog.overrideFired(player.getUUID(), "fire_panic", started ? "debug_force_escape" : "debug_force_push");
      return true;
   }

   public static BlockPos nearestFireSource(ServerPlayer player, ServerLevel level) {
      int r = SymbioteConfig.FIRE_PANIC_RANGE.get();
      BlockPos origin = player.blockPosition();
      BlockPos best = null;
      double bestDist = Double.MAX_VALUE;
      boolean campfireCounts = player.isOnFire();

      for (int dx = -r; dx <= r; dx++) {
         for (int dy = -2; dy <= 2; dy++) {
            for (int dz = -r; dz <= r; dz++) {
               BlockPos pos = origin.offset(dx, dy, dz);
               BlockState state = level.getBlockState(pos);
               boolean litCampfire = (state.is(Blocks.CAMPFIRE) || state.is(Blocks.SOUL_CAMPFIRE))
                  && state.getOptionalValue(BlockStateProperties.LIT).orElse(false);
               boolean inCampfire = litCampfire && player.getBoundingBox().intersects(new AABB(pos));
               boolean isFire = state.is(Blocks.FIRE)
                  || state.is(Blocks.SOUL_FIRE)
                  || state.is(Blocks.MAGMA_BLOCK)
                  || litCampfire && campfireCounts
                  || inCampfire;
               boolean isLava = state.getFluidState().is(Fluids.LAVA) || state.getFluidState().is(Fluids.FLOWING_LAVA);
               if (isFire || isLava) {
                  double d = origin.distSqr(pos);
                  if (d < bestDist) {
                     bestDist = d;
                     best = pos;
                  }
               }
            }
         }
      }

      return best;
   }

   private FirePanicOverride() {
   }
}
