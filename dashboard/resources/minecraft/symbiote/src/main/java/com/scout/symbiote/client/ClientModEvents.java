package com.scout.symbiote.client;

import com.scout.symbiote.client.armor.LivingArmorModel;
import com.scout.symbiote.client.entity.InfectedZombieRenderer;
import com.scout.symbiote.client.entity.TendrilFxRenderer;
import com.scout.symbiote.client.screen.ArmSlotsScreen;
import com.scout.symbiote.registry.ModBlockEntities;
import com.scout.symbiote.registry.ModEntities;
import com.scout.symbiote.registry.ModMenus;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.renderer.entity.NoopRenderer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.common.EventBusSubscriber.Bus;
import net.neoforged.neoforge.client.event.EntityRenderersEvent.RegisterLayerDefinitions;
import net.neoforged.neoforge.client.event.EntityRenderersEvent.RegisterRenderers;
import net.neoforged.neoforge.client.event.RegisterGuiLayersEvent;
import net.neoforged.neoforge.client.event.RegisterKeyMappingsEvent;
import net.neoforged.neoforge.client.event.RegisterMenuScreensEvent;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT, bus = Bus.MOD)
public final class ClientModEvents {
   @SubscribeEvent
   public static void onRegisterOverlays(RegisterGuiLayersEvent event) {
      SymbioteHudOverlay.register(event);
   }

   @SubscribeEvent
   public static void onRegisterMenuScreens(RegisterMenuScreensEvent event) {
      event.register(ModMenus.ARM_SLOTS.get(), ArmSlotsScreen::new);
   }

   @SubscribeEvent
   public static void onRegisterKeyMappings(RegisterKeyMappingsEvent event) {
      for (KeyMapping km : SymbioteKeybinds.ALL) {
         event.register(km);
      }
   }

   @SubscribeEvent
   public static void onRegisterRenderers(RegisterRenderers event) {
      event.registerEntityRenderer(ModEntities.TENDRIL_FX.get(), TendrilFxRenderer::new);
      event.registerEntityRenderer(ModEntities.INFECTED_ZOMBIE.get(), InfectedZombieRenderer::new);
      event.registerEntityRenderer(ModEntities.NAVIGATOR.get(), NoopRenderer::new);
      event.registerBlockEntityRenderer(ModBlockEntities.DORMANT_SAMPLE.get(), DormantSampleRenderer::new);
      event.registerBlockEntityRenderer(ModBlockEntities.DEATH_COCOON.get(), DormantSampleRenderer::new);
   }

   @SubscribeEvent
   public static void onRegisterLayerDefinitions(RegisterLayerDefinitions event) {
      event.registerLayerDefinition(LivingArmorModel.LAYER_LOCATION, LivingArmorModel::createBodyLayer);
      event.registerLayerDefinition(LivingArmorModel.HORROR_LAYER_LOCATION, LivingArmorModel::createHorrorBodyLayer);
   }

   private ClientModEvents() {
   }
}
