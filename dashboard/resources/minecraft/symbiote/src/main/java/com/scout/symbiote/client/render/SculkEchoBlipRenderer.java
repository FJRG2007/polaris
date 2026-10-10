package com.scout.symbiote.client.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import com.scout.symbiote.client.SculkGlowClient;
import com.scout.symbiote.client.ShaderDetect;
import com.scout.symbiote.config.SymbioteConfig;
import java.util.Map;
import java.util.Map.Entry;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderGuiEvent.Pre;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent.Stage;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import org.joml.Matrix4f;
import org.joml.Vector4f;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class SculkEchoBlipRenderer {
   private static final int OUTER_RGB = 3654840;
   private static final int CORE_RGB = 14286840;
   private static final float FADE_TICKS = 15.0F;
   private static final float SIZE_BASE = 46.0F;
   private static final float SIZE_MIN = 3.0F;
   private static final float SIZE_MAX = 13.0F;
   private static Matrix4f viewMatrix;
   private static Matrix4f projMatrix;
   private static Vec3 camPos;
   private static float partialTick;

   @SubscribeEvent
   public static void onRenderLevelStage(RenderLevelStageEvent event) {
      if (event.getStage() == Stage.AFTER_PARTICLES) {
         if (SculkGlowClient.litView().isEmpty()) {
            viewMatrix = null;
         } else {
            viewMatrix = new Matrix4f(event.getPoseStack().last().pose());
            projMatrix = new Matrix4f(event.getProjectionMatrix());
            camPos = event.getCamera().getPosition();
            partialTick = event.getPartialTick().getGameTimeDeltaPartialTick(false);
         }
      }
   }

   @SubscribeEvent
   public static void onRenderGui(Pre event) {
      if (viewMatrix != null) {
         if (ShaderDetect.shadersActive()) {
            if ((Boolean)SymbioteConfig.SCULK_ECHO_BLIPS.get()) {
               Map<Integer, Long> lit = SculkGlowClient.litView();
               if (!lit.isEmpty()) {
                  Minecraft mc = Minecraft.getInstance();
                  if (mc.level != null && !mc.options.hideGui) {
                     GuiGraphics g = event.getGuiGraphics();
                     long now = mc.level.getGameTime();
                     float breathe = 0.55F + 0.45F * (float)Math.sin(((float)now + partialTick) * 0.25);
                     int sw = g.guiWidth();
                     int sh = g.guiHeight();

                     for (Entry<Integer, Long> e : lit.entrySet()) {
                        long remaining = e.getValue() - now;
                        if (remaining > 0L) {
                           Entity ent = mc.level.getEntity(e.getKey());
                           if (ent != null && ent.isAlive()) {
                              Vec3 pos = ent.getPosition(partialTick).add(0.0, ent.getBbHeight() * 0.55, 0.0);
                              Vector4f clip = new Vector4f(
                                 (float)(pos.x - camPos.x),
                                 (float)(pos.y - camPos.y),
                                 (float)(pos.z - camPos.z),
                                 1.0F
                              );
                              clip.mul(viewMatrix).mul(projMatrix);
                              if (!(clip.w <= 0.05F)) {
                                 float sx = (clip.x / clip.w * 0.5F + 0.5F) * sw;
                                 float sy = (1.0F - (clip.y / clip.w * 0.5F + 0.5F)) * sh;
                                 double dist = pos.distanceTo(camPos);
                                 float size = Math.max(3.0F, Math.min(13.0F, (float)(46.0 / Math.max(1.0, dist))));
                                 float fade = Math.min(1.0F, (float)remaining / 15.0F);
                                 int alphaOuter = (int)((0.3F + 0.45F * breathe) * fade * 255.0F) & 0xFF;
                                 int alphaCore = Math.min(255, alphaOuter + 64);
                                 PoseStack ps = g.pose();
                                 ps.pushPose();
                                 ps.translate(sx, sy, 0.0F);
                                 ps.mulPose(Axis.ZP.rotationDegrees(45.0F));
                                 int s = Math.round(size);
                                 int c = Math.max(1, Math.round(size * 0.38F));
                                 g.fill(-s, -s, s, s, alphaOuter << 24 | 3654840);
                                 g.fill(-c, -c, c, c, alphaCore << 24 | 14286840);
                                 ps.popPose();
                              }
                           }
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private SculkEchoBlipRenderer() {
   }
}
