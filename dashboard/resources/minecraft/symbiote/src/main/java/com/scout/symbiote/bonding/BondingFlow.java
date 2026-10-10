package com.scout.symbiote.bonding;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.failure.RejectionDeath;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.Random;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;

public final class BondingFlow {
   private static final Random RANDOM = new Random();

   public static BondingFlow.BondingResult attemptBond(ServerPlayer player, ServerLevel level, boolean forceSuccess) {
      return attemptBond(player, level, forceSuccess, null);
   }

   public static BondingFlow.BondingResult attemptBond(ServerPlayer player, ServerLevel level, boolean forceSuccess, SymbioteStrain forceStrain) {
      SymbioteTracker t = SymbioteTracker.get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());
      if (p.stage.isBonded()) {
         SymbioteLog.event("BONDING_SKIPPED player={} reason=already_bonded", player.getUUID());
         return BondingFlow.BondingResult.ALREADY_BONDED;
      } else {
         double rejection = (Double)SymbioteConfig.REJECTION_CHANCE.get();
         boolean rejected = !forceSuccess && RANDOM.nextDouble() < rejection;
         if (rejected) {
            SymbioteLog.event("BONDING_REJECTED player={} roll_threshold={}", player.getUUID(), rejection);
            RejectionDeath.kill(player, level);
            return BondingFlow.BondingResult.REJECTED;
         } else {
            SymbioteStrain strain = forceStrain != null ? forceStrain : pickRandomStrain();
            SymbioteTracker.onBond(level, player, strain);
            level.playSound(
               null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.BOND_ATTACH.get(), SoundSource.PLAYERS, 1.0F, 1.0F
            );
            ModNetwork.sendOverrideFx(player, "bond_up", 60);
            VoiceLines.send(player, "symbiote.voice.bond_attached", 1);
            player.sendSystemMessage(
               Component.literal("Something is listening now. Press [X] to commune, [B] to feed it.")
                  .withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
            );
            SymbioteLog.event("BONDING_SUCCESS player={} strain={} instability_until={}", player.getUUID(), strain, p.instabilityUntilTick);
            return BondingFlow.BondingResult.SUCCESS;
         }
      }
   }

   public static void forceRejection(ServerPlayer player, ServerLevel level) {
      SymbioteLog.event("BONDING_REJECTED player={} reason=debug_force", player.getUUID());
      RejectionDeath.kill(player, level);
   }

   private static SymbioteStrain pickRandomStrain() {
      SymbioteStrain[] vs = SymbioteStrain.values();
      return vs[RANDOM.nextInt(vs.length)];
   }

   private BondingFlow() {
   }

   public enum BondingResult {
      SUCCESS,
      REJECTED,
      ALREADY_BONDED;
   }
}
