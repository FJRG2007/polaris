package com.scout.symbiote.tracker;

import com.scout.symbiote.ability.StrainPersona;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.saveddata.SavedData;

public class SymbioteTracker extends SavedData {
   private static final String DATA_NAME = "symbiote_tracker";
   private final Map<UUID, SymbioteProfile> profiles = new HashMap<>();

   public static SymbioteTracker get(ServerLevel level) {
      return (SymbioteTracker)level.getServer().overworld().getDataStorage().computeIfAbsent(new SavedData.Factory<>(SymbioteTracker::new, SymbioteTracker::load), "symbiote_tracker");
   }

   public SymbioteProfile getOrCreate(UUID id) {
      return this.profiles.computeIfAbsent(id, k -> {
         this.setDirty();
         return new SymbioteProfile();
      });
   }

   public SymbioteProfile peek(UUID id) {
      return this.profiles.get(id);
   }

   public void restoreProfile(UUID id, SymbioteProfile p) {
      this.profiles.put(id, p);
      this.setDirty();
   }

   public Map<UUID, SymbioteProfile> all() {
      return this.profiles;
   }

   public CompoundTag save(CompoundTag tag, HolderLookup.Provider registries) {
      CompoundTag players = new CompoundTag();

      for (Entry<UUID, SymbioteProfile> e : this.profiles.entrySet()) {
         players.put(e.getKey().toString(), e.getValue().toNbt(registries));
      }

      tag.put("players", players);
      return tag;
   }

   public static SymbioteTracker load(CompoundTag tag, HolderLookup.Provider registries) {
      SymbioteTracker t = new SymbioteTracker();
      CompoundTag players = tag.getCompound("players");

      for (String key : players.getAllKeys()) {
         try {
            UUID id = UUID.fromString(key);
            t.profiles.put(id, SymbioteProfile.fromNbt(players.getCompound(key), registries));
         } catch (IllegalArgumentException var6) {
         }
      }

      return t;
   }

   public static void adjustBond(ServerLevel level, ServerPlayer player, int delta, String cause) {
      if (delta != 0) {
         SymbioteTracker t = get(level);
         SymbioteProfile p = t.getOrCreate(player.getUUID());
         if (p.stage.isBonded()) {
            int oldBond = p.bond;
            BondStage oldStage = p.stage;
            p.addBond(delta);
            if (delta > 0) {
               p.lastBondGainTick = level.getGameTime();
               t.setDirty();
            }

            if (p.bond != oldBond) {
               SymbioteLog.valueChange(player.getUUID(), "bond", oldBond, p.bond, cause);
               t.setDirty();
               ModNetwork.syncToPlayer(level, player);
            }
         }
      }
   }

   public static void adjustTrust(ServerLevel level, ServerPlayer player, int delta, String cause) {
      if (delta != 0) {
         SymbioteTracker t = get(level);
         SymbioteProfile p = t.getOrCreate(player.getUUID());
         if (p.stage.isBonded()) {
            if (delta > 0) {
               if (TrustRework.live()) {
                  if (p.trust >= 90) {
                     delta = Math.max(1, delta / 4);
                  } else if (p.trust >= 70) {
                     delta = Math.max(1, delta / 2);
                  }
               }

               p.lastTrustGainTick = level.getGameTime();
            }

            int old = p.trust;
            p.addTrust(delta);
            if (p.trust != old) {
               SymbioteLog.valueChange(player.getUUID(), "trust", old, p.trust, cause);
               t.setDirty();
               ModNetwork.syncToPlayer(level, player);
            }
         }
      }
   }

   public static void adjustStress(ServerLevel level, ServerPlayer player, int delta, String cause) {
      if (delta != 0) {
         SymbioteTracker t = get(level);
         SymbioteProfile p = t.getOrCreate(player.getUUID());
         if (p.stage.isBonded()) {
            int old = p.stress;
            p.addStress(delta);
            if (p.stress != old) {
               SymbioteLog.valueChange(player.getUUID(), "stress", old, p.stress, cause);
               t.setDirty();
               ModNetwork.syncToPlayer(level, player);
            }
         }
      }
   }

   public static void adjustHunger(ServerLevel level, ServerPlayer player, int delta, String cause) {
      if (delta != 0) {
         SymbioteTracker t = get(level);
         SymbioteProfile p = t.getOrCreate(player.getUUID());
         if (p.stage.isBonded()) {
            int old = p.hunger;
            p.addHunger(delta);
            if (p.hunger != old) {
               SymbioteLog.valueChange(player.getUUID(), "hunger", old, p.hunger, cause);
               t.setDirty();
               ModNetwork.syncToPlayer(level, player);
            }
         }
      }
   }

   public static void onBond(ServerLevel level, ServerPlayer player) {
      onBond(level, player, SymbioteStrain.GUARDIAN);
   }

   public static void onBond(ServerLevel level, ServerPlayer player, SymbioteStrain strain) {
      SymbioteTracker t = get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());
      p.onBond(level.getGameTime(), strain);
      SymbioteLog.event("BOND_ATTACHED player={} stage={} strain={} instability_until={}", player.getUUID(), p.stage, p.strain, p.instabilityUntilTick);
      t.setDirty();
      ModNetwork.syncToPlayer(level, player);
   }

   public static void onUnbond(ServerLevel level, ServerPlayer player, String reason) {
      SymbioteTracker t = get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());
      p.onUnbond();
      VoiceLines.onLogout(player.getUUID());
      StrainPersona.onLogout(player.getUUID());
      player.refreshDimensions();
      SymbioteLog.event("BOND_REMOVED player={} reason={}", player.getUUID(), reason);
      t.setDirty();
      ModNetwork.syncToPlayer(level, player);
   }

   public static void enterDormancy(ServerLevel level, ServerPlayer player, long ticks, String reason) {
      SymbioteTracker t = get(level);
      SymbioteProfile p = t.getOrCreate(player.getUUID());
      p.enterDormancy(level.getGameTime(), ticks);
      player.refreshDimensions();
      SymbioteLog.event("DORMANCY_START player={} ticks={} until={} reason={}", player.getUUID(), ticks, p.dormantUntilTick, reason);
      t.setDirty();
      ModNetwork.syncToPlayer(level, player);
      ModNetwork.broadcastLivingArmorState(player, false);
   }
}
