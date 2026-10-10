package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModItems;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ItemLike;

public final class SymbioteMolt {
   public static final boolean MOLT_VAULTED = true;
   private static final int MOLT_DURATION_TICKS = 2400;
   private static final int ITCH_PERIOD = 400;

   public static boolean isMolting(SymbioteProfile p, long now) {
      return false;
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
   }

   private static void start(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      p.moltingUntil = now + 2400L;
      if (p.livingArmorActive) {
         p.livingArmorActive = false;
         player.refreshDimensions();
         level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.ARMOR_OFF.get(), SoundSource.PLAYERS, 0.7F, 0.8F);
         ModNetwork.broadcastLivingArmorState(player, false);
      }

      VoiceLines.send(player, "symbiote.voice.molt_start", 4);
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("MOLT_START player={} until={}", player.getUUID(), p.moltingUntil);
   }

   private static void shed(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      p.moltingUntil = 0L;
      p.nextMoltTick = now + interval(level);
      int count = 1 + (level.random.nextFloat() < 0.35F ? 1 : 0);

      for (int i = 0; i < count; i++) {
         player.drop(new ItemStack((ItemLike)ModItems.BIOMASS.get()), false);
      }

      level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_RETRACT.get(), SoundSource.PLAYERS, 0.9F, 0.7F);
      TendrilFxEntity.spawnBurst(level, player, 20, p.strain);
      SymbioteTracker.adjustStress(level, player, -20, "stress_molt_relief");
      VoiceLines.send(player, "symbiote.voice.molt_done", 1);
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      SymbioteLog.event("MOLT_SHED player={} biomass={} nextMolt={}", player.getUUID(), count, p.nextMoltTick);
   }

   private static long interval(ServerLevel level) {
      long base = SymbioteConfig.MOLT_INTERVAL_TICKS.get().intValue();
      return (long)(base * (0.75 + level.random.nextDouble() * 0.5));
   }

   private SymbioteMolt() {
   }
}
