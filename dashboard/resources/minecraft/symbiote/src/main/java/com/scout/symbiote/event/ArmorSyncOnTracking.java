package com.scout.symbiote.event;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.PlayerLoggedInEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.StartTracking;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class ArmorSyncOnTracking {
   @SubscribeEvent
   public static void onStartTracking(StartTracking event) {
      if (event.getEntity() instanceof ServerPlayer viewer) {
         if (event.getTarget() instanceof ServerPlayer tracked) {
            SymbioteProfile p = SymbioteTracker.get(tracked.serverLevel()).peek(tracked.getUUID());
            boolean active = p != null && p.stage.isBonded() && p.livingArmorActive;
            boolean covers = p != null && p.armorCoversGear;
            int strain = p != null ? p.strain.ordinal() : 0;
            ModNetwork.sendLivingArmorState(viewer, tracked.getUUID(), active, covers, strain);
         }
      }
   }

   @SubscribeEvent
   public static void onLogin(PlayerLoggedInEvent event) {
      if (event.getEntity() instanceof ServerPlayer self) {
         SymbioteProfile p = SymbioteTracker.get(self.serverLevel()).peek(self.getUUID());
         boolean active = p != null && p.stage.isBonded() && p.livingArmorActive;
         boolean covers = p != null && p.armorCoversGear;
         int strain = p != null ? p.strain.ordinal() : 0;
         ModNetwork.sendLivingArmorState(self, self.getUUID(), active, covers, strain);
      }
   }

   private ArmorSyncOnTracking() {
   }
}
