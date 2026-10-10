package com.scout.symbiote.client.bloom;

import com.scout.symbiote.client.render.Verts;
import com.scout.symbiote.client.RenderStateBridge;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix3f;
import org.joml.Matrix4f;

public class BloomRenderLayer extends RenderLayer<PlayerRenderState, PlayerModel> {
   private static final ResourceLocation TEX = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_guardian.png");
   private static final ResourceLocation TEX_HOT = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_predator.png");
   private static final int POINTS = 14;
   private static final int SIDES = 6;
   public static int OUTER_PETALS = 19;
   public static int INNER_PETALS = 5;
   public static float ROOT_Y = -0.75F;
   public static float ROOT_RADIUS = 2.4F;
   public static float OUTER_LEN = 31.0F;
   public static float INNER_LEN = 12.0F;
   public static float SPLAY_CLOSED = 0.1F;
   public static float SPLAY_OPEN = 0.65F;
   public static float R_ROOT = 1.5F;
   public static float R_TIP = 0.3F;
   public static float WRITHE = 7.1F;
   public static float HEAD_CORE = 0.05F;
   public static boolean preview = false;

   public BloomRenderLayer(RenderLayerParent<PlayerRenderState, PlayerModel> parent) {
      super(parent);
   }

   @Override
   public void render(PoseStack ps, MultiBufferSource buffers, int light, PlayerRenderState renderState, float renderYRot, float renderXRot) {
      AbstractClientPlayer player = RenderStateBridge.player(renderState);
      if (player == null) {
         return;
      }

      float limbSwing = renderState.walkAnimationPos;
      float limbSwingAmount = renderState.walkAnimationSpeed;
      float partialTick = renderState.partialTick;
      float age = renderState.ageInTicks;
      float netHeadYaw = renderState.yRot;
      float headPitch = renderState.xRot;
      if (player == Minecraft.getInstance().player) {
         if (!player.isInvisible()) {
            if (Minecraft.getInstance().level != null) {
               float progress = preview ? 1.0F : SymbioteClientState.getBloomProgress(Minecraft.getInstance().level.getGameTime(), partialTick);
               if (!(progress <= 0.01F)) {
                  if (!Minecraft.getInstance().options.getCameraType().isFirstPerson()) {
                     SymbioteStrain strain = SymbioteClientState.getStrain();
                     float[] base = baseColor(strain);
                     float[] accent = accentColor(strain);
                     VertexConsumer buf = buffers.getBuffer(
                        RenderType.entityTranslucent(strain != SymbioteStrain.PREDATOR && strain != SymbioteStrain.ROYAL ? TEX : TEX_HOT)
                     );
                     ps.pushPose();
                     ModelPart head = (this.getParentModel()).head;
                     head.translateAndRotate(ps);
                     float hs = head.xScale;
                     if (hs > 0.001F) {
                        ps.scale(1.0F / hs, 1.0F / head.yScale, 1.0F / head.zScale);
                     }

                     Matrix4f m = ps.last().pose();
                     Matrix3f nm = ps.last().normal();
                     BloomRenderLayer.Shape sh = shapeOf(strain);
                     float splay = Mth.lerp(progress, SPLAY_CLOSED, SPLAY_OPEN * sh.splay);
                     int outer = Math.max(1, Math.round(OUTER_PETALS * sh.count));
                     int inner = Math.max(0, Math.round(INNER_PETALS * sh.count));
                     this.ring(
                        buf,
                        m,
                        nm,
                        light,
                        outer,
                        OUTER_LEN * progress * sh.len,
                        splay,
                        0.0F,
                        R_ROOT * sh.thick,
                        R_TIP * sh.thick,
                        base,
                        accent,
                        age,
                        progress,
                        sh.writhe
                     );
                     if (inner > 0) {
                        this.ring(
                           buf,
                           m,
                           nm,
                           light,
                           inner,
                           INNER_LEN * progress * sh.len,
                           splay * 0.55F,
                           (float) Math.PI / inner,
                           R_ROOT * 0.7F * sh.thick,
                           R_TIP * sh.thick,
                           base,
                           accent,
                           age,
                           progress,
                           sh.writhe
                        );
                     }

                     ps.popPose();
                  }
               }
            }
         }
      }
   }

   private static BloomRenderLayer.Shape shapeOf(SymbioteStrain s) {
      return switch (s) {
         case PREDATOR -> new BloomRenderLayer.Shape(0.42F, 1.15F, 0.55F, 1.45F, 1.15F);
         case GUARDIAN -> new BloomRenderLayer.Shape(1.15F, 0.7F, 1.2F, 1.3F, 0.7F);
         case SHADOW -> new BloomRenderLayer.Shape(1.25F, 1.05F, 0.95F, 0.65F, 1.35F);
         case SCULK -> new BloomRenderLayer.Shape(0.55F, 0.9F, 0.35F, 0.85F, 0.3F);
         case ROYAL -> new BloomRenderLayer.Shape(1.0F, 1.1F, 1.15F, 1.2F, 0.85F);
      };
   }

   private void ring(
      VertexConsumer buf,
      Matrix4f m,
      Matrix3f nm,
      int light,
      int count,
      float length,
      float splay,
      float angleOffset,
      float rRoot,
      float rTip,
      float[] base,
      float[] accent,
      float age,
      float progress,
      float writheMul
   ) {
      if (!(length <= 0.05F)) {
         for (int i = 0; i < count; i++) {
            double a = (Math.PI * 2) * i / count + angleOffset;
            double cx = Math.cos(a);
            double cz = Math.sin(a);
            Vec3 root = new Vec3(cx * ROOT_RADIUS, ROOT_Y, cz * ROOT_RADIUS);
            Vec3 dir = new Vec3(cx * splay, -(1.0F - splay * 0.75F), cz * splay).normalize();
            float lenMul = 0.78F + 0.44F * (float)(i * 7 % 5 / 4.0);
            this.drawTube(buf, m, nm, light, root, dir, length * lenMul, rRoot, rTip, base, accent, age, (float)(i * 1.7), progress, writheMul);
         }
      }
   }

