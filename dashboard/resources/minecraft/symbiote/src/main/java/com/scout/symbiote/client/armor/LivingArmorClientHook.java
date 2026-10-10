package com.scout.symbiote.client.armor;

import net.minecraft.client.resources.PlayerSkin;
import com.scout.symbiote.client.MantleBodyAnchor;
import com.scout.symbiote.client.bloom.BloomRenderLayer;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.EntityRenderersEvent.AddLayers;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.common.EventBusSubscriber.Bus;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT, bus = Bus.MOD)
public final class LivingArmorClientHook {
   @SubscribeEvent
   public static void onAddLayers(AddLayers event) {
      for (PlayerSkin.Model skin : event.getSkins()) {
         if (event.getSkin(skin) instanceof PlayerRenderer player) {
            player.addLayer(new LivingArmorRenderLayer(player, event.getEntityModels()));
            player.addLayer(new BloomRenderLayer(player));
            player.addLayer(new MantleBodyAnchor.Layer(player));
         }
      }
   }

   private LivingArmorClientHook() {
   }
}
