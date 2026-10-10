package com.scout.symbiote.client;

import com.scout.symbiote.client.render.Verts;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.blaze3d.vertex.PoseStack.Pose;
import com.mojang.math.Axis;
import com.scout.symbiote.tracker.SymbioteStrain;
import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderHandEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import org.joml.Matrix3f;
import org.joml.Matrix4f;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class HandMorphRenderer {
   public static final String FX_PREFIX = "morph:";
   private static final int RING_SIDES = 8;
   private static final float GROW_TICKS = 6.0F;
   public static float tipX = 0.72F;
   public static float tipY = -0.45F;
   public static float tipZ = -1.06F;
   public static float pitch = 48.0F;
   public static float yaw = -24.0F;
   public static float roll = -4.0F;
   public static float scale = 4.15F;
   private static final float THICK_BASE = 0.024F;
   private static final float THICK_END = 0.004F;
   private static final float BLADE_LEN = 0.42F;
   private static final float CLAW_LEN = 0.26F;
   private static final float SHIELD_LEN = 0.2F;
   private static final float BREATHE = 0.14F;
   private static final float DRIFT = 0.022F;
   private static final float IDLE_SIZE = 0.3F;
   private static final ResourceLocation TEX_WARM = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_predator.png");
   private static final ResourceLocation TEX_COOL = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_guardian.png");
   public static HandMorphRenderer.Form previewForm = null;

   @SubscribeEvent
   public static void onRenderHand(RenderHandEvent event) {
      Minecraft mc = Minecraft.getInstance();
      if (mc.player != null) {
         String fx = null;
         boolean idle = false;
         HandMorphRenderer.Form form;
         if (previewForm != null) {
            form = previewForm;
         } else {
            fx = OverrideFxClient.findActiveWithPrefix("morph:");
            if (fx == null) {
               if (!SymbioteClientState.isGrafted()) {
                  return;
               }

               form = HandMorphRenderer.Form.CLAW;
               idle = true;
            } else {
               try {
                  form = HandMorphRenderer.Form.valueOf(fx.substring("morph:".length()).toUpperCase(Locale.ROOT));
               } catch (IllegalArgumentException e) {
                  return;
               }
            }
         }

         if (event.getHand() == InteractionHand.MAIN_HAND) {
            if (mc.player.getMainHandItem().isEmpty()) {
               float progress = fx == null ? 1.0F : growth(fx);
               if (idle) {
                  progress = 0.3F;
               }

               if (!(progress <= 0.001F)) {
                  PoseStack pose = event.getPoseStack();
                  boolean rightSide = mc.player.getMainArm() == HumanoidArm.RIGHT;
                  int side = rightSide ? 1 : -1;
                  float equip = event.getEquipProgress();
                  float swing = event.getSwingProgress();
                  pose.pushPose();
                  float jab = Mth.sin(swing * (float) Math.PI);
                  float swingDip = Mth.sin(Mth.sqrt(swing) * (float) Math.PI);
                  pose.translate(side * -0.3F * swingDip, -equip * 0.6F + 0.4F * Mth.sin(Mth.sqrt(swing) * (float) Math.PI * 2.0F), -jab * 0.4F);
                  VertexConsumer buf = event.getMultiBufferSource().getBuffer(RenderType.entityCutoutNoCull(texture()));
                  float time = mc.player.tickCount + event.getPartialTick();
                  int light = event.getPackedLight();
                  pose.translate(side * tipX, tipY, tipZ);
                  pose.mulPose(Axis.YP.rotationDegrees(side * yaw));
                  pose.mulPose(Axis.XP.rotationDegrees(pitch));
                  pose.mulPose(Axis.ZP.rotationDegrees(side * roll));
                  Vec3 sprout = Vec3.ZERO;
                  Vec3 drift = new Vec3(Math.sin(time * 0.11) * 0.022F, Math.cos(time * 0.083) * 0.022F * 0.7, Math.sin(time * 0.067) * 0.022F * 0.5);
                  switch (form) {
                     case BLADE:
                        emitBlade(pose, buf, light, progress, time, side, sprout, drift);
                        break;
                     case SHIELD:
                        emitShield(pose, buf, light, progress, time, side, sprout, drift);
                        break;
                     case CLAW:
                        emitClaw(pose, buf, light, progress, time, side, sprout, drift);
                  }

                  pose.popPose();
               }
            }
         }
      }
   }

   private static float growth(String fx) {
      int total = OverrideFxClient.getTotalForActive(fx);
      float frac = OverrideFxClient.getFraction(fx);
      if (total <= 0) {
         return 0.0F;
      }

      float elapsed = (1.0F - frac) * total;
      float remaining = frac * total;
      float in = Mth.clamp(elapsed / 6.0F, 0.0F, 1.0F);
      float out = Mth.clamp(remaining / 6.0F, 0.0F, 1.0F);
      float p = Math.min(in, out);
      return p * p * (3.0F - 2.0F * p);
   }

   private static ResourceLocation texture() {
      SymbioteStrain s = SymbioteClientState.isGrafted() ? SymbioteClientState.getGraftStrain() : SymbioteClientState.getStrain();

      return switch (s) {
         case PREDATOR, ROYAL -> TEX_WARM;
         default -> TEX_COOL;
      };
   }

   private static Vec3[] arc(Vec3 wrist, Vec3 tip, int n, float grow, double bow) {
      Vec3 reach = tip.subtract(wrist).scale(grow);
      Vec3[] line = new Vec3[n];

      for (int i = 0; i < n; i++) {
         float t = (float)i / (n - 1);
         double bulge = Math.sin(t * Math.PI) * bow * grow;
         line[i] = wrist.add(reach.scale(t)).add(0.0, bulge, 0.0);
      }

      return line;
   }

   private static void emitTendril(
      PoseStack pose, VertexConsumer buf, int light, Vec3 from, Vec3 reach, Vec3 bowDir, double bow, float grow, float time, float seed, float thickMul
   ) {
      int n = 10;
      Vec3[] line = new Vec3[n];
      float[] radii = new float[n];
      float breathe = 1.0F + 0.14F * (float)Math.sin(time * 0.16 + seed);
      Vec3 scaled = reach.scale(grow * scale);

      for (int i = 0; i < n; i++) {
         float t = (float)i / (n - 1);
         double envelope = Math.sin(t * Math.PI);
         double wr = Math.sin(time * 0.13 + seed + t * 5.0) * 0.012 * scale * envelope;
         double wr2 = Math.cos(time * 0.11 + seed * 1.7 + t * 4.0) * 0.01 * scale * envelope;
         line[i] = from.add(scaled.scale(t)).add(bowDir.scale(envelope * bow * grow * scale)).add(wr, wr2, 0.0);
         radii[i] = Mth.lerp(t, 0.024F, 0.004F) * thickMul * grow * breathe * scale;
      }

      emitForm(pose, buf, light, line, radii, 0.85F, time + seed * 9.0F, 1.0F);
   }

   private static void emitBlade(PoseStack pose, VertexConsumer buf, int light, float grow, float time, int side, Vec3 sprout, Vec3 drift) {
      int count = 6;
      Vec3 aim = new Vec3(0.0, 0.0, -0.42F).add(drift);

      for (int c = 0; c < count; c++) {
         double around = (double)c / count * Math.PI * 2.0;
         Vec3 root = sprout.add(Math.cos(around) * 0.022 * scale, Math.sin(around) * 0.022 * scale, 0.0);
         Vec3 reach = aim.add(sprout).subtract(root);
         Vec3 bowDir = new Vec3(Math.cos(around), Math.sin(around), 0.0);
         emitTendril(pose, buf, light, root, reach, bowDir, 0.02, grow, time, c * 1.9F, 1.0F);
      }
   }

   private static void emitClaw(PoseStack pose, VertexConsumer buf, int light, float grow, float time, int side, Vec3 sprout, Vec3 drift) {
      int count = 4;

      for (int c = 0; c < count; c++) {
         float s = (float)c / (count - 1);
         double fanX = (s - 0.5) * 0.22;
         double fanY = (0.5 - Math.abs(s - 0.5)) * 0.1;
         Vec3 reach = new Vec3(fanX, fanY, -0.26F).add(drift.scale(0.6));
         emitTendril(pose, buf, light, sprout, reach, new Vec3(0.0, -1.0, 0.0), 0.055, grow, time, c * 2.4F, 1.15F);
      }
   }

   private static void emitShield(PoseStack pose, VertexConsumer buf, int light, float grow, float time, int side, Vec3 sprout, Vec3 drift) {
      int count = 9;
      double ring = 0.16;

      for (int c = 0; c < count; c++) {
         double around = (double)c / count * Math.PI * 2.0;
         Vec3 reach = new Vec3(Math.cos(around) * ring, Math.sin(around) * ring, -0.2F).add(drift.scale(0.4));
         Vec3 bowDir = new Vec3(Math.cos(around), Math.sin(around), 0.0);
         emitTendril(pose, buf, light, sprout, reach, bowDir, 0.045, grow, time, c * 1.3F, 0.95F);
      }
   }

   private static void emitForm(PoseStack pose, VertexConsumer buf, int light, Vec3[] line, float[] radii, float flatten, float time, float wobble) {
      int n = line.length;
      Vec3[] fr = new Vec3[n];
      Vec3[] fu = new Vec3[n];
      Vec3 prevR = new Vec3(1.0, 0.0, 0.0);
      Vec3 prevU = new Vec3(0.0, 1.0, 0.0);

      for (int i = 0; i < n; i++) {
         Vec3 tan;
         if (i == 0) {
            tan = line[Math.min(1, n - 1)].subtract(line[0]);
         } else if (i == n - 1) {
            tan = line[i].subtract(line[i - 1]);
         } else {
            tan = line[i + 1].subtract(line[i - 1]);
         }

         if (tan.lengthSqr() < 1.0E-8) {
            fr[i] = prevR;
            fu[i] = prevU;
         } else {
            tan = tan.normalize();
            Vec3 r = prevR.subtract(tan.scale(prevR.dot(tan)));
            if (r.lengthSqr() < 1.0E-8) {
               r = prevU.subtract(tan.scale(prevU.dot(tan)));
            }

            r = r.normalize();
            Vec3 u = tan.cross(r).normalize();
            fr[i] = r;
            fu[i] = u;
            prevR = r;
            prevU = u;
         }
      }

      Vec3[][] rings = new Vec3[n][8];

      for (int i = 0; i < n; i++) {
         float t = (float)i / (n - 1);

         for (int s = 0; s < 8; s++) {
            double a = (Math.PI * 2) * s / 8.0;
            double lump = 1.0 + Math.sin(time * 0.06 + s * 1.9 + t * 5.0) * 0.09 * wobble;
            double rad = radii[i] * lump;
            rings[i][s] = line[i].add(fr[i].scale(Math.cos(a) * rad)).add(fu[i].scale(Math.sin(a) * rad * flatten));
         }
      }

      Pose p = pose.last();
      Matrix4f m = p.pose();
      Matrix3f nm = p.normal();

      for (int i = 0; i < n - 1; i++) {
         float v0 = (float)i / (n - 1);
         float v1 = (float)(i + 1) / (n - 1);

         for (int s = 0; s < 8; s++) {
            int s2 = (s + 1) % 8;
            float u0 = s / 8.0F;
            float u1 = (s + 1) / 8.0F;
            Vec3 a = rings[i][s];
            Vec3 b = rings[i][s2];
            Vec3 c = rings[i + 1][s2];
            Vec3 d = rings[i + 1][s];
            Vec3 nrm = b.subtract(a).cross(d.subtract(a));
            if (nrm.lengthSqr() < 1.0E-9) {
               nrm = new Vec3(0.0, 1.0, 0.0);
            }

            nrm = nrm.normalize();
            vert(buf, m, nm, a, u0, v0, light, nrm);
            vert(buf, m, nm, b, u1, v0, light, nrm);
            vert(buf, m, nm, c, u1, v1, light, nrm);
            vert(buf, m, nm, d, u0, v1, light, nrm);
         }
      }
   }

   private static void vert(VertexConsumer buf, Matrix4f m, Matrix3f nm, Vec3 pos, float u, float v, int light, Vec3 n) {
      Verts.normal(buf.addVertex(m, (float)pos.x, (float)pos.y, (float)pos.z)
         .setColor(255, 255, 255, 255)
         .setUv(u, v)
         .setOverlay(OverlayTexture.NO_OVERLAY)
         .setLight(light)
         , nm, (float)n.x, (float)n.y, (float)n.z);
   }

   private HandMorphRenderer() {
   }

   public enum Form {
      BLADE,
      SHIELD,
      CLAW;
   }
}
