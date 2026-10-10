package com.scout.symbiote.command;

import net.minecraft.core.Holder;
import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.ability.DefianceController;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.tracker.TrustRework;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffect;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.AABB;

public final class PlayerCommandDispatcher {
   private static final Map<UUID, PlayerCommandDispatcher.CommandMode> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> LAST_STANCE_TRUST = new HashMap<>();
   private static final Map<UUID, Long> LAST_EXECUTE = new HashMap<>();
   private static final Map<UUID, Long> LAST_BURST = new HashMap<>();
   private static final Map<UUID, Long> LAST_OBEY_TRUST = new HashMap<>();
   private static final Map<UUID, Long> LAST_IGNORE_TRUST = new HashMap<>();
   private static final int EXECUTE_COOLDOWN_TICKS = 20;
   private static final int BURST_COOLDOWN_TICKS = 200;
   private static final int OBEY_TRUST_COOLDOWN_TICKS = 600;
   private static final int IGNORE_TRUST_COOLDOWN_TICKS = 200;
   private static final int STANCE_MIN_START_STAMINA = 15;

   public static PlayerCommandDispatcher.CommandMode getMode(UUID player) {
      return ACTIVE.getOrDefault(player, PlayerCommandDispatcher.CommandMode.DEFAULT);
   }

   public static void onStanceKill(ServerPlayer player, ServerLevel level, long now) {
      if (getMode(player.getUUID()) != PlayerCommandDispatcher.CommandMode.DEFAULT) {
         Long last = LAST_STANCE_TRUST.get(player.getUUID());
         if (last == null || now - last >= SymbioteConfig.TRUST_STANCE_KILL_COOLDOWN_TICKS.get().intValue()) {
            LAST_STANCE_TRUST.put(player.getUUID(), now);
            SymbioteTracker.adjustTrust(level, player, SymbioteConfig.TRUST_STANCE_KILL.get(), "trust_stance_fight");
         }
      }
   }

