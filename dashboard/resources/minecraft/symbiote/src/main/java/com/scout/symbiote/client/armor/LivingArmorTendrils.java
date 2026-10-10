package com.scout.symbiote.client.armor;

import com.scout.symbiote.client.render.Verts;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.scout.symbiote.client.render.VanillaSheen;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix3f;
import org.joml.Matrix4f;

public final class LivingArmorTendrils {
   private static final ResourceLocation TEX_GUARDIAN = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_guardian.png");
   private static final ResourceLocation TEX_PREDATOR = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_predator.png");
   private static final int POINTS = 12;
   private static final int SIDES = 6;
   private static final float[][] BODY_ANCHORS = new float[][]{
      {5.0F, -1.0F, 1.0F, 0.5F, -1.0F, 0.45F, 7.0F},
      {-5.0F, -1.0F, 1.0F, -0.5F, -1.0F, 0.45F, 7.0F},
      {2.5F, -1.0F, 2.6F, 0.28F, -1.0F, 0.6F, 8.0F},
      {-2.5F, -1.0F, 2.6F, -0.28F, -1.0F, 0.6F, 8.0F},
      {0.0F, -2.0F, 2.6F, 0.0F, -1.0F, 0.55F, 9.0F},
      {4.0F, 3.0F, 1.4F, 0.55F, -0.5F, 0.5F, 6.0F}
   };
   private static final float BODY_R_ROOT = 1.4F;
   private static final float BODY_R_TIP = 0.5F;
   private static final float BODY_WRITHE = 1.7F;
   private static final float[][] ARM_ANCHORS = new float[][]{
      {-2.0F, -1.0F, -2.0F, -0.1F, 1.0F, -0.05F, 8.0F},
      {0.3F, 2.0F, -2.0F, 0.05F, 1.0F, 0.0F, 7.0F},
      {-3.4F, 0.0F, -0.5F, -0.05F, 1.0F, 0.05F, 9.0F},
      {-1.2F, 5.0F, -2.0F, 0.0F, 1.0F, -0.05F, 5.0F}
   };
   private static final float ARM_R_ROOT = 0.8F;
   private static final float ARM_R_TIP = 0.35F;
   private static final float ARM_WRITHE = 0.85F;
   private static final float[][] CHEST_ANCHORS = new float[][]{
      {0.0F, 4.0F, -2.3F, 0.0F, -1.0F, 0.35F, 6.0F},
      {0.0F, 4.7F, -2.3F, 0.0F, 1.0F, 0.35F, 5.0F},
      {0.0F, 4.0F, -2.3F, 0.9F, -0.7F, 0.35F, 6.0F},
      {0.0F, 4.0F, -2.3F, -0.9F, -0.7F, 0.35F, 6.0F},
      {0.0F, 4.4F, -2.3F, 1.0F, 0.1F, 0.35F, 6.0F},
      {0.0F, 4.4F, -2.3F, -1.0F, 0.1F, 0.35F, 6.0F}
   };
   private static final float CHEST_R_ROOT = 0.55F;
   private static final float CHEST_R_TIP = 0.28F;
   private static final float CHEST_WRITHE = 0.7F;
   private static final float[] SIZE_MULS = new float[]{1.45F, 0.62F, 1.05F, 0.78F, 1.28F, 0.7F, 0.95F};
   private static final float[] LEN_MULS = new float[]{1.2F, 0.8F, 1.0F, 0.88F, 1.15F, 0.82F, 1.05F};

   public static void render(
      PoseStack ps, MultiBufferSource buffers, int light, ModelPart body, ModelPart rightArm, ModelPart leftArm, SymbioteStrain strain, float age, float alpha
   ) {
      if (!(alpha <= 0.02F)) {
         float[] base = baseColor(strain);
         float[] accent = accentColor(strain);
         ResourceLocation tex = strain != SymbioteStrain.PREDATOR && strain != SymbioteStrain.ROYAL ? TEX_GUARDIAN : TEX_PREDATOR;
         VertexConsumer buf = buffers.getBuffer(RenderType.entityTranslucent(tex));
         renderSet(ps, buf, light, body, BODY_ANCHORS, 1.0F, 1.4F, 0.5F, 1.7F, false, base, accent, age, alpha, 0.0F);
         renderSet(ps, buf, light, body, CHEST_ANCHORS, 1.0F, 0.55F, 0.28F, 0.7F, true, base, accent, age, alpha, 21.0F);
         renderSet(ps, buf, light, rightArm, ARM_ANCHORS, 1.0F, 0.8F, 0.35F, 0.85F, true, base, accent, age, alpha, 7.0F);
         renderSet(ps, buf, light, leftArm, ARM_ANCHORS, -1.0F, 0.8F, 0.35F, 0.85F, true, base, accent, age, alpha, 13.0F);
      }
   }

   private static void renderSet(
      PoseStack ps,
      VertexConsumer buf,
      int light,
      ModelPart part,
      float[][] anchors,
      float mirror,
      float rRoot,
      float rTip,
      float writhe,
      boolean embedded,
      float[] base,
      float[] accent,
      float age,
      float alpha,
      float phaseBase
   ) {
      ps.pushPose();
      part.translateAndRotate(ps);
      Matrix4f m = ps.last().pose();
      Matrix3f nm = ps.last().normal();

      for (int a = 0; a < anchors.length; a++) {
         float[] k = anchors[a];
         Vec3 root = new Vec3(k[0] * mirror, k[1], k[2]);
         Vec3 dir = new Vec3(k[3] * mirror, k[4], k[5]).normalize();
         int idx = (a + (int)phaseBase) % SIZE_MULS.length;
         float sizeMul = SIZE_MULS[idx];
         float lenMul = LEN_MULS[idx];
         drawTube(
            buf, m, nm, light, root, dir, k[6] * lenMul, rRoot * sizeMul, rTip * sizeMul, writhe, embedded, base, accent, age, phaseBase + a * 1.3F, alpha
         );
      }

      ps.popPose();
   }

