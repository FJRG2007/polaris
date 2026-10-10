package com.scout.symbiote.ability;

import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.Footing;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

public final class DeepSeizure {
   private static final int MAX_TICKS = 400;
   private static final int GRIP_TICKS = 20;
   private static final int TICKS_PER_BLOCK = 12;
   private static final int TARGET_DEPTH = 12;
   private static final float FORCED_PITCH = 78.0F;
   private static final float PITCH_TOLERANCE = 25.0F;
   private static final float RESIST_DAMAGE = 1.5F;
   private static final int RESIST_BEAT_TICKS = 15;
   private static final Map<UUID, DeepSeizure.Session> ACTIVE = new HashMap<>();

   public static boolean isActive(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static boolean start(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (ACTIVE.containsKey(player.getUUID())) {
         return false;
      }

      if (WalkSeizure.isActive(player.getUUID())) {
         return false;
      }

      if (TendrilSceneController.isInScene(player.getUUID())) {
         return false;
      }

      if (FirePanicEscape.isActive(player.getUUID())) {
         return false;
      }

      if (DrowningSave.isActive(player.getUUID())) {
         return false;
      }

      if (player.isPassenger()) {
         Entity veh = player.getVehicle();
         if (veh != null && veh.isInWater()) {
            return false;
         }

         player.stopRiding();
         SymbioteLog.event("DEEP_SEIZURE_DISMOUNT player={}", player.getUUID());
      }

      if (player.isInWater()) {
         return false;
      }

      if (!Footing.planted(player)) {
         return false;
      }

      BlockPos below = null;

      for (int i = 1; i <= 3; i++) {
         BlockPos cand = player.blockPosition().below(i);
         if (!level.getBlockState(cand).isAir()) {
            below = cand;
            break;
         }
      }

      if (below == null) {
         return false;
      } else if (diggable(level, below) && !fluidAt(level, below) && !fluidAt(level, below.below())) {
         ACTIVE.put(
            player.getUUID(),
            new DeepSeizure.Session(player.blockPosition().getY(), player.blockPosition().getX() + 0.5, player.blockPosition().getZ() + 0.5, player.getYRot())
         );
         ModNetwork.sendBodySeized(player, true, false);
         OverrideGate.seize(player, level, p, "deep_seizure");
         VoiceLines.send(player, "symbiote.voice.tantrum_deep_dig", 3);
         ModNetwork.sendOverrideFx(player, "vignette_black", 60);
         SymbioteLog.event("DEEP_SEIZURE_START player={} y={}", player.getUUID(), player.getY());
         return true;
      } else {
         return false;
      }
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      DeepSeizure.Session s = ACTIVE.get(player.getUUID());
      if (s != null) {
         s.age++;
         if (s.age % 40 == 0) {
            ModNetwork.sendBodySeized(player, true, false);
         }

         if (s.age % 20 == 0) {
            LivingArmor.autoSheathIfThreatened(player, level, p);
         }

         boolean darkEnough = level.getMaxLocalRawBrightness(player.blockPosition()) < 5 && SymbioteDesires.isUnderground(player, level);
         boolean deepEnough = player.blockPosition().getY() <= s.startY - 12;
         if (s.age <= 400 && !darkEnough && !deepEnough && !(player.getY() < level.getMinY() + 5)) {
            if (s.age == 1 || s.age % 40 == 0) {
               ModNetwork.sendOverrideFx(player, gripFxId(s), 80);
            }

            float pitchDev = Math.abs(player.getXRot() - 78.0F);
            float yawDev = Math.abs(Mth.degreesDifference(player.getYRot(), s.lockedYaw));
            if ((pitchDev > 25.0F || yawDev > 60.0F) && now - s.lastResistPunish >= 15L && player.getHealth() > 5.5F) {
               s.lastResistPunish = now;
               player.hurt(level.damageSources().magic(), 1.5F);
               VoiceLines.send(player, "symbiote.voice.seizure_resist", 3);
               SymbioteTracker.adjustStress(level, player, 2, "stress_seizure_resist");
            }

            player.fallDistance = 0.0F;
            double dx = player.getX() - s.colX;
            double dz = player.getZ() - s.colZ;
            if (dx * dx + dz * dz > 2.25) {
               player.connection.teleport(s.colX, player.getY(), s.colZ, player.getYRot(), player.getXRot());
            }

            if (s.age >= 20) {
               BlockPos next = null;
               int topY = player.blockPosition().getY() - 1;

               for (int y = topY; y > topY - 4; y--) {
                  BlockPos cand = new BlockPos((int)Math.floor(s.colX), y, (int)Math.floor(s.colZ));
                  if (!level.getBlockState(cand).isAir()) {
                     if (fluidAt(level, cand) || fluidAt(level, cand.below())) {
                        release(player, level, p, false);
                        return;
                     }

                     if (!diggable(level, cand)) {
                        release(player, level, p, false);
                        return;
                     }

                     next = cand;
                     break;
                  }
               }

               if (next == null) {
                  return;
               }

               if (!next.equals(s.digging)) {
                  s.digging = next;
                  s.digProgress = 0;
                  TendrilFxEntity fx = TendrilMantle.timedJob(player, level, Vec3.atCenterOf(next), 5, 14, 1, ItemStack.EMPTY);
                  if (fx == null) {
                     fx = TendrilFxEntity.spawnArm(
                        level, player, Vec3.atCenterOf(next), 22, p.strain, 1, 5, player.getRandom().nextFloat() * (float) (Math.PI * 2), ItemStack.EMPTY
                     );
                  }

                  s.fxId = fx.getId();
               }

               s.digProgress++;
               level.destroyBlockProgress(s.fxId, s.digging, Math.min(9, s.digProgress * 10 / 12));
               if (s.digProgress % 4 == 1) {
                  BlockState chip = level.getBlockState(s.digging);
                  level.playSound(null, s.digging, chip.getSoundType().getHitSound(), SoundSource.BLOCKS, 0.55F, chip.getSoundType().getPitch() * 0.85F);
               }

               if (s.digProgress >= 12) {
                  level.destroyBlockProgress(s.fxId, s.digging, -1);
                  level.destroyBlock(s.digging, true, player);
                  s.digging = null;
               }

               return;
            }
         } else {
            release(player, level, p, darkEnough || deepEnough);
         }
      }
   }

   private static String gripFxId(DeepSeizure.Session s) {
      return "deepgrip:" + Math.round(s.lockedYaw) + ":" + String.format(Locale.ROOT, "%.1f", s.colX) + ":" + String.format(Locale.ROOT, "%.1f", s.colZ);
   }

   public static void abort(ServerPlayer player, ServerLevel level, SymbioteProfile p, String reason) {
      if (ACTIVE.containsKey(player.getUUID())) {
         SymbioteLog.event("DEEP_SEIZURE_ABORT player={} reason={}", player.getUUID(), reason);
         release(player, level, p, false);
      }
   }

   private static void release(ServerPlayer player, ServerLevel level, SymbioteProfile p, boolean sated) {
      DeepSeizure.Session s = ACTIVE.remove(player.getUUID());
      if (s != null && s.digging != null) {
         level.destroyBlockProgress(s.fxId, s.digging, -1);
      }

      if (s != null && level.getEntity(s.fxId) instanceof TendrilFxEntity mfx) {
         TendrilMantle.endJob(level, mfx);
      }

      ModNetwork.sendBodySeized(player, false, false);
      player.fallDistance = 0.0F;
      if (s != null) {
         ModNetwork.sendOverrideFx(player, gripFxId(s), 1);
      }

      if (sated) {
         SymbioteTracker.adjustStress(level, player, -8, "stress_seizure_sated");
         VoiceLines.send(player, "symbiote.voice.desire_taken_done", 3);
      } else {
         VoiceLines.send(player, "symbiote.voice.seizure_release", 4);
      }

      level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_RETRACT.get(), SoundSource.PLAYERS, 0.7F, 0.9F);
      SymbioteLog.event("DEEP_SEIZURE_END player={} sated={} y={}", player.getUUID(), sated, player.getY());
   }

   public static void tickCleanup(ServerLevel level) {
      Iterator<Entry<UUID, DeepSeizure.Session>> it = ACTIVE.entrySet().iterator();

      while (it.hasNext()) {
         Entry<UUID, DeepSeizure.Session> e = it.next();
         ServerPlayer pl = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (pl == null || !pl.isAlive()) {
            it.remove();
         }
      }
   }

   private static boolean diggable(ServerLevel level, BlockPos pos) {
      BlockState st = level.getBlockState(pos);
      return st.isAir() ? true : st.getDestroySpeed(level, pos) >= 0.0F;
   }

   private static boolean fluidAt(ServerLevel level, BlockPos pos) {
      return !level.getFluidState(pos).isEmpty();
   }

   private DeepSeizure() {
   }

   private static final class Session {
      int age = 0;
      final int startY;
      final double colX;
      final double colZ;
      float lockedYaw;
      BlockPos digging = null;
      int digProgress = 0;
      int fxId = 0;
      long lastResistPunish = -100L;

      Session(int startY, double colX, double colZ, float yaw) {
         this.startY = startY;
         this.colX = colX;
         this.colZ = colZ;
         this.lockedYaw = yaw;
      }
   }
}
