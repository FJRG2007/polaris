package com.scout.symbiote.client.wildhost;

import com.scout.symbiote.client.RenderStateBridge;
import com.scout.symbiote.client.render.Verts;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.math.Axis;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderLivingEvent.Post;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import org.joml.Matrix3f;
import org.joml.Matrix4f;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class WildHostRenderLayer {
   private static final ResourceLocation TEX_COOL = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_guardian.png");
   private static final ResourceLocation TEX_WARM = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_predator.png");
   private static final int POINTS = 9;
   private static final int SIDES = 5;
   private static final int STRANDS = 8;

   @SubscribeEvent
   public static void onRenderLivingPost(Post<?, ?, ?> event) {
      if (!(RenderStateBridge.entity(event.getRenderState()) instanceof LivingEntity entity)) {
         return;
      }

      if (WildHost.isInfected(entity)) {
         if (!entity.isInvisible()) {
            SymbioteStrain strain = WildHost.strainOf(entity);
            if (strain != null) {
               float partial = event.getPartialTick();
               float age = entity.tickCount + partial;
               float w = entity.getBbWidth();
               float h = entity.getBbHeight();
               float scale = Mth.clamp((w + h) * 0.42F, 0.32F, 2.6F);
               PoseStack pose = event.getPoseStack();
               VertexConsumer buf = event.getMultiBufferSource()
                  .getBuffer(RenderType.entityTranslucent(strain != SymbioteStrain.PREDATOR && strain != SymbioteStrain.ROYAL ? TEX_COOL : TEX_WARM));
               float[] base = baseColor(strain);
               float[] accent = accentColor(strain);
               pose.pushPose();
               pose.mulPose(Axis.YP.rotationDegrees(-Mth.lerp(partial, entity.yBodyRotO, entity.yBodyRot)));
               Matrix4f m = pose.last().pose();
               Matrix3f nm = pose.last().normal();

               for (int i = 0; i < 8; i++) {
                  double a = (Math.PI * 2) * i / 8.0 + 0.6;
                  double rx = Math.cos(a) * w * 0.34;
                  double rz = Math.sin(a) * w * 0.34;
                  Vec3 root = new Vec3(rx, h * (0.42F + 0.16F * (i % 3)), rz);
                  Vec3 tip = new Vec3(rx * 2.1, h * (0.95F + 0.22F * (i % 2)), rz * 2.1);
                  drawStrand(buf, m, nm, event.getPackedLight(), root, tip, scale, base, accent, age, (float)(i * 1.9));
               }

               VertexConsumer glow = event.getMultiBufferSource()
                  .getBuffer(RenderType.eyes(strain != SymbioteStrain.PREDATOR && strain != SymbioteStrain.ROYAL ? TEX_COOL : TEX_WARM));
               float pulse = 0.45F + 0.25F * Mth.sin(age * 0.12F);
               float[] lit = new float[]{accent[0] * pulse, accent[1] * pulse, accent[2] * pulse};

               for (int i = 0; i < 8; i++) {
                  double a = (Math.PI * 2) * i / 8.0 + 0.6;
                  double rx = Math.cos(a) * w * 0.34;
                  double rz = Math.sin(a) * w * 0.34;
                  Vec3 root = new Vec3(rx, h * (0.42F + 0.16F * (i % 3)), rz);
                  Vec3 tip = new Vec3(rx * 2.1, h * (0.95F + 0.22F * (i % 2)), rz * 2.1);
                  drawStrand(glow, m, nm, event.getPackedLight(), root, tip, scale * 0.92F, lit, lit, age, (float)(i * 1.9));
               }

               pose.popPose();
            }
         }
      }
   }

   private static void drawStrand(
      VertexConsumer buf, Matrix4f m, Matrix3f nm, int light, Vec3 root, Vec3 tip, float scale, float[] base, float[] accent, float age, float seed
   ) {
      Vec3 fwd = tip.subtract(root).normalize();
      Vec3 worldUp = Math.abs(fwd.y) > 0.99 ? new Vec3(1.0, 0.0, 0.0) : new Vec3(0.0, 1.0, 0.0);
      Vec3 right = fwd.cross(worldUp).normalize();
      Vec3 up = right.cross(fwd).normalize();
      float writhe = 0.09F * scale;
      Vec3[] pts = new Vec3[9];

      for (int i = 0; i < 9; i++) {
         float t = i / 8.0F;
         double wa = Math.sin(age * 0.14 + seed + t * 5.0);
         double wb = Math.cos(age * 0.11 + seed * 1.3 + t * 4.0);
         pts[i] = root.add(tip.subtract(root).scale(t)).add(right.scale(wa * writhe * t)).add(up.scale(wb * writhe * 0.6 * t));
      }

      Vec3[][] rings = new Vec3[9][5];

      for (int i = 0; i < 9; i++) {
         float t = i / 8.0F;
         float r = Mth.lerp(t, 0.055F, 0.012F) * scale;

         for (int sIdx = 0; sIdx < 5; sIdx++) {
            double ang = (Math.PI * 2) * sIdx / 5.0;
            rings[i][sIdx] = pts[i].add(right.scale(Math.cos(ang) * r)).add(up.scale(Math.sin(ang) * r));
         }
      }

      for (int i = 0; i < 8; i++) {
         float tg = (i + 0.5F) / 8.0F;
         float cr = Mth.lerp(tg, base[0], accent[0]);
         float cg = Mth.lerp(tg, base[1], accent[1]);
         float cb = Mth.lerp(tg, base[2], accent[2]);

         for (int sIdx = 0; sIdx < 5; sIdx++) {
            int sn = (sIdx + 1) % 5;
            double angMid = (Math.PI * 2) * (sIdx + 0.5) / 5.0;
            Vec3 normal = right.scale(Math.cos(angMid)).add(up.scale(Math.sin(angMid)));
            float lit = 0.6F + 0.4F * (float)Math.max(0.0, normal.y);
            emit(buf, m, nm, light, cr * lit, cg * lit, cb * lit, rings[i][sIdx], normal);
            emit(buf, m, nm, light, cr * lit, cg * lit, cb * lit, rings[i + 1][sIdx], normal);
            emit(buf, m, nm, light, cr * lit, cg * lit, cb * lit, rings[i + 1][sn], normal);
            emit(buf, m, nm, light, cr * lit, cg * lit, cb * lit, rings[i][sn], normal);
         }
      }
   }

   private static void emit(VertexConsumer buf, Matrix4f m, Matrix3f nm, int light, float r, float g, float b, Vec3 p, Vec3 normal) {
      Verts.normal(buf.addVertex(m, (float)p.x, (float)p.y, (float)p.z)
         .setColor(Mth.clamp(r * 1.3F, 0.0F, 1.0F), Mth.clamp(g * 1.3F, 0.0F, 1.0F), Mth.clamp(b * 1.3F, 0.0F, 1.0F), 1.0F)
         .setUv(0.5F, 0.5F)
         .setOverlay(OverlayTexture.NO_OVERLAY)
         .setLight(light)
         , nm, (float)normal.x, (float)normal.y, (float)normal.z);
   }

   private static float[] baseColor(SymbioteStrain s) {
      return switch (s) {
         case GUARDIAN -> new float[]{0.16F, 0.06F, 0.3F};
         case PREDATOR -> new float[]{0.35F, 0.06F, 0.1F};
         case SHADOW -> new float[]{0.08F, 0.09F, 0.14F};
         case SCULK -> new float[]{0.04F, 0.22F, 0.24F};
         case ROYAL -> new float[]{0.32F, 0.2F, 0.06F};
      };
   }

   private static float[] accentColor(SymbioteStrain s) {
      return switch (s) {
         case GUARDIAN -> new float[]{0.5F, 0.28F, 0.78F};
         case PREDATOR -> new float[]{0.92F, 0.22F, 0.26F};
         case SHADOW -> new float[]{0.42F, 0.3F, 0.62F};
         case SCULK -> new float[]{0.2F, 0.86F, 0.8F};
         case ROYAL -> new float[]{0.92F, 0.7F, 0.26F};
      };
   }

   private WildHostRenderLayer() {
   }
}
