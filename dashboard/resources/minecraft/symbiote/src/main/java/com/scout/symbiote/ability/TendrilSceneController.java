package com.scout.symbiote.ability;

import com.scout.symbiote.block.DeathCocoonBlock;
import com.scout.symbiote.block.DormantSampleBlock;
import com.scout.symbiote.bonding.BondingFlow;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.event.PlayerDeathListener;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.OverrideGate;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.HealthGuard;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.Map.Entry;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

public final class TendrilSceneController {
   private static final Map<UUID, TendrilSceneController.Scene> ACTIVE = new HashMap<>();
   private static final Random RITUAL_RANDOM = new Random();
   private static final Set<BlockPos> CLAIMED_SAMPLES = new HashSet<>();
   private static final Map<UUID, Long> UNRESOLVED_KILL = new ConcurrentHashMap<>();

   public static boolean isSampleClaimed(BlockPos pos) {
      return CLAIMED_SAMPLES.contains(pos);
   }

   private static void releaseSampleClaim(TendrilSceneController.Scene s) {
      if ((
            s.type == TendrilSceneController.SceneType.BONDING_RITUAL
               || s.type == TendrilSceneController.SceneType.REBOND
               || s.type == TendrilSceneController.SceneType.RECLAIM
               || s.type == TendrilSceneController.SceneType.GRAFT_RITUAL
               || s.type == TendrilSceneController.SceneType.GRAFT_REFUSED
         )
         && s.sourcePos != null) {
         CLAIMED_SAMPLES.remove(BlockPos.containing(s.sourcePos));
      }
   }

