package com.scout.symbiote.client;

import com.google.common.reflect.TypeToken;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.context.ContextKey;
import net.minecraft.world.entity.Entity;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.common.EventBusSubscriber.Bus;
import net.neoforged.neoforge.client.renderstate.RegisterRenderStateModifiersEvent;

/**
 * 1.21.4 renders entities from a per-frame render-state snapshot instead of the entity. The Forge 1.20.1 layers and
 * render hooks read the entity itself (UUID, inventory, persistent data, synced client state), so every render state
 * carries a reference back to the entity it was extracted from.
 */
@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT, bus = Bus.MOD)
public final class RenderStateBridge {
   public static final ContextKey<Entity> ENTITY = new ContextKey<>(ResourceLocation.fromNamespaceAndPath("symbiote", "entity"));

   @SubscribeEvent
   public static void onRegisterModifiers(RegisterRenderStateModifiersEvent event) {
      event.registerEntityModifier(new TypeToken<EntityRenderer<Entity, EntityRenderState>>() {}, (entity, state) -> state.setRenderData(ENTITY, entity));
   }

   public static Entity entity(EntityRenderState state) {
      return state.getRenderData(ENTITY);
   }

   public static AbstractClientPlayer player(PlayerRenderState state) {
      if (entity(state) instanceof AbstractClientPlayer p) {
         return p;
      }

      Minecraft mc = Minecraft.getInstance();
      if (mc.level == null) {
         return null;
      }

      return mc.level.getEntity(state.id) instanceof AbstractClientPlayer p ? p : null;
   }

   private RenderStateBridge() {
   }
}
