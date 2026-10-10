package com.scout.symbiote.client.armor;

import net.minecraft.util.ARGB;
import com.mojang.blaze3d.vertex.PoseStack;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.client.render.VanillaSheen;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.geom.EntityModelSet;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.HumanoidArm;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderArmEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class FirstPersonArmorHandler {
   private static float fpProgress = 0.0F;
   private static final float FP_STEP = 0.08F;
   private static LivingArmorModel classic;

   @SubscribeEvent
   public static void onClientTick(ClientTickEvent.Post event) {
      if (true) {
         boolean on = SymbioteClientState.isBonded() && SymbioteClientState.isLivingArmorActive();
         float target = on ? 1.0F : 0.0F;
         if (fpProgress != target) {
            fpProgress = Mth.clamp(fpProgress + Math.signum(target - fpProgress) * 0.08F, 0.0F, 1.0F);
         }
      }
   }

   @SubscribeEvent
   public static void onRenderArm(RenderArmEvent event) {
      Minecraft mc = Minecraft.getInstance();
      if (mc.player != null) {
         AbstractClientPlayer player = event.getPlayer();
         if (!player.isInvisible()) {
            if (SymbioteClientState.isBonded()) {
               float progress = fpProgress;
               if (!(progress <= 0.001F)) {
                  LivingArmorModel m = model();
                  if (m != null) {
                     SymbioteStrain strain = SymbioteClientState.getStrain();
                     PoseStack pose = event.getPoseStack();
                     MultiBufferSource buffers = event.getMultiBufferSource();
                     int light = event.getPackedLight();
                     boolean right = event.getArm() == HumanoidArm.RIGHT;
                     m.resetPose();
                     ModelPart arm = right ? m.rightArm : m.leftArm;
                     arm.xRot = 0.0F;
                     arm.yRot = 0.0F;
                     arm.zRot = 0.0F;
                     boolean formed = progress >= 0.99F;
                     if (formed) {
                        event.setCanceled(true);
                     }

                     arm.render(
                        pose,
                        new VanillaSheen.Consumer(
                           buffers.getBuffer(
                              formed
                                 ? RenderType.armorCutoutNoCull(LivingArmorRenderLayer.baseTexture(strain))
                                 : RenderType.entityTranslucent(LivingArmorRenderLayer.baseTexture(strain))
                           ),
                           15.0F,
                           0.5F
                        ),
                        light,
                        OverlayTexture.NO_OVERLAY,
                        ARGB.colorFromFloat(formed ? 1.0F : progress, 1.0F, 1.0F, 1.0F));
                     float pulse = Mth.clamp(progress * (0.72F + Mth.sin(player.tickCount * 0.33F) * 0.18F), 0.18F, 1.0F);
                     arm.render(
                        pose,
                        buffers.getBuffer(RenderType.eyes(LivingArmorRenderLayer.emissiveTexture(strain))),
                        light,
                        OverlayTexture.NO_OVERLAY,
                        ARGB.colorFromFloat(1.0F, pulse, pulse, pulse));
                  }
               }
            }
         }
      }
   }

   private static LivingArmorModel model() {
      EntityModelSet set = Minecraft.getInstance().getEntityModels();
      if (set == null) {
         return null;
      }

      if (LivingArmorModel.horrorForm) {
         return HorrorFormModels.get();
      }

      if (classic == null) {
         classic = new LivingArmorModel(set.bakeLayer(LivingArmorModel.LAYER_LOCATION));
      }

      return classic;
   }

   private FirstPersonArmorHandler() {
   }
}
