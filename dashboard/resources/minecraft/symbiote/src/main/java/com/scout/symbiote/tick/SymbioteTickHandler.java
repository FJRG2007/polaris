package com.scout.symbiote.tick;

import com.scout.symbiote.ability.ApexForm;
import com.scout.symbiote.ability.ArmFreelance;
import com.scout.symbiote.ability.ArmInstincts;
import com.scout.symbiote.ability.ArmReflexes;
import com.scout.symbiote.ability.CostlyResistance;
import com.scout.symbiote.ability.CrownedOnslaught;
import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.DefianceController;
import com.scout.symbiote.ability.DominantAssertion;
import com.scout.symbiote.ability.EmotionalMemory;
import com.scout.symbiote.ability.FirePanicEscape;
import com.scout.symbiote.ability.Frenzy;
import com.scout.symbiote.ability.GrabState;
import com.scout.symbiote.ability.GraftMorphs;
import com.scout.symbiote.ability.GraftTicker;
import com.scout.symbiote.ability.GroundSlam;
import com.scout.symbiote.ability.LeapFallProtection;
import com.scout.symbiote.ability.LivingArmor;
import com.scout.symbiote.ability.PredatorHunt;
import com.scout.symbiote.ability.PredatorSense;
import com.scout.symbiote.ability.RupturePounceScene;
import com.scout.symbiote.ability.StrainPersona;
import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.ability.SymbioteBloom;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.SymbioteDesires;
import com.scout.symbiote.ability.SymbioteFeedingHunt;
import com.scout.symbiote.ability.SymbioteJealousy;
import com.scout.symbiote.ability.SymbioteMolt;
import com.scout.symbiote.ability.SymbioteScavengeReflex;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.ability.TendrilYank;
import com.scout.symbiote.ability.WalkSeizure;
import com.scout.symbiote.ability.WallCling;
import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.ability.WildHostSense;
import com.scout.symbiote.bonding.InstabilityEffects;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.failure.ConsumptionDeath;
import com.scout.symbiote.failure.LastResortRevival;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.CreeperSaveOverride;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.override.FirePanicOverride;
import com.scout.symbiote.override.HazardReflexes;
import com.scout.symbiote.override.HungerOverride;
import com.scout.symbiote.override.LowHealthOverride;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.tracker.TrustRework;
import com.scout.symbiote.util.BodyControl;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.Vindication;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.animal.IronGolem;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.event.tick.LevelTickEvent;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class SymbioteTickHandler {
   private static final Map<UUID, Long> DORMANT_WARN = new HashMap<>();

   @SubscribeEvent
   public void onLevelTick(LevelTickEvent.Post event) {
      if (true) {
         if (event.getLevel() instanceof ServerLevel level) {
            TendrilSceneController.tickAll(level);
            SymbioteFeedingHunt.tickAll(level);
            FirePanicEscape.tickAll(level);
            RupturePounceScene.tickAll(level);
            SymbioteArmsController.tickAll(level);
            SymbioteScavengeReflex.tickAll(level);
            DeepSeizure.tickCleanup(level);
            WalkSeizure.tickCleanup(level);
            SymbioteCuriosity.tickCleanup(level);
            WildHostBrain.tickAll(level);
            WildHostBrain.tickLook(level);
         }
      }
   }

   @SubscribeEvent
   public void onPlayerTick(PlayerTickEvent.Post event) {
      if (true) {
         if (event.getEntity() instanceof ServerPlayer player) {
            ServerLevel level = player.serverLevel();
            long now = level.getGameTime();
            if (player.onGround()) {
               BodyControl.noteGrounded(player.getUUID(), now);
            }

            SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
            if (p != null && p.stage.isBonded()) {
               boolean dormant = p.isDormant(now);
               if (p.lastBondTick == 0L) {
                  p.lastBondTick = now;
               }

               if (now - p.lastBondTick >= 24000L) {
                  boolean gainedToday = now - p.lastBondGainTick < 24000L;
                  p.lastBondTick = now;
                  if (!gainedToday) {
                     int oldBond = p.bond;
                     p.addBond(-(Integer)SymbioteConfig.BOND_DECAY_PER_DAY.get());
                     SymbioteLog.valueChange(player.getUUID(), "bond", oldBond, p.bond, "bond_decay");
                     SymbioteTracker.get(level).setDirty();
                     ModNetwork.syncToPlayer(level, player);
                     if (p.hunger < 40) {
                        VoiceLines.send(player, "symbiote.voice.neglect", 4);
                     }

                     player.sendSystemMessage(
                        Component.literal("(the day's toll. the bond thins. feeding rebuilds it)")
                           .withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
                     );
                  }

                  boolean trustFedToday = now - p.lastTrustGainTick < 24000L;
                  if (TrustRework.live() && !trustFedToday && p.trust > 50) {
                     int oldTrust = p.trust;
                     p.setTrust(Math.max(50, p.trust - 2));
                     SymbioteLog.valueChange(player.getUUID(), "trust", oldTrust, p.trust, "trust_settle");
                     SymbioteTracker.get(level).setDirty();
                     ModNetwork.syncToPlayer(level, player);
                  }
               }

               double perDay = SymbioteConfig.HUNGER_DRAIN_PER_DAY.get().intValue() * StrainTraits.hungerDrainMult(p.strain) * difficultyHungerMult(level);
               long dripInterval = Math.max(20L, (long)(24000.0 / Math.max(0.01, perDay)));
               if (now % dripInterval == 0L && p.hunger > 0) {
                  int oldHunger = p.hunger;
                  p.addHunger(-1);
                  SymbioteLog.valueChange(player.getUUID(), "hunger", oldHunger, p.hunger, "hunger_metabolism");
                  SymbioteTracker.get(level).setDirty();
                  ModNetwork.syncToPlayer(level, player);
               }

               if (now % SymbioteConfig.STRESS_DECAY_INTERVAL.get().intValue() == 0L && p.stress > 0) {
                  SymbioteTracker.adjustStress(level, player, -SymbioteConfig.STRESS_DECAY_PER_TICK.get(), "stress_release");
               }

               boolean stanceHolding = !dormant && PlayerCommandDispatcher.getMode(player.getUUID()) != PlayerCommandDispatcher.CommandMode.DEFAULT;
               if (!stanceHolding && now % SymbioteConfig.STAMINA_REGEN_INTERVAL.get().intValue() == 0L && p.stamina < p.staminaMax()) {
                  p.regenStamina(SymbioteConfig.STAMINA_REGEN_PER_TICK.get());
                  SymbioteTracker.get(level).setDirty();
                  ModNetwork.syncToPlayer(level, player);
               }

               HealthGuard.repairAndLog(player);
               TendrilSceneController.tickUnresolvedKills(player, level, p, now);
               if (p.bond <= 0 && p.stage.isBonded()) {
                  ConsumptionDeath.consume(player, level, "bond_decay_to_zero");
               } else {
                  if (p.stage != p.announcedStage) {
                     boolean promoted = p.stage.ordinal() > p.announcedStage.ordinal();
                     BondStage from = p.announcedStage;
                     p.announcedStage = p.stage;
                     SymbioteLog.event("STAGE_{} player={} from={} to={}", promoted ? "PROMOTE" : "DEMOTE", player.getUUID(), from, p.stage);
                     SymbioteTracker.get(level).setDirty();
                     ModNetwork.syncToPlayer(level, player);
                     if (promoted) {
                        String key = switch (p.stage) {
                           case COOPERATIVE -> "symbiote.voice.stage_cooperative";
                           case DOMINANT -> "symbiote.voice.stage_dominant";
                           default -> "symbiote.voice.stage_promote";
                        };
                        VoiceLines.send(player, key, 1);
                        TendrilFxEntity.spawnBurst(level, player, 30, p.strain, true);
                        ModNetwork.sendOverrideFx(player, "stage_up", 80);
                        level.playSound(
                           null,
                           player.getX(),
                           player.getY(),
                           player.getZ(),
                           (SoundEvent)ModSounds.BOND_ATTACH.get(),
                           SoundSource.PLAYERS,
                           1.0F,
                           p.stage == BondStage.DOMINANT ? 0.8F : 1.0F
                        );
                        if (p.stage == BondStage.DOMINANT) {
                           level.playSound(
                              null,
                              player.getX(),
                              player.getY(),
                              player.getZ(),
                              (SoundEvent)ModSounds.OVERRIDE_SEIZURE.get(),
                              SoundSource.PLAYERS,
                              0.9F,
                              0.85F
                           );
                           player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, 30, 2, false, false));
                        }

                        if (p.stage == BondStage.DOMINANT) {
                           player.sendSystemMessage(
                              Component.literal("It barely asks anymore. [K] Apex")
                                 .withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
                           );
                        }

                        if (!p.firstCrossingDone) {
                           p.firstCrossingDone = true;
                           VoiceLines.send(player, "symbiote.voice.first_crossing", 4);
                           player.sendSystemMessage(
                              Component.literal("Deeper now. No seams left.")
                                 .withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
                           );
                        }

                        if (p.stage == BondStage.DOMINANT && p.temperamentOrdinal == 0) {
                           MoodEngine.Temperament t = MoodEngine.stampTemperament(p);
                           p.temperamentOrdinal = t.ordinal();
                           SymbioteLog.event("TEMPERAMENT_STAMPED player={} temperament={}", player.getUUID(), t);
                        }
                     } else {
                        VoiceLines.send(player, "symbiote.voice.stage_demote", 2);
                        p.addBeat(MoodEngine.BeatType.DEMOTION, now, null);
                        p.grievingUntil = now + 6000L;
                        ModNetwork.sendOverrideFx(player, "stage_down", 60);
                        level.playSound(
                           null,
                           player.getX(),
                           player.getY(),
                           player.getZ(),
                           (SoundEvent)ModSounds.TENDRIL_RETRACT.get(),
                           SoundSource.PLAYERS,
                           0.8F,
                           0.8F
                        );
                        ejectLockedArmItems(player, p, level);
                     }
                  }

                  if (p.isUnstable(now)) {
                     InstabilityEffects.tick(player, level, p);
                  }

                  if (p.dormantUntilTick > 0L && p.dormantUntilTick <= now) {
                     long was = p.dormantUntilTick;
                     p.dormantUntilTick = 0L;
                     SymbioteLog.event("DORMANCY_END player={} was_until={}", player.getUUID(), was);
                     SymbioteTracker.get(level).setDirty();
                     ModNetwork.syncToPlayer(level, player);
                     if (now < p.reunionUntil) {
                        VoiceLines.send(player, "symbiote.voice.reunion", 1);
                     }
                  }

                  if (p.apexUntilTick > 0L && now >= p.apexUntilTick) {
                     p.apexUntilTick = 0L;
                     ApexForm.onExpire(player, level, p);
                  }

                  DeepSeizure.tick(player, level, p, now);
                  WalkSeizure.tick(player, level, p, now);
                  SymbioteDesires.tickActive(player, level, p, now);
                  UUID cid = player.getUUID();
                  if (WalkSeizure.isActive(cid)
                     || DeepSeizure.isActive(cid)
                     || HungerOverride.isStalking(cid)
                     || SymbioteFeedingHunt.isHunting(cid)
                     || FirePanicEscape.isActive(cid)
                     || PredatorHunt.isHunting(cid)
                     || SymbioteDesires.isBloodTantrum(cid)) {
                     BodyControl.note(cid, now);
                     if (now % 10L == 0L) {
                        ModNetwork.sendOverrideFx(player, "controlled", 16);
                     }
                  }

                  SymbioteCuriosity.tickActive(player, level, p, now);
                  CostlyResistance.tick(player, level, p, now);
                  SymbioteBloom.tickActive(player, level, p, now);
                  if (now % 60L == 3L) {
                     boolean starving = p.isStarving();
                     if (starving && !p.wasStarving) {
                        p.addBeat(MoodEngine.BeatType.STARVED, now, null);
                     }

                     p.wasStarving = starving;
                     MoodEngine.Mood newMood = MoodEngine.evaluate(p, now);
                     int mood = newMood.ordinal();
                     if (mood != p.moodOrdinal) {
                        SymbioteLog.event("MOOD_CHANGE player={} from={} to={}", player.getUUID(), MoodEngine.Mood.values()[p.moodOrdinal], newMood);
                        p.moodOrdinal = mood;
                        SymbioteTracker.get(level).setDirty();
                        ModNetwork.syncToPlayer(level, player);
                        if (!TendrilSceneController.isInScene(player.getUUID())) {
                           String word = switch (newMood) {
                              case CONTENT -> "Content";
                              case ANXIOUS -> "Anxious";
                              case COILED -> "Coiled";
                              case GRIEVING -> "Grieving";
                           };
                           player.sendSystemMessage(
                              Component.literal("(" + word + ": " + MoodEngine.explain(p, now, newMood) + ")")
                                 .withStyle(new ChatFormatting[]{ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC})
                           );
                        }
                     }
                  }

                  if (dormant
                     && now % 40L == 0L
                     && CombatSense.inCombat(player, 60)
                     && now - DORMANT_WARN.getOrDefault(player.getUUID(), -100000L) >= 12000L
                     && player.getRandom().nextFloat() < 0.3F) {
                     DORMANT_WARN.put(player.getUUID(), now);
                     VoiceLines.send(player, "symbiote.voice.dormant_combat", 4);
                  }

                  if (!dormant) {
                     TendrilMantle.tick(player, level, p, now);
                     TendrilYank.tickGrab(player, level);
                     if (!player.isCreative() && !player.isSpectator()) {
                        PredatorHunt.tick(player, level, p, now);
                        DominantAssertion.tick(player, level, p, now);
                        if (now % 40L == 0L) {
                           GroundSlam.maybeStart(player, level, p, now);
                        }

                        TendrilMantle.tickCombatAutonomy(player, level, p, now);
                        if (PredatorSense.shouldTick(now)) {
                           PredatorSense.tickFor(player, level, p);
                        }

                        if (SymbioteDesires.shouldTick(now)) {
                           SymbioteDesires.tick(player, level, p, now);
                        }

                        float hpFrac = player.getHealth() / player.getMaxHealth();
                        MoodEngine.Mood moodNow = MoodEngine.current(p);

                        float beatAt = switch (moodNow) {
                           case ANXIOUS -> 0.45F;
                           case COILED -> 0.4F;
                           default -> 0.3F;
                        };
                        if (hpFrac <= beatAt && !StrainPersona.isSilenced(player)) {
                           int beatInterval = hpFrac <= 0.15F ? 13 : 25;
                           if (now % beatInterval == 0L) {
                              player.playNotifySound((SoundEvent)ModSounds.HEARTBEAT.get(), SoundSource.PLAYERS, 0.9F, hpFrac <= 0.15F ? 1.15F : 1.0F);
                           }
                        }

                        WildHostSense.tickHeartbeat(player, level, p, now);
                        WallCling.tick(player, level);
                        LivingArmor.tickWorn(player, level, p, now);
                        if (p.isFrenzied(now)) {
                           Frenzy.tick(player, level, p, now);
                        }

                        if (now < p.onslaughtUntilTick) {
                           CrownedOnslaught.tick(player, level, p, now);
                        }

                        DefianceController.tickAction(player, level, p, now);
                        DefianceController.maybeControlStruggle(player, level, p, now);
                        LastResortRevival.tickAdrenaline(player, level, p, now);
                        CreeperSaveOverride.tick(player, level, p);
                        DrowningSave.tick(player, level, p, now);
                        FirePanicOverride.tick(player, level, p);
                        LowHealthOverride.tick(player, level, p);
                        if (HungerOverride.shouldTick(now)) {
                           HungerOverride.tick(player, level, p);
                        }

                        if (now % 20L == 11L) {
                           HazardReflexes.tickFreeze(player, level, p, now);
                        }

                        if (now % 20L == 5L) {
                           SymbioteCuriosity.tickStart(player, level, p, now);
                        }

                        if (now % 20L == 17L) {
                           StrainPersona.tick(player, level, p, now);
                        }

                        if (now % 20L == 3L) {
                           SymbioteJealousy.tick(player, level, p, now);
                        }

                        if (now % 20L == 9L) {
                           ArmFreelance.tick(player, level, p, now);
                        }

                        if (now % 20L == 12L) {
                           ArmInstincts.tick(player, level, p, now);
                        }

                        if (now % 20L == 7L) {
                           SymbioteMolt.tick(player, level, p, now);
                        }

                        WildHostBrain.tickYank(player, level, now);
                        if (WildHostSense.shouldTick(now)) {
                           WildHostSense.tick(player, level, p, now);
                        }

                        SymbioteBloom.tick(player, level, p, now);
                        if (p.graft != null) {
                           GraftTicker.tick(player, level, p, now);
                           if (now % 10L == 4L) {
                              GraftMorphs.tick(player, level, p, now);
                           }
                        }

                        if (p.stage == BondStage.DOMINANT && now % 100L == 41L && SymbioteConfig.GOLEM_HOSTILE_TO_DOMINANT.get()) {
                           Iterator var32 = level.getEntitiesOfClass(IronGolem.class, player.getBoundingBox().inflate(16.0), g -> g.isAlive() && g.getTarget() == null)
                              .iterator();
                           if (var32.hasNext()) {
                              IronGolem golem = (IronGolem)var32.next();
                              golem.setTarget(player);
                              SymbioteLog.event("GOLEM_DISTRUST_NUDGE player={} golem={}", player.getUUID(), golem.getId());
                           }
                        }

                        if (now % 20L == 8L) {
                           SymbioteArmsController.tickStolenWatch(player, level, p);
                        }

                        ArmReflexes.tickArrow(player, level, p, now);
                        if (now % 20L == 14L) {
                           ArmReflexes.tickTorch(player, level, p, now);
                        }

                        PlayerCommandDispatcher.tickStance(player, level, p, now);
                        Vindication.tick(player, now);
                        if (now % 8L == 0L) {
                           SymbioteScavengeReflex.maybeStart(player, level, p);
                        }

                        if (now % 200L == 0L) {
                           LeapFallProtection.purgeExpired(now);
                        }

                        if (now % 200L == 0L) {
                           WallCling.purgeExpired(now);
                        }

                        if (now % 200L == 0L) {
                           GrabState.purgeStale(now);
                        }

                        if (now % 12000L == 777L) {
                           EmotionalMemory.tick(player, level, p, now);
                        }

                        if (now % 1200L == 77L && hpFrac <= 0.25F && p.stage.isAtLeast(BondStage.COOPERATIVE)) {
                           VoiceLines.send(player, "symbiote.voice.death_fear", 4);
                        }

                        if (now % 1200L == 0L && p.isStarving()) {
                           VoiceLines.send(player, "symbiote.voice.hunger_starving", 4);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void ejectLockedArmItems(ServerPlayer player, SymbioteProfile p, ServerLevel level) {
      if (p.armSlots != null) {
         int usable = p.armSlotCount();
         boolean changed = false;

         for (int i = usable; i < p.armSlots.length; i++) {
            ItemStack s = p.armSlots[i];
            if (s != null && !s.isEmpty()) {
               if (!player.getInventory().add(s)) {
                  player.drop(s, false);
               }

               p.armSlots[i] = ItemStack.EMPTY;
               changed = true;
               if (i == p.stolenArmSlot) {
                  p.stolenArmSlot = -1;
                  p.stolenArmItem = "";
               }

               if (i == p.contrabandSlot) {
                  p.contrabandSlot = -1;
                  p.contrabandTakenTick = 0L;
               }
            }
         }

         if (changed) {
            SymbioteArmsController.forceClear(level, player.getUUID());
            SymbioteTracker.get(level).setDirty();
            ModNetwork.syncToPlayer(level, player);
         }
      }
   }

   private static double difficultyHungerMult(ServerLevel level) {
      return switch (level.getDifficulty()) {
         case PEACEFUL -> 0.25;
         case EASY -> 0.75;
         case NORMAL -> 1.0;
         case HARD -> 1.25;
         default -> throw new IncompatibleClassChangeError();
      };
   }
}
