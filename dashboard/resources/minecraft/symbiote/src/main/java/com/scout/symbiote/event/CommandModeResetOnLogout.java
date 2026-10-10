package com.scout.symbiote.event;

import com.scout.symbiote.ability.ArmFreelance;
import com.scout.symbiote.ability.ArmInstincts;
import com.scout.symbiote.ability.ArmReflexes;
import com.scout.symbiote.ability.ArmWall;
import com.scout.symbiote.ability.ChestCuriosity;
import com.scout.symbiote.ability.CostlyResistance;
import com.scout.symbiote.ability.DominantAssertion;
import com.scout.symbiote.ability.FirePanicEscape;
import com.scout.symbiote.ability.GrabState;
import com.scout.symbiote.ability.LeapFallProtection;
import com.scout.symbiote.ability.PredatorHunt;
import com.scout.symbiote.ability.StrainPersona;
import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.ability.SymbioteBloom;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.SymbioteDesires;
import com.scout.symbiote.ability.SymbioteFeedingHunt;
import com.scout.symbiote.ability.SymbioteJealousy;
import com.scout.symbiote.ability.SymbioteScavengeReflex;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.ability.VoidFarewell;
import com.scout.symbiote.ability.WallCling;
import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.ability.WildHostSense;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.failure.LastResortRevival;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.override.HazardReflexes;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.LowHealthOverride;
import com.scout.symbiote.util.BodyControl;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.voice.Vindication;
import com.scout.symbiote.voice.VoiceLines;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.PlayerLoggedOutEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class CommandModeResetOnLogout {
   @SubscribeEvent
   public static void onPlayerLoggedOut(PlayerLoggedOutEvent event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         UUID id = player.getUUID();
         PlayerCommandDispatcher.clear(id);
         ChestCuriosity.onLogout(player, player.serverLevel());
         SymbioteCuriosity.onLogout(id);
         ArmReflexes.onLogout(id);
         StrainPersona.onLogout(id);
         ArmWall.clear(id);
         DrowningSave.onLogout(id);
         HazardReflexes.onLogout(id);
         HungerOverride.onLogout(id);
         LowHealthOverride.onLogout(id);
         VoiceLines.onLogout(id);
         CombatSense.onLogout(id);
         LastResortRevival.onLogout(id);
         SymbioteJealousy.onLogout(id);
         CostlyResistance.onLogout(id);
         LivingDeathListener.onLogout(id);
         ArmFreelance.onLogout(id);
         ArmInstincts.onLogout(id);
         SymbioteBloom.onLogout(id);
         WildHostSense.onLogout(id);
         TendrilMantle.onLogout(id);
         TendrilSceneController.forgetUnresolved(id);
         PredatorHunt.onLogout(id);
         DominantAssertion.onLogout(id);
         BodyControl.onLogout(id);
         LivingHurtListener.onLogout(id);
         SleepListener.onLogout(id);
         WildHostBrain.clearYank(id);
         VoidFarewell.onLogout(id);
         SymbioteFeedingHunt.onLogout(id);
         FirePanicEscape.onLogout(id);
         SymbioteDesires.onLogout(id);
         SymbioteScavengeReflex.onLogout(id);
         WallCling.onLogout(id);
         GrabState.clear(id);
         LeapFallProtection.onLogout(id);
         SymbioteArmsController.onLogout(id);
         Vindication.onLogout(id);
      }
   }

   private CommandModeResetOnLogout() {
   }
}
