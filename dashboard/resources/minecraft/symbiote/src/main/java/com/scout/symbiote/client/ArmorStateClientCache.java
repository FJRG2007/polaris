package com.scout.symbiote.client;

import com.scout.symbiote.tracker.SymbioteStrain;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingIn;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingOut;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class ArmorStateClientCache {
   private static final Map<UUID, Boolean> ACTIVE = new HashMap<>();
   private static final Map<UUID, Boolean> COVERS = new HashMap<>();
   private static final Map<UUID, SymbioteStrain> STRAIN = new HashMap<>();

   public static void set(UUID playerId, boolean active, boolean coversGear, int strainOrdinal) {
      if (active) {
         ACTIVE.put(playerId, Boolean.TRUE);
      } else {
         ACTIVE.remove(playerId);
      }

      if (coversGear) {
         COVERS.put(playerId, Boolean.TRUE);
      } else {
         COVERS.remove(playerId);
      }

      SymbioteStrain[] strains = SymbioteStrain.values();
      if (active && strainOrdinal >= 0 && strainOrdinal < strains.length) {
         STRAIN.put(playerId, strains[strainOrdinal]);
      } else {
         STRAIN.remove(playerId);
      }
   }

   public static SymbioteStrain strainOf(UUID playerId) {
      return STRAIN.getOrDefault(playerId, SymbioteStrain.GUARDIAN);
   }

   public static boolean coversGear(UUID playerId) {
      return COVERS.getOrDefault(playerId, Boolean.FALSE);
   }

   public static void flipCoversLocal(UUID playerId) {
      if (coversGear(playerId)) {
         COVERS.remove(playerId);
      } else {
         COVERS.put(playerId, Boolean.TRUE);
      }
   }

   public static boolean isActive(UUID playerId) {
      return ACTIVE.getOrDefault(playerId, Boolean.FALSE);
   }

   public static void clear() {
      ACTIVE.clear();
      COVERS.clear();
      STRAIN.clear();
   }

   @SubscribeEvent
   public static void onLoggingOut(LoggingOut event) {
      clear();
   }

   @SubscribeEvent
   public static void onLoggingIn(LoggingIn event) {
      clear();
   }

   private ArmorStateClientCache() {
   }
}
