package com.scout.symbiote.client.armor;

import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.client.RenderStateBridge;
import com.scout.symbiote.client.SymbioteClientState;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Pre;

/**
 * Hides worn gear while a gear-covering living armor is on. Forge 1.20.1 emptied the armor slots for the duration of
 * the render; 1.21.4 renders from a per-frame snapshot, so the snapshot's equipment is cleared instead and the
 * inventory is never touched.
 */
@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class ArmorHideHandler {
   @SubscribeEvent(priority = EventPriority.HIGHEST)
   public static void onRenderPre(Pre event) {
      PlayerRenderState state = event.getRenderState();
      AbstractClientPlayer player = RenderStateBridge.player(state);
      if (player == null) {
         return;
      }

      if ((ArmorStateClientCache.isActive(player.getUUID()) || isLocalActive(player)) && ArmorStateClientCache.coversGear(player.getUUID())) {
         state.headEquipment = ItemStack.EMPTY;
         state.chestEquipment = ItemStack.EMPTY;
         state.legsEquipment = ItemStack.EMPTY;
         state.feetEquipment = ItemStack.EMPTY;
         state.headItem.clear();
         state.wornHeadType = null;
         state.wornHeadProfile = null;
      }
   }

   private static boolean isLocalActive(Player player) {
      Minecraft mc = Minecraft.getInstance();
      return player == mc.player && SymbioteClientState.isLivingArmorActive();
   }

   private ArmorHideHandler() {
   }
}