   public static void startConsumption(ServerPlayer player, ServerLevel level) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.CONSUMPTION, level.getGameTime(), 80, null, null);
         ACTIVE.put(player.getUUID(), s);
         applyImmobilize(player, 80);
         VoiceLines.send(player, "symbiote.voice.consumption", 3);
         ModNetwork.sendOverrideFx(player, "consumption", 80);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.CONSUMPTION.get(), SoundSource.PLAYERS, 1.0F, 1.0F);
         SymbioteLog.event("SCENE_START type=consumption player={}", player.getUUID());
         spawnEruptionWave(player, level, 1);
      }
   }

   public static void startRejection(ServerPlayer player, ServerLevel level, Vec3 samplePos) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(
            TendrilSceneController.SceneType.REJECTION, level.getGameTime(), 50, samplePos != null ? samplePos : player.position(), null
         );
         ACTIVE.put(player.getUUID(), s);
         applyImmobilize(player, 50);
         VoiceLines.send(player, "symbiote.voice.rejection", 3);
         ModNetwork.sendOverrideFx(player, "rejection", 50);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.REJECTION.get(), SoundSource.PLAYERS, 1.0F, 1.0F);
         SymbioteLog.event(
            "SCENE_START type=rejection player={} sample=({},{},{})", player.getUUID(), s.sourcePos.x, s.sourcePos.y, s.sourcePos.z
         );
         spawnRejectionLash(player, level, s.sourcePos);
      }
   }

   public static void startBondingRitual(ServerPlayer player, ServerLevel level, Vec3 samplePos, SymbioteStrain strain) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         SymbioteProfile existing = SymbioteTracker.get(level).peek(player.getUUID());
         if (existing != null && existing.stage.isBonded()) {
            SymbioteLog.event("SCENE_SKIP type=bonding_ritual player={} reason=already_bonded", player.getUUID());
         } else {
            TendrilSceneController.Scene s = new TendrilSceneController.Scene(
               TendrilSceneController.SceneType.BONDING_RITUAL, level.getGameTime(), 160, samplePos, strain
            );
            ACTIVE.put(player.getUUID(), s);
            CLAIMED_SAMPLES.add(BlockPos.containing(samplePos));
            player.setDeltaMovement(0.0, 0.0, 0.0);
            player.hurtMarked = true;
            applyImmobilizeNoBlind(player, 160);
            ModNetwork.sendOverrideFx(player, "bond_up", 160);
            SymbioteLog.event(
               "SCENE_START type=bonding_ritual player={} sample=({},{},{}) strain={}",
               player.getUUID(),
               samplePos.x,
               samplePos.y,
               samplePos.z,
               strain
            );
            spawnBondingTendrilsWave(level, samplePos, player, strain, 160, 3, 0.0F);
         }
      }
   }

   public static void startRebond(ServerPlayer player, ServerLevel level, Vec3 massPos, SymbioteStrain strain) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.REBOND, level.getGameTime(), 80, massPos, strain);
         ACTIVE.put(player.getUUID(), s);
         CLAIMED_SAMPLES.add(BlockPos.containing(massPos));
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         applyImmobilizeNoBlind(player, 80);
         ModNetwork.sendOverrideFx(player, "bond_up", 80);
         SymbioteLog.event(
            "SCENE_START type=rebond player={} mass=({},{},{}) strain={}", player.getUUID(), massPos.x, massPos.y, massPos.z, strain
         );
         spawnBondingTendrilsWave(level, massPos, player, strain, 80, 3, 0.0F);
      }
   }

   private static void tickRebond(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 15) {
         spawnBondingTendrilsWave(level, s.sourcePos, player, s.strain, s.lifetimeTicks - s.currentTick, 3, (float) (Math.PI / 3));
         ModNetwork.sendOverrideFx(player, "vignette_black", 20);
      }

      if (s.currentTick == 30) {
         player.setNoGravity(true);
         player.setDeltaMovement(0.0, 0.22, 0.0);
         player.hurtMarked = true;
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.9F, 0.8F);
      }

      if (s.currentTick >= 30 && s.currentTick < 45) {
         Vec3 dm = player.getDeltaMovement();
         player.setDeltaMovement(0.0, Math.max(dm.y, 0.0), 0.0);
         player.hurtMarked = true;
         player.fallDistance = 0.0F;
      }

      if (s.currentTick >= 45 && s.currentTick < 70) {
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         player.fallDistance = 0.0F;
      }

      if (s.currentTick == 60) {
         DeathCocoonBlock.finishClaim(player, level, BlockPos.containing(s.sourcePos));
      }

      if (s.currentTick == 70 && !s.resolved) {
         player.setNoGravity(false);
         player.setInvulnerable(false);
         player.fallDistance = 0.0F;
         SymbioteLog.event("SCENE_RESOLVE type=rebond player={}", player.getUUID());
         s.resolved = true;
      }
   }

   public static void startReclaim(ServerPlayer player, ServerLevel level, Vec3 massPos, SymbioteStrain elder, SymbioteStrain young) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.RECLAIM, level.getGameTime(), 320, massPos, elder);
         s.strain2 = young;
         ACTIVE.put(player.getUUID(), s);
         CLAIMED_SAMPLES.add(BlockPos.containing(massPos));
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         applyImmobilizeNoBlind(player, 320);
         SymbioteLog.event("SCENE_START type=reclaim player={} elder={} young={}", player.getUUID(), elder, young);
         spawnBondingTendrilsWave(level, massPos, player, elder, 220, 3, 0.0F);
         growl(player, level, massPos, false);
         VoiceLines.sendAs(player, "symbiote.voice.reclaim_elder", 3, elder);
      }
   }

   private static void growl(ServerPlayer player, ServerLevel level, Vec3 at, boolean young) {
      level.playSound(
         null,
         at.x,
         at.y,
         at.z,
         (SoundEvent)ModSounds.VOICE_AGGRESSIVE.get(),
         SoundSource.PLAYERS,
         1.0F,
         young ? 1.18F + RITUAL_RANDOM.nextFloat() * 0.08F : 0.7F + RITUAL_RANDOM.nextFloat() * 0.06F
      );
   }

   private static void tickReclaim(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      Vec3 massPos = s.sourcePos;
      Vec3 body = player.position().add(0.0, 1.0, 0.0);
      if (s.currentTick == 50) {
         TendrilFxEntity.spawnBurst(level, player, 30, s.strain2, true);
         growl(player, level, body, true);
         VoiceLines.sendAs(player, "symbiote.voice.reclaim_young", 3, s.strain2);
      }

      if (s.currentTick == 100) {
         growl(player, level, massPos, false);
         VoiceLines.sendAs(player, "symbiote.voice.reclaim_elder_press", 3, s.strain);
      }

      if (s.currentTick == 125) {
         level.playSound(null, massPos.x, massPos.y, massPos.z, (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.PLAYERS, 1.0F, 0.8F);
      }

      if (s.currentTick >= 130 && s.currentTick < 210 && s.currentTick % 6 == 0) {
         boolean elderLash = s.currentTick / 6 % 2 == 0;
         Random r = RITUAL_RANDOM;
         Vec3 jitterA = new Vec3(r.nextDouble() - 0.5, r.nextDouble() * 0.8, r.nextDouble() - 0.5);
         Vec3 from = elderLash ? massPos : body;
         Vec3 to = (elderLash ? body : massPos).add(jitterA);
         TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(
            level, from, to, 22, elderLash ? s.strain : s.strain2, 0.5F + r.nextFloat() * 0.4F, (float)(r.nextDouble() * Math.PI * 2.0)
         );
         fx.setReachTicksOverride(5);
         fx.scheduleRetract(12);
         if (s.currentTick % 12 == 0) {
            ModNetwork.sendOverrideFx(player, elderLash ? "vignette_red" : "vignette_black", 12);
            level.playSound(
               null, to.x, to.y, to.z, (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 0.75F, elderLash ? 0.75F : 1.2F
            );
         }
      }

      if (s.currentTick == 140) {
         growl(player, level, massPos, false);
      }

      if (s.currentTick == 160) {
         growl(player, level, body, true);
      }

      if (s.currentTick == 180) {
         growl(player, level, massPos, false);
      }

      if (s.currentTick == 135 || s.currentTick == 175) {
         level.playSound(
            null,
            player.getX(),
            player.getY(),
            player.getZ(),
            (SoundEvent)ModSounds.OVERRIDE_SEIZURE.get(),
            SoundSource.PLAYERS,
            0.8F,
            s.currentTick == 175 ? 0.85F : 1.0F
         );
      }

      if (s.currentTick == 200) {
         VoiceLines.sendAs(player, "symbiote.voice.reclaim_young_last", 4, s.strain2);
      }

      if (s.currentTick == 220) {
         spawnBondingTendrilsWave(level, massPos, player, s.strain, 100, 3, (float) (Math.PI / 3));
         player.setNoGravity(true);
         player.setDeltaMovement(0.0, 0.2, 0.0);
         player.hurtMarked = true;
         growl(player, level, massPos, false);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.9F, 0.7F);
      }

      if (s.currentTick >= 220 && s.currentTick < 290) {
         Vec3 dm = player.getDeltaMovement();
         player.setDeltaMovement(0.0, s.currentTick < 230 ? Math.max(dm.y, 0.0) : 0.0, 0.0);
         player.hurtMarked = true;
         player.fallDistance = 0.0F;
      }

      if (s.currentTick == 240) {
         TendrilFxEntity.spawnBurst(level, player, 25, s.strain2, true);
         growl(player, level, body, true);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.REJECTION.get(), SoundSource.PLAYERS, 1.0F, 0.8F);
         level.playSound(
            null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_ERUPT.get(), SoundSource.PLAYERS, 0.9F, 1.1F
         );
         ModNetwork.sendOverrideFx(player, "rejection", 40);
      }

      if (s.currentTick == 265) {
         DeathCocoonBlock.finishReclaim(player, level, BlockPos.containing(massPos));
      }

      if (s.currentTick == 290 && !s.resolved) {
         player.setNoGravity(false);
         player.setInvulnerable(false);
         player.fallDistance = 0.0F;
         SymbioteLog.event("SCENE_RESOLVE type=reclaim player={}", player.getUUID());
         s.resolved = true;
      }
   }

   public static void startGraftRitual(ServerPlayer player, ServerLevel level, Vec3 samplePos, SymbioteStrain primary, SymbioteStrain graft) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(
            TendrilSceneController.SceneType.GRAFT_RITUAL, level.getGameTime(), 200, samplePos, primary
         );
         s.strain2 = graft;
         ACTIVE.put(player.getUUID(), s);
         CLAIMED_SAMPLES.add(BlockPos.containing(samplePos));
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         applyImmobilizeNoBlind(player, 200);
         SymbioteLog.event("SCENE_START type=graft_ritual player={} primary={} graft={}", player.getUUID(), primary, graft);
         spawnBondingTendrilsWave(level, samplePos, player, graft, 140, 3, 0.0F);
         VoiceLines.sendAs(player, "symbiote.voice.graft_object", 3, primary);
      }
   }

   private static void tickGraftRitual(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      Vec3 body = player.position().add(0.0, 1.0, 0.0);
      if (s.currentTick == 45) {
         spawnBondingTendrilsWave(level, s.sourcePos, player, s.strain2, 100, 3, (float) (Math.PI / 3));
         VoiceLines.sendAs(player, "symbiote.voice.graft_object2", 3, s.strain);
         ModNetwork.sendOverrideFx(player, "vignette_red", 30);
      }

      if (s.currentTick == 85) {
         TendrilFxEntity.spawnBurst(level, player, 30, s.strain, true);
         level.playSound(
            null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.OVERRIDE_SEIZURE.get(), SoundSource.PLAYERS, 0.9F, 0.8F
         );
      }

      if (s.currentTick >= 85 && s.currentTick < 120 && s.currentTick % 6 == 0) {
         boolean primaryLash = s.currentTick / 6 % 2 == 0;
         TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(
            level,
            primaryLash ? body : s.sourcePos,
            primaryLash ? s.sourcePos : body,
            20,
            primaryLash ? s.strain : s.strain2,
            0.6F,
            (float)(RITUAL_RANDOM.nextDouble() * Math.PI * 2.0)
         );
         fx.setReachTicksOverride(5);
         fx.scheduleRetract(11);
      }

      if (s.currentTick == 120 && !s.resolved) {
         GraftFlow.attach(player, level, s.strain2);
         TendrilFxEntity.spawnBurst(level, player, 30, s.strain2, true);
         drain(player, 4.0F);
         player.hurtTime = 10;
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.BOND_ATTACH.get(), SoundSource.PLAYERS, 1.0F, 1.15F);
         ModNetwork.sendOverrideFx(player, "morph:claw", 40);
         ModNetwork.sendOverrideFx(player, "bond_up", 40);
         BlockPos sp = BlockPos.containing(s.sourcePos);
         if (level.getBlockState(sp).getBlock() instanceof DormantSampleBlock) {
            level.levelEvent(2001, sp, Block.getId(level.getBlockState(sp)));
            level.removeBlock(sp, false);
         }
      }

      if (s.currentTick == 150) {
         VoiceLines.sendAs(player, "symbiote.voice.graft_first", 0, s.strain2);
      }

      if (s.currentTick == 180) {
         VoiceLines.sendAs(player, "symbiote.voice.graft_seethe", 2, s.strain);
      }

      if (s.currentTick == 195 && !s.resolved) {
         player.setInvulnerable(false);
         SymbioteLog.event("SCENE_RESOLVE type=graft_ritual player={}", player.getUUID());
         s.resolved = true;
      }
   }

   public static void startGraftPurge(ServerPlayer player, ServerLevel level, SymbioteStrain primary, SymbioteStrain graft) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.GRAFT_PURGE, level.getGameTime(), 120, null, primary);
         s.strain2 = graft;
         ACTIVE.put(player.getUUID(), s);
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         applyImmobilizeNoBlind(player, 120);
         SymbioteLog.event("SCENE_START type=graft_purge player={} primary={} graft={}", player.getUUID(), primary, graft);
         VoiceLines.sendAs(player, "symbiote.voice.graft_purge_open", 3, primary);
         TendrilFxEntity.spawnBurst(level, player, 30, primary, true);
         ModNetwork.sendOverrideFx(player, "vignette_red", 60);
      }
   }

   private static void tickGraftPurge(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      Vec3 body = player.position().add(0.0, 1.0, 0.0);
      if (s.currentTick == 25) {
         VoiceLines.sendAs(player, "symbiote.voice.graft_purge_plea", 4, s.strain2);
         ModNetwork.sendOverrideFx(player, "morph:claw", 40);
      }

      if (s.currentTick >= 40 && s.currentTick < 80 && s.currentTick % 5 == 0) {
         Vec3 hand = body.add((RITUAL_RANDOM.nextDouble() - 0.5) * 0.6, -0.4, (RITUAL_RANDOM.nextDouble() - 0.5) * 0.6);
         TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(level, body, hand, 18, s.strain, 0.5F, (float)(RITUAL_RANDOM.nextDouble() * Math.PI * 2.0));
         fx.setReachTicksOverride(4);
         fx.scheduleRetract(10);
      }

      if (s.currentTick == 45 || s.currentTick == 65) {
         level.playSound(
            null,
            player.getX(),
            player.getY(),
            player.getZ(),
            (SoundEvent)ModSounds.OVERRIDE_SEIZURE.get(),
            SoundSource.PLAYERS,
            0.9F,
            s.currentTick == 65 ? 0.8F : 0.95F
         );
      }

      if (s.currentTick == 85 && !s.resolved) {
         TendrilFxEntity.spawnBurst(level, player, 25, s.strain2, true);
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.REJECTION.get(), SoundSource.PLAYERS, 1.0F, 0.9F);
         drain(player, 6.0F);
         player.hurtTime = 10;
         GraftFlow.detach(player, level, "tension_purge");
         SymbioteTracker.adjustStress(level, player, 20, "stress_graft_purged");
         ModNetwork.sendOverrideFx(player, "rejection", 40);
      }

      if (s.currentTick == 105) {
         VoiceLines.sendAs(player, "symbiote.voice.graft_purge_done", 3, s.strain);
      }

      if (s.currentTick == 115 && !s.resolved) {
         player.setInvulnerable(false);
         SymbioteLog.event("SCENE_RESOLVE type=graft_purge player={}", player.getUUID());
         s.resolved = true;
      }
   }

   public static void startGraftRefused(ServerPlayer player, ServerLevel level, Vec3 samplePos, SymbioteStrain primary) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(
            TendrilSceneController.SceneType.GRAFT_REFUSED, level.getGameTime(), 60, samplePos, primary
         );
         ACTIVE.put(player.getUUID(), s);
         CLAIMED_SAMPLES.add(BlockPos.containing(samplePos));
         applyImmobilizeNoBlind(player, 60);
         SymbioteLog.event("SCENE_START type=graft_refused player={} primary={}", player.getUUID(), primary);
         VoiceLines.sendAs(player, "symbiote.voice.graft_refused", 3, primary);
         TendrilFxEntity.spawnBurst(level, player, 25, primary, true);
      }
   }

   private static void tickGraftRefused(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 20) {
         for (int i = 0; i < 3; i++) {
            TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(
               level, player.position().add(0.0, 1.0, 0.0), s.sourcePos, 22, s.strain, 0.5F + i * 0.15F, (float)(i * 2.1)
            );
            fx.setReachTicksOverride(4);
            fx.scheduleRetract(12);
         }

         level.playSound(
            null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_STRIKE.get(), SoundSource.PLAYERS, 1.0F, 0.7F
         );
      }

      if (s.currentTick == 40 && !s.resolved) {
         BlockPos sp = BlockPos.containing(s.sourcePos);
         if (level.getBlockState(sp).getBlock() instanceof DormantSampleBlock) {
            level.levelEvent(2001, sp, Block.getId(level.getBlockState(sp)));
            level.removeBlock(sp, false);
         }

         level.playSound(null, sp, (SoundEvent)ModSounds.REJECTION.get(), SoundSource.BLOCKS, 0.9F, 1.1F);
         player.setInvulnerable(false);
         SymbioteLog.event("SCENE_RESOLVE type=graft_refused player={} action=fragment_killed", player.getUUID());
         s.resolved = true;
      }
   }

   public static void startSleepTakeover(ServerPlayer player, ServerLevel level) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.SLEEP_TAKEOVER, level.getGameTime(), 100, null, null);
         ACTIVE.put(player.getUUID(), s);
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         applyImmobilizeNoBlind(player, 100);
         VoiceLines.send(player, "symbiote.voice.sleep_takeover", 3);
         SymbioteLog.event("SCENE_START type=sleep_takeover player={}", player.getUUID());
         spawnEruptionWave(player, level, 1);
      }
   }

   public static void startRevivalCocoon(ServerPlayer player, ServerLevel level) {
      if (!ACTIVE.containsKey(player.getUUID())) {
         TendrilSceneController.Scene s = new TendrilSceneController.Scene(TendrilSceneController.SceneType.REVIVAL_COCOON, level.getGameTime(), 35, null, null);
         ACTIVE.put(player.getUUID(), s);
         VoiceLines.send(player, "symbiote.voice.revival", 3);
         ModNetwork.sendOverrideFx(player, "bond_up", 35);
         SymbioteLog.event("SCENE_START type=revival_cocoon player={}", player.getUUID());
         spawnCocoonWave(player, level);
      }
   }

   public static void tickAll(ServerLevel level) {
      for (Entry<UUID, TendrilSceneController.Scene> e : List.copyOf(ACTIVE.entrySet())) {
         UUID id = e.getKey();
         TendrilSceneController.Scene s = e.getValue();
         ServerPlayer player = level.getServer().getPlayerList().getPlayer(id);
         if (player != null && player.isAlive()) {
            if (player.serverLevel() == level) {
               s.currentTick++;
               switch (s.type) {
                  case CONSUMPTION:
                     tickConsumption(player, level, s);
                     break;
                  case REJECTION:
                     tickRejection(player, level, s);
                     break;
                  case REVIVAL_COCOON:
                     tickRevivalCocoon(player, level, s);
                     break;
                  case BONDING_RITUAL:
                     tickBondingRitual(player, level, s);
                     break;
                  case SLEEP_TAKEOVER:
                     tickSleepTakeover(player, level, s);
                     break;
                  case REBOND:
                     tickRebond(player, level, s);
                     break;
                  case RECLAIM:
                     tickReclaim(player, level, s);
                     break;
                  case GRAFT_RITUAL:
                     tickGraftRitual(player, level, s);
                     break;
                  case GRAFT_REFUSED:
                     tickGraftRefused(player, level, s);
                     break;
                  case GRAFT_PURGE:
                     tickGraftPurge(player, level, s);
               }

               if (s.currentTick >= s.lifetimeTicks || s.resolved) {
                  releaseSampleClaim(s);
                  ACTIVE.remove(id, s);
               }
            }
         } else {
            releaseSampleClaim(s);
            ACTIVE.remove(id, s);
         }
      }
   }

   private static void tickConsumption(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p != null) {
         if (s.currentTick == 25) {
            spawnEruptionWave(player, level, 2);
         }

         if (s.currentTick == 50) {
            spawnEruptionWave(player, level, 3);
         }

         if (s.currentTick == 28 || s.currentTick == 56) {
            level.playSound(
               null,
               player.getX(),
               player.getY(),
               player.getZ(),
               (SoundEvent)ModSounds.CONSUMPTION.get(),
               SoundSource.PLAYERS,
               1.0F,
               s.currentTick == 56 ? 0.92F : 1.0F
            );
         }

         if (s.currentTick == 75 && !s.resolved) {
            player.setInvulnerable(false);
            PlayerDeathListener.markSymbioteKill(player.getUUID());
            deliverKill(player, level);
            SymbioteLog.event("SCENE_RESOLVE type=consumption player={} action=kill", player.getUUID());
            s.resolved = true;
         }
      }
   }

   private static void tickRejection(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 15) {
         spawnRejectionLash(player, level, s.sourcePos);
      }

      if (s.currentTick == 25) {
         Vec3 dir = player.position().subtract(s.sourcePos).normalize();
         if (dir.lengthSqr() < 1.0E-4) {
            dir = new Vec3(0.0, 0.5, 0.0);
         }

         player.push(dir.x * 1.5, 0.6, dir.z * 1.5);
         player.hurtMarked = true;
      }

      if (s.currentTick == 45 && !s.resolved) {
         player.setInvulnerable(false);
         PlayerDeathListener.markSymbioteKill(player.getUUID());
         deliverKill(player, level);
         SymbioteLog.event("SCENE_RESOLVE type=rejection player={} action=kill", player.getUUID());
         s.resolved = true;
      }
   }

   private static void tickBondingRitual(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 20) {
         spawnBondingTendrilsWave(level, s.sourcePos, player, s.strain, s.lifetimeTicks - s.currentTick, 3, (float) (Math.PI / 3));
         ModNetwork.sendOverrideFx(player, "vignette_black", 25);
      }

      if (s.currentTick == 40) {
         player.setNoGravity(true);
         player.setDeltaMovement(0.0, 0.22, 0.0);
         player.hurtMarked = true;
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.9F, 0.8F);
      }

      if (s.currentTick >= 40 && s.currentTick < 60) {
         Vec3 dm = player.getDeltaMovement();
         player.setDeltaMovement(0.0, Math.max(dm.y, 0.0), 0.0);
         player.hurtMarked = true;
         player.fallDistance = 0.0F;
      }

      if (s.currentTick >= 60 && s.currentTick < 150) {
         player.setDeltaMovement(0.0, 0.0, 0.0);
         player.hurtMarked = true;
         player.fallDistance = 0.0F;
      }

      if (s.currentTick == 100) {
         double rejectChance = (Double)SymbioteConfig.REJECTION_CHANCE.get();
         s.rejectionRolled = RITUAL_RANDOM.nextDouble() < rejectChance;
         if (s.rejectionRolled) {
            VoiceLines.send(player, "symbiote.voice.rejection", 3);
            ModNetwork.sendOverrideFx(player, "rejection", 60);
            level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.REJECTION.get(), SoundSource.PLAYERS, 1.0F, 1.0F);
            SymbioteLog.event("BONDING_RITUAL_ROLL player={} outcome=reject threshold={}", player.getUUID(), rejectChance);
         } else {
            VoiceLines.send(player, "symbiote.voice.bond_attached", 1);
            ModNetwork.sendOverrideFx(player, "bond_up", 60);
            SymbioteLog.event("BONDING_RITUAL_ROLL player={} outcome=bond strain={} threshold={}", player.getUUID(), s.strain, rejectChance);
         }
      }

      if (s.currentTick == 140 && !s.resolved) {
         player.setNoGravity(false);
         player.setInvulnerable(false);
         player.fallDistance = 0.0F;
         BlockPos samplePos = BlockPos.containing(s.sourcePos);
         BlockState sampleState = level.getBlockState(samplePos);
         if (sampleState.getBlock() instanceof DormantSampleBlock) {
            level.levelEvent(2001, samplePos, Block.getId(sampleState));
            level.removeBlock(samplePos, false);
         }

         if (s.rejectionRolled) {
            deliverKill(player, level);
            SymbioteLog.event("SCENE_RESOLVE type=bonding_ritual player={} action=reject_kill", player.getUUID());
         } else {
            BondingFlow.attemptBond(player, level, true, s.strain);
            SymbioteLog.event("SCENE_RESOLVE type=bonding_ritual player={} action=bond strain={}", player.getUUID(), s.strain);
         }

         s.resolved = true;
      }
   }

   private static void tickSleepTakeover(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 30) {
         spawnEruptionWave(player, level, 2);
         ModNetwork.sendOverrideFx(player, "vignette_black", 70);
      }

      if (s.currentTick == 60) {
         SymbioteTracker.adjustStress(level, player, -30, "stress_release_takeover");
      }

      if (s.currentTick == 95 && !s.resolved) {
         player.setInvulnerable(false);
         VoiceLines.send(player, "symbiote.voice.sleep_takeover_end", 0);
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         boolean hunting = false;
         if (p != null && p.isStarving() && !SymbioteFeedingHunt.isHunting(player.getUUID())) {
            hunting = SymbioteFeedingHunt.start(player, level, p);
            if (hunting) {
               OverrideGate.stamp(level, p);
            }
         }

         SymbioteLog.event("SCENE_RESOLVE type=sleep_takeover player={} action=release hunting={}", player.getUUID(), hunting);
         s.resolved = true;
      }
   }

   private static void tickRevivalCocoon(ServerPlayer player, ServerLevel level, TendrilSceneController.Scene s) {
      if (s.currentTick == 10 || s.currentTick == 20) {
         spawnCocoonWave(player, level);
      }
   }

   private static void spawnEruptionWave(ServerPlayer player, ServerLevel level, int waveIdx) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      SymbioteStrain strain = p != null ? p.strain : SymbioteStrain.GUARDIAN;
      TendrilFxEntity.spawnBurst(level, player, 35, strain);
   }

   private static void spawnRejectionLash(ServerPlayer player, ServerLevel level, Vec3 samplePos) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      SymbioteStrain strain = p != null ? p.strain : SymbioteStrain.GUARDIAN;
      TendrilFxEntity.spawnBurst(level, player, 30, strain);
   }

   private static void spawnCocoonWave(ServerPlayer player, ServerLevel level) {
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      SymbioteStrain strain = p != null ? p.strain : SymbioteStrain.GUARDIAN;
      TendrilFxEntity.spawnBurst(level, player, 30, strain);
   }

   private static void applyImmobilize(ServerPlayer player, int durationTicks) {
      player.setInvulnerable(true);
      player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, durationTicks, 6, false, false));
      player.addEffect(new MobEffectInstance(MobEffects.BLINDNESS, durationTicks, 0, false, false));
   }

   private static void applyImmobilizeNoBlind(ServerPlayer player, int durationTicks) {
      player.setInvulnerable(true);
      player.addEffect(new MobEffectInstance(MobEffects.MOVEMENT_SLOWDOWN, durationTicks, 6, false, false));
   }

   private static void spawnBondingTendrilsWave(
      ServerLevel level, Vec3 origin, ServerPlayer player, SymbioteStrain strain, int lifetimeTicks, int count, float startOffsetRad
   ) {
      SymbioteStrain s = strain != null ? strain : SymbioteStrain.GUARDIAN;
      level.playSound(null, origin.x, origin.y, origin.z, (SoundEvent)ModSounds.TENDRIL_EXTEND.get(), SoundSource.BLOCKS, 0.9F, 0.75F);
      float arcAmplitude = 0.45F;
      float fullCircle = (float) (Math.PI * 2);

      for (int i = 0; i < count; i++) {
         float angle = startOffsetRad + fullCircle * i / count;
         TendrilFxEntity.spawnGrabFromBlock(level, origin, player, lifetimeTicks, s, arcAmplitude, angle);
      }
   }

   private static void deliverKill(ServerPlayer player, ServerLevel level) {
      HealthGuard.repair(player);
      player.hurt(level.damageSources().generic(), HealthGuard.lethal(player));
      UNRESOLVED_KILL.put(player.getUUID(), level.getGameTime());
   }

   private static void drain(ServerPlayer player, float amount) {
      HealthGuard.repair(player);
      float health = HealthGuard.finite(player.getHealth(), 1.0F);
      player.setHealth(Math.max(1.0F, health - amount));
   }

   public static void tickUnresolvedKills(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      Long dealt = UNRESOLVED_KILL.get(player.getUUID());
      if (dealt != null) {
         if (!player.isAlive()) {
            UNRESOLVED_KILL.remove(player.getUUID());
         } else if (now - dealt >= 40L) {
            UNRESOLVED_KILL.remove(player.getUUID());
            HealthGuard.repairAndLog(player);
            ACTIVE.remove(player.getUUID());
            if (p != null && p.stage.isBonded()) {
               SymbioteTracker.onUnbond(level, player, "kill_cancelled_by_other_mod");
               SymbioteLog.event("SCENE_KILL_CANCELLED player={} action=detached_anyway", player.getUUID());
            }
         }
      }
   }

   public static void forgetUnresolved(UUID id) {
      UNRESOLVED_KILL.remove(id);
   }

   public static boolean isInScene(UUID player) {
      return ACTIVE.containsKey(player);
   }

   public static void clear(UUID player) {
      TendrilSceneController.Scene s = ACTIVE.remove(player);
      if (s != null) {
         releaseSampleClaim(s);
      }
   }

   private TendrilSceneController() {
   }

   public static final class Scene {
      public final TendrilSceneController.SceneType type;
      public final long startTick;
      public final int lifetimeTicks;
      public int currentTick;
      public boolean resolved;
      public final Vec3 sourcePos;
      public final SymbioteStrain strain;
      public boolean rejectionRolled;
      public SymbioteStrain strain2;

      Scene(TendrilSceneController.SceneType type, long startTick, int lifetimeTicks, Vec3 sourcePos, SymbioteStrain strain) {
         this.type = type;
         this.startTick = startTick;
         this.lifetimeTicks = lifetimeTicks;
         this.currentTick = 0;
         this.resolved = false;
         this.sourcePos = sourcePos;
         this.strain = strain;
      }
   }

   public enum SceneType {
      CONSUMPTION,
      REJECTION,
      REVIVAL_COCOON,
      BONDING_RITUAL,
      SLEEP_TAKEOVER,
      REBOND,
      RECLAIM,
      GRAFT_RITUAL,
      GRAFT_REFUSED,
      GRAFT_PURGE;
   }
}