   public static void tickStance(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      PlayerCommandDispatcher.CommandMode mode = getMode(player.getUUID());
      if (mode != PlayerCommandDispatcher.CommandMode.DEFAULT) {
         if (now % SymbioteConfig.STANCE_DRAIN_INTERVAL.get().intValue() == 0L) {
            p.stamina = Math.max(0, p.stamina - SymbioteConfig.STANCE_STAMINA_DRAIN.get());
            SymbioteTracker.get(level).setDirty();
            ModNetwork.syncToPlayer(level, player);
            if (p.stamina <= 0) {
               ACTIVE.remove(player.getUUID());
               VoiceLines.send(player, "symbiote.voice.command_exhausted", 4);
               ModNetwork.sendCommandMode(player, PlayerCommandDispatcher.CommandMode.DEFAULT);
               SymbioteLog.event("COMMAND_EXHAUSTED mode={} player={}", mode, player.getUUID());
               return;
            }
         }

         switch (mode) {
            case PROTECT_ME:
               if (now % SymbioteConfig.PROTECT_HEAL_INTERVAL.get().intValue() == 0L && player.getHealth() < player.getMaxHealth()) {
                  player.heal(SymbioteConfig.PROTECT_HEAL_AMOUNT.get().floatValue());
               }
               break;
            case HUNT:
               if (now % 40L == 0L) {
                  player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 60, 0, false, false, true));
                  player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_BOOST, 60, 0, false, false, true));
               }
               break;
            case HIDE:
               if (now % 20L == 0L) {
                  forgetTargets(player, level);
                  if (player.isCrouching()) {
                     player.addEffect(new MobEffectInstance(MobEffects.INVISIBILITY, 30, 0, false, false, true));
                  }
               }
         }
      }
   }

   public static void execute(ServerPlayer player, String commandId) {
      ServerLevel level = player.serverLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null && p.stage.isBonded()) {
         if (p.instabilityUntilTick > level.getGameTime()) {
            SymbioteLog.event("COMMAND_REJECTED command={} player={} reason=integrating", commandId, player.getUUID());
         } else {
            PlayerCommandDispatcher.CommandMode requested = switch (commandId) {
               case "protect_me" -> PlayerCommandDispatcher.CommandMode.PROTECT_ME;
               case "hunt" -> PlayerCommandDispatcher.CommandMode.HUNT;
               case "hide" -> PlayerCommandDispatcher.CommandMode.HIDE;
               default -> {
                  SymbioteMod.LOGGER.warn("Unknown command id: {}", commandId);
                  yield null;
               }
            };
            if (requested != null) {
               if (getMode(player.getUUID()) == requested) {
                  ACTIVE.remove(player.getUUID());
                  stripBurst(player, requested);
                  SymbioteLog.event("COMMAND_STANDDOWN command={} player={}", commandId, player.getUUID());
                  VoiceLines.send(player, "symbiote.voice.command_standdown", 0);
                  ModNetwork.sendCommandMode(player, PlayerCommandDispatcher.CommandMode.DEFAULT);
               } else {
                  long now = level.getGameTime();
                  Long lastExec = LAST_EXECUTE.get(player.getUUID());
                  if (lastExec != null && now - lastExec < 20L) {
                     SymbioteLog.event("COMMAND_IGNORED command={} player={} reason=too_fast", commandId, player.getUUID());
                  } else {
                     LAST_EXECUTE.put(player.getUUID(), now);
                     if (p.stamina < 15) {
                        SymbioteLog.event("COMMAND_REJECTED command={} player={} reason=exhausted stamina={}", commandId, player.getUUID(), p.stamina);
                        VoiceLines.send(player, "symbiote.voice.command_exhausted", 4);
                     } else {
                        boolean defied = DefianceController.shouldDefyCommand(p);
                        boolean young = !p.stage.isAtLeast(BondStage.COOPERATIVE);
                        boolean legacyIgnore;
                        if (TrustRework.live()) {
                           double youngIgnoreChance = Math.min(0.35, 0.05 + p.stress / 400.0 + (100 - p.trust) / 500.0);
                           legacyIgnore = young && Math.random() < youngIgnoreChance;
                        } else {
                           legacyIgnore = young && p.isHighStress() && p.trust < 30 && Math.random() < 0.35;
                        }

                        if (!defied && !legacyIgnore) {
                           ACTIVE.put(player.getUUID(), requested);
                           SymbioteLog.event("COMMAND_OBEYED command={} player={}", commandId, player.getUUID());
                           Long lastTrust = LAST_OBEY_TRUST.get(player.getUUID());
                           if (lastTrust == null || now - lastTrust >= 600L) {
                              LAST_OBEY_TRUST.put(player.getUUID(), now);
                              SymbioteTracker.adjustTrust(level, player, 1, "trust_command_obeyed");
                           }

                           VoiceLines.send(player, "symbiote.voice.command_obeyed." + commandId, 1);
                           ModNetwork.sendCommandMode(player, requested);
                           Long lastBurst = LAST_BURST.get(player.getUUID());
                           if (lastBurst == null || now - lastBurst >= 200L) {
                              LAST_BURST.put(player.getUUID(), now);
                              applyCommandBurst(player, level, p, requested);
                           }
                        } else {
                           SymbioteLog.event(
                              "COMMAND_IGNORED command={} player={} stage={} stress={} trust={} reason={}",
                              commandId,
                              player.getUUID(),
                              p.stage,
                              p.stress,
                              p.trust,
                              defied ? "defiance" : "legacy_ignore"
                           );
                           Long lastPen = LAST_IGNORE_TRUST.get(player.getUUID());
                           if (lastPen == null || now - lastPen >= 200L) {
                              LAST_IGNORE_TRUST.put(player.getUUID(), now);
                              SymbioteTracker.adjustTrust(level, player, -2, "trust_command_ignored");
                           }

                           VoiceLines.send(player, defied ? "symbiote.voice.defiance" : "symbiote.voice.command_ignored", 2);
                        }
                     }
                  }
               }
            }
         }
      } else {
         SymbioteLog.event("COMMAND_REJECTED command={} player={} reason=unbonded", commandId, player.getUUID());
      }
   }

   private static void stripBurst(ServerPlayer player, PlayerCommandDispatcher.CommandMode mode) {
      switch (mode) {
         case PROTECT_ME:
            clearBurstEffect(player, MobEffects.DAMAGE_RESISTANCE, 100);
            break;
         case HUNT:
            clearBurstEffect(player, MobEffects.MOVEMENT_SPEED, 160);
            clearBurstEffect(player, MobEffects.DAMAGE_BOOST, 160);
            break;
         case HIDE:
            clearBurstEffect(player, MobEffects.INVISIBILITY, 120);
      }
   }

   private static void clearBurstEffect(ServerPlayer player, Holder<MobEffect> effect, int window) {
      MobEffectInstance held = player.getEffect(effect);
      if (held != null && held.getDuration() <= window + 20) {
         player.removeEffect(effect);
      }
   }

   private static void applyCommandBurst(ServerPlayer player, ServerLevel level, SymbioteProfile p, PlayerCommandDispatcher.CommandMode mode) {
      switch (mode) {
         case PROTECT_ME:
            player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, 100, 1, false, true));
            p.carapaceUntilTick = Math.max(p.carapaceUntilTick, level.getGameTime() + SymbioteConfig.CARAPACE_DURATION_TICKS.get().intValue());
            TendrilFxEntity.spawnBurst(level, player, 22, p.strain);
            VoiceLines.send(player, "symbiote.voice.command_burst.protect_me", 1);
            break;
         case HUNT:
            player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SPEED, 160, 0, false, true));
            player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_BOOST, 160, 0, false, true));
            TendrilFxEntity.spawnBurst(level, player, 18, p.strain);
            VoiceLines.send(player, "symbiote.voice.command_burst.hunt", 3);
            break;
         case HIDE:
            player.addEffect(new MobEffectInstance(MobEffects.INVISIBILITY, 120, 0, false, true));
            level.sendParticles(ParticleTypes.LARGE_SMOKE, player.getX(), player.getY() + 1.0, player.getZ(), 18, 0.4, 0.6, 0.4, 0.02);
            forgetTargets(player, level);
            VoiceLines.send(player, "symbiote.voice.command_burst.hide", 0);
      }
   }

   private static void forgetTargets(ServerPlayer player, ServerLevel level) {
      AABB box = player.getBoundingBox().inflate(24.0);

      for (Mob m : level.getEntitiesOfClass(Mob.class, box)) {
         if (m.getTarget() == player) {
            m.setTarget(null);
         }
      }
   }

   public static void clear(UUID player) {
      ACTIVE.remove(player);
      LAST_STANCE_TRUST.remove(player);
   }

   public static void clear(ServerPlayer player) {
      ACTIVE.remove(player.getUUID());
      ModNetwork.sendCommandMode(player, PlayerCommandDispatcher.CommandMode.DEFAULT);
   }

   private PlayerCommandDispatcher() {
   }

   public enum CommandMode {
      DEFAULT,
      PROTECT_ME,
      HUNT,
      HIDE;

      public static PlayerCommandDispatcher.CommandMode fromOrdinalSafe(int ordinal) {
         PlayerCommandDispatcher.CommandMode[] values = values();
         return ordinal >= 0 && ordinal < values.length ? values[ordinal] : DEFAULT;
      }
   }
}