   private void drawTube(
      VertexConsumer buf,
      Matrix4f m,
      Matrix3f nm,
      int light,
      Vec3 root,
      Vec3 fwd,
      float length,
      float rRoot,
      float rTip,
      float[] base,
      float[] accent,
      float age,
      float phase,
      float alpha,
      float writheMul
   ) {
      float writhe = WRITHE * writheMul;
      Vec3 worldUp = Math.abs(fwd.y) > 0.99 ? new Vec3(1.0, 0.0, 0.0) : new Vec3(0.0, 1.0, 0.0);
      Vec3 right = fwd.cross(worldUp).normalize();
      Vec3 up = right.cross(fwd).normalize();
      Vec3[] pts = new Vec3[14];

      for (int i = 0; i < 14; i++) {
         float t = i / 13.0F;
         Vec3 spine = root.add(fwd.scale(length * t));
         double wa = Math.sin(age * 0.19 + t * 7.0 + phase);
         double wb = Math.cos(age * 0.24 + t * 9.0 + phase + 1.1);
         pts[i] = spine.add(right.scale(wa * writhe * t)).add(up.scale(wb * writhe * 0.6 * t));
      }

      Vec3[][] rings = new Vec3[14][6];

      for (int i = 0; i < 14; i++) {
         float t = i / 13.0F;
         float r = Mth.lerp(t * t, rRoot, rTip) + 0.14F * (float)Math.sin(Math.PI * t);

         for (int s = 0; s < 6; s++) {
            double ang = (Math.PI * 2) * s / 6.0;
            rings[i][s] = pts[i].add(right.scale(Math.cos(ang) * r)).add(up.scale(Math.sin(ang) * r));
         }
      }

      for (int i = 0; i < 13; i++) {
         float tg = (i + 0.5F) / 13.0F;
         float cr = Mth.lerp(tg, base[0], accent[0]);
         float cg = Mth.lerp(tg, base[1], accent[1]);
         float cb = Mth.lerp(tg, base[2], accent[2]);

         for (int s = 0; s < 6; s++) {
            int sn = (s + 1) % 6;
            double angMid = (Math.PI * 2) * (s + 0.5) / 6.0;
            Vec3 normal = right.scale(Math.cos(angMid)).add(up.scale(Math.sin(angMid)));
            float lit = 0.55F + 0.45F * (float)Math.max(0.0, -normal.y);
            float br = lit * (0.85F + 0.15F * (float)Math.sin(s * 1.7 + i * 0.9 + age * 0.1));
            emit(
               buf,
               m,
               nm,
               light,
               Mth.clamp(cr * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cg * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cb * br * 1.4F, 0.0F, 1.0F),
               alpha,
               rings[i][s],
               normal
            );
            emit(
               buf,
               m,
               nm,
               light,
               Mth.clamp(cr * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cg * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cb * br * 1.4F, 0.0F, 1.0F),
               alpha,
               rings[i + 1][s],
               normal
            );
            emit(
               buf,
               m,
               nm,
               light,
               Mth.clamp(cr * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cg * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cb * br * 1.4F, 0.0F, 1.0F),
               alpha,
               rings[i + 1][sn],
               normal
            );
            emit(
               buf,
               m,
               nm,
               light,
               Mth.clamp(cr * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cg * br * 1.4F, 0.0F, 1.0F),
               Mth.clamp(cb * br * 1.4F, 0.0F, 1.0F),
               alpha,
               rings[i][sn],
               normal
            );
         }
      }
   }

   private static void emit(VertexConsumer buf, Matrix4f m, Matrix3f nm, int light, float r, float g, float b, float a, Vec3 p, Vec3 normal) {
      Verts.normal(buf.addVertex(m, (float)p.x / 16.0F, (float)p.y / 16.0F, (float)p.z / 16.0F)
         .setColor(r, g, b, a)
         .setUv(0.5F, 0.5F)
         .setOverlay(OverlayTexture.NO_OVERLAY)
         .setLight(light)
         , nm, (float)normal.x, (float)normal.y, (float)normal.z);
   }

   private static float[] baseColor(SymbioteStrain s) {
      return switch (s) {
         case PREDATOR -> new float[]{0.35F, 0.06F, 0.1F};
         case GUARDIAN -> new float[]{0.16F, 0.06F, 0.3F};
         case SHADOW -> new float[]{0.08F, 0.09F, 0.14F};
         case SCULK -> new float[]{0.04F, 0.22F, 0.24F};
         case ROYAL -> new float[]{0.32F, 0.2F, 0.06F};
      };
   }

   private static float[] accentColor(SymbioteStrain s) {
      return switch (s) {
         case PREDATOR -> new float[]{0.92F, 0.22F, 0.26F};
         case GUARDIAN -> new float[]{0.5F, 0.28F, 0.78F};
         case SHADOW -> new float[]{0.42F, 0.3F, 0.62F};
         case SCULK -> new float[]{0.2F, 0.86F, 0.8F};
         case ROYAL -> new float[]{0.92F, 0.7F, 0.26F};
      };
   }

   private record Shape(float count, float len, float splay, float thick, float writhe) {
   }
}
