package com.scout.symbiote.client.entity;

import net.minecraft.client.renderer.entity.EntityRendererProvider.Context;
import net.minecraft.client.renderer.entity.ZombieRenderer;
import net.minecraft.client.renderer.entity.state.ZombieRenderState;
import net.minecraft.resources.ResourceLocation;

/** The vanilla zombie renderer (model, baby model and armor layers) with the infected skin. */
public class InfectedZombieRenderer extends ZombieRenderer {
   private static final ResourceLocation TEXTURE = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/infected_zombie.png");

   public InfectedZombieRenderer(Context ctx) {
      super(ctx);
   }

   @Override
   public ResourceLocation getTextureLocation(ZombieRenderState state) {
      return TEXTURE;
   }
}
