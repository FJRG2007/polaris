package com.scout.symbiote.ability;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.BodySeized;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class AbilityDispatcher {
   public static void activate(ServerPlayer player, String abilityId) {
      ServerLevel level = player.serverLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null && p.stage.isBonded()) {
         long now = level.getGameTime();
         if (p.isDormant(now) && !"feed".equals(abilityId)) {
            SymbioteLog.event("ABILITY_REJECTED ability={} player={} reason=dormant until={}", abilityId, player.getUUID(), p.dormantUntilTick);
            VoiceLines.send(player, "symbiote.voice.dormant", 2);
         } else if (FirePanicEscape.isActive(player.getUUID()) && !"living_armor_toggle".equals(abilityId) && !"feed".equals(abilityId)) {
            reject(player, abilityId, "fire_escape");
         } else {
            switch (abilityId) {
               case "tendril_yank":
                  if (rejectIfBodySeized(player, abilityId)) {
                     return;
                  }

                  if (p.instabilityUntilTick > level.getGameTime()) {
                     reject(player, abilityId, "integrating");
                     return;
                  }

                  TendrilYank.fire(player, level, p);
                  break;
               case "wall_cling":
                  if (rejectIfBodySeized(player, abilityId)) {
                     return;
                  }

                  if (!p.stage.isAtLeast(BondStage.INTEGRATED)) {
                     reject(player, abilityId, "stage_too_low");
                     return;
                  }

                  WallCling.fire(player, level, p);
                  break;
               case "living_armor_toggle":
                  if (!p.livingArmorActive && !p.stage.isAtLeast(BondStage.INTEGRATED)) {
                     reject(player, abilityId, "stage_too_low");
                     return;
                  }

                  LivingArmor.toggle(player, level, p);
                  break;
               case "tendril_lash":
                  SymbioteLog.event("ABILITY_REJECTED ability=tendril_lash player={} reason=vaulted", player.getUUID());
                  return;
               case "carapace":
                  SymbioteLog.event("ABILITY_REJECTED ability=carapace player={} reason=vaulted", player.getUUID());
                  return;
               case "frenzy":
                  SymbioteLog.event("ABILITY_REJECTED ability=frenzy player={} reason=vaulted", player.getUUID());
                  return;
               case "apex":
                  if (!p.stage.isAtLeast(BondStage.DOMINANT)) {
                     reject(player, abilityId, "stage_too_low");
                     return;
                  }

                  if (!spend(player, level, p, abilityId, SymbioteConfig.STAMINA_COST_APEX.get())) {
                     return;
                  }

                  ApexForm.fire(player, level, p);
                  break;
               case "consume":
                  if (!p.stage.isAtLeast(BondStage.COOPERATIVE)) {
                     reject(player, abilityId, "stage_too_low");
                     return;
                  }

                  if (SymbioteFeedingHunt.isHunting(player.getUUID())) {
                     reject(player, abilityId, "already_feeding");
                     return;
                  }

                  if (now - p.lastConsumeTick < SymbioteConfig.CONSUME_COOLDOWN_TICKS.get().intValue()) {
                     reject(player, abilityId, "on_cooldown");
                     return;
                  }

                  if (p.stamina < SymbioteConfig.STAMINA_COST_CONSUME.get()) {
                     SymbioteLog.event("ABILITY_REJECTED ability=consume player={} reason=exhausted stamina={}", player.getUUID(), p.stamina);
                     VoiceLines.send(player, "symbiote.voice.exhausted", 4);
                     return;
                  }

                  if (!SymbioteFeedingHunt.startConsume(player, level, p)) {
                     SymbioteLog.event("ABILITY_REJECTED ability=consume player={} reason=no_target", player.getUUID());
                     VoiceLines.send(player, "symbiote.voice.ability_no_target", 2);
                     return;
                  }

                  p.lastConsumeTick = now;
                  spend(player, level, p, abilityId, SymbioteConfig.STAMINA_COST_CONSUME.get());
                  break;
               case "strain_power":
                  activateStrainPower(player, level, p, now);
                  break;
               case "feed":
                  if (rejectIfBodySeized(player, abilityId)) {
                     return;
                  }

                  Feeding.feedFromHeldItem(player, level, p);
                  break;
               default:
                  SymbioteMod.LOGGER.warn("Unknown ability id: {}", abilityId);
            }
         }
      } else {
         SymbioteLog.event("ABILITY_REJECTED ability={} player={} reason=unbonded", abilityId, player.getUUID());
      }
   }

   private static void activateStrainPower(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (!SymbioteConfig.STRAIN_POWERS_ENABLED.get()) {
         SymbioteLog.event("ABILITY_REJECTED ability=strain_power player={} reason=disabled", player.getUUID());
      } else if (!p.stage.isAtLeast(BondStage.INTEGRATED)) {
         reject(player, "strain_power", "stage_too_low");
      } else if (p.strain == SymbioteStrain.ROYAL) {
         if (now < p.onslaughtUntilTick) {
            reject(player, "strain_power", "already_active");
         } else if (now - p.lastStrainAbilityTick < SymbioteConfig.ONSLAUGHT_COOLDOWN_TICKS.get().intValue()) {
            reject(player, "strain_power", "on_cooldown");
         } else if (p.stamina < SymbioteConfig.STAMINA_COST_ONSLAUGHT.get()) {
            SymbioteLog.event("ABILITY_REJECTED ability=strain_power player={} reason=exhausted", player.getUUID());
            VoiceLines.send(player, "symbiote.voice.exhausted", 4);
         } else {
            CrownedOnslaught.activate(player, level, p, now);
            p.lastStrainAbilityTick = now;
            spend(player, level, p, "onslaught", SymbioteConfig.STAMINA_COST_ONSLAUGHT.get());
         }
      } else if (now - p.lastStrainAbilityTick < SymbioteConfig.STRAIN_ABILITY_COOLDOWN_TICKS.get().intValue()) {
         reject(player, "strain_power", "on_cooldown");
      } else {
         int cost = switch (p.strain) {
            case PREDATOR -> SymbioteConfig.STAMINA_COST_RUPTURE.get();
            case SHADOW -> SymbioteConfig.STAMINA_COST_NIGHTSTEP.get();
            case SCULK -> SymbioteConfig.STAMINA_COST_SCREECH.get();
            default -> SymbioteConfig.STAMINA_COST_AEGIS.get();
         };
         if (p.stamina < cost) {
            SymbioteLog.event("ABILITY_REJECTED ability=strain_power player={} reason=exhausted", player.getUUID());
            VoiceLines.send(player, "symbiote.voice.exhausted", 4);
         } else {
            boolean fired = switch (p.strain) {
               case PREDATOR -> RupturePounce.fire(player, level, p);
               case SHADOW -> Nightstep.fire(player, level, p);
               case SCULK -> SonicScreech.fire(player, level, p);
               default -> AegisBloom.fire(player, level, p);
            };
            if (fired) {
               p.lastStrainAbilityTick = now;
               spend(player, level, p, "strain_power", cost);
            } else {
               SymbioteLog.event("ABILITY_REJECTED ability=strain_power player={} reason=no_target", player.getUUID());
               VoiceLines.send(player, "symbiote.voice.ability_no_target", 2);
            }
         }
      }
   }

   private static boolean spend(ServerPlayer player, ServerLevel level, SymbioteProfile p, String abilityId, int cost) {
      if (!p.trySpendStamina(cost)) {
         SymbioteLog.event("ABILITY_REJECTED ability={} player={} reason=exhausted stamina={}", abilityId, player.getUUID(), p.stamina);
         VoiceLines.send(player, "symbiote.voice.exhausted", 4);
         return false;
      } else {
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         return true;
      }
   }

   private static boolean rejectIfBodySeized(ServerPlayer player, String abilityId) {
      if (!BodySeized.is(player)) {
         return false;
      }

      SymbioteLog.event("ABILITY_REJECTED ability={} player={} reason=body_seized", abilityId, player.getUUID());
      VoiceLines.send(player, "symbiote.voice.seizure_resist", 3);
      return true;
   }

   private static void reject(ServerPlayer player, String abilityId, String reason) {
      SymbioteLog.event("ABILITY_REJECTED ability={} player={} reason={}", abilityId, player.getUUID(), reason);
      VoiceLines.send(player, "on_cooldown".equals(reason) ? "symbiote.voice.ability_too_soon" : "symbiote.voice.ability_reject", 2);
   }

   private AbilityDispatcher() {
   }
}