   private static void drawTube(
      VertexConsumer buf,
      Matrix4f m,
      Matrix3f nm,
      int light,
      Vec3 root,
      Vec3 forwardN,
      float length,
      float rRoot,
      float rTip,
      float writheAmp,
      boolean embedded,
      float[] base,
      float[] accent,
      float age,
      float phase,
      float alpha
   ) {
      Vec3 worldUp = Math.abs(forwardN.y) > 0.99 ? new Vec3(1.0, 0.0, 0.0) : new Vec3(0.0, 1.0, 0.0);
      Vec3 right = forwardN.cross(worldUp).normalize();
      Vec3 up = right.cross(forwardN).normalize();
      Vec3[] pts = new Vec3[12];

      for (int i = 0; i < 12; i++) {
         float t = i / 11.0F;
         float env = embedded ? (float)Math.sin(Math.PI * t) : t;
         Vec3 base3 = root.add(forwardN.scale(length * t));
         double wa = Math.sin(age * 0.16 + t * 8.0 + phase);
         double wb = Math.cos(age * 0.21 + t * 11.0 + phase + 1.3);
         pts[i] = base3.add(right.scale(wa * writheAmp * env)).add(up.scale(wb * writheAmp * 0.7 * env));
      }

      Vec3[][] rings = new Vec3[12][6];

      for (int i = 0; i < 12; i++) {
         float t = i / 11.0F;
         float r = Mth.lerp(t * t, rRoot, rTip) + 0.18F * (float)Math.sin(Math.PI * t);

         for (int s = 0; s < 6; s++) {
            double ang = (Math.PI * 2) * s / 6.0;
            rings[i][s] = pts[i].add(right.scale(Math.cos(ang) * r)).add(up.scale(Math.sin(ang) * r));
         }
      }

      for (int i = 0; i < 11; i++) {
         float tGrad = (i + 0.5F) / 11.0F;
         float cr = Mth.lerp(tGrad, base[0], accent[0]);
         float cg = Mth.lerp(tGrad, base[1], accent[1]);
         float cb = Mth.lerp(tGrad, base[2], accent[2]);

         for (int s = 0; s < 6; s++) {
            int sn = (s + 1) % 6;
            double angMid = (Math.PI * 2) * (s + 0.5) / 6.0;
            Vec3 normal = right.scale(Math.cos(angMid)).add(up.scale(Math.sin(angMid)));
            float lit = 0.55F + 0.45F * (float)Math.max(0.0, -normal.y);
            float vary = 0.85F + 0.15F * (float)Math.sin(s * 1.7 + i * 0.9 + age * 0.1);
            float br = lit * vary;
            float r = Mth.clamp(cr * br * 1.4F, 0.0F, 1.0F);
            float g = Mth.clamp(cg * br * 1.4F, 0.0F, 1.0F);
            float b = Mth.clamp(cb * br * 1.4F, 0.0F, 1.0F);
            emit(buf, m, nm, light, r, g, b, alpha, rings[i][s], normal);
            emit(buf, m, nm, light, r, g, b, alpha, rings[i + 1][s], normal);
            emit(buf, m, nm, light, r, g, b, alpha, rings[i + 1][sn], normal);
            emit(buf, m, nm, light, r, g, b, alpha, rings[i][sn], normal);
         }
      }
   }

   private static void emit(VertexConsumer buf, Matrix4f m, Matrix3f nm, int light, float r, float g, float b, float a, Vec3 p, Vec3 normal) {
      float spec = VanillaSheen.spec(m, nm, p.scale(0.0625), normal, light, 9.0F, 0.42F);
      if (spec > 0.0F) {
         r += (1.0F - r) * spec;
         g += (1.0F - g) * spec;
         b += (1.0F - b) * spec;
      }

      Verts.normal(buf.addVertex(m, (float)p.x / 16.0F, (float)p.y / 16.0F, (float)p.z / 16.0F)
         .setColor(r, g, b, a)
         .setUv(0.5F, 0.5F)
         .setOverlay(OverlayTexture.NO_OVERLAY)
         .setLight(light)
         , nm, (float)normal.x, (float)normal.y, (float)normal.z);
   }

   private static float[] baseColor(SymbioteStrain strain) {
      return switch (strain) {
         case GUARDIAN -> new float[]{0.16F, 0.06F, 0.3F};
         case PREDATOR -> new float[]{0.35F, 0.06F, 0.1F};
         case SHADOW -> new float[]{0.08F, 0.09F, 0.14F};
         case SCULK -> new float[]{0.04F, 0.22F, 0.24F};
         case ROYAL -> new float[]{0.32F, 0.2F, 0.06F};
      };
   }

   private static float[] accentColor(SymbioteStrain strain) {
      return switch (strain) {
         case GUARDIAN -> new float[]{0.5F, 0.28F, 0.78F};
         case PREDATOR -> new float[]{0.78F, 0.16F, 0.2F};
         case SHADOW -> new float[]{0.26F, 0.34F, 0.52F};
         case SCULK -> new float[]{0.16F, 0.62F, 0.58F};
         case ROYAL -> new float[]{0.8F, 0.58F, 0.16F};
      };
   }

   private static float fract(float v) {
      return v - (float)Math.floor(v);
   }

   private LivingArmorTendrils() {
   }
}
