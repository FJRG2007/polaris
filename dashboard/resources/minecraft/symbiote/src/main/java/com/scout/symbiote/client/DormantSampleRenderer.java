package com.scout.symbiote.client;

import net.minecraft.client.renderer.texture.TextureAtlas;
import com.scout.symbiote.client.render.Verts;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.blaze3d.vertex.PoseStack.Pose;
import com.mojang.math.Axis;
import com.scout.symbiote.block.DormantSampleBlock;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderer;
import net.minecraft.client.renderer.blockentity.BlockEntityRendererProvider.Context;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.joml.Matrix3f;
import org.joml.Matrix4f;

public class DormantSampleRenderer<T extends BlockEntity> implements BlockEntityRenderer<T> {
   private static final float[][] LUMPS = new float[][]{
      {-2.5F, 0.0F, 6.5F, 2.0F, 4.5F, 11.0F},
      {2.0F, 7.5F, 8.0F, 6.5F, 10.5F, 12.5F},
      {6.5F, 10.5F, 6.5F, 11.0F, 13.5F, 11.0F},
      {11.0F, 6.0F, 6.5F, 15.5F, 9.0F, 11.0F},
      {11.0F, 0.0F, 0.5F, 15.5F, 3.0F, 5.0F},
      {-1.0F, 0.0F, 9.5F, 3.5F, 3.0F, 14.0F}
   };
   private static final float[] PHASE = new float[]{0.0F, 1.7F, 3.1F, 4.6F, 5.5F, 2.4F};
   private static final float[] SWELLS = new float[]{0.2F, 0.2F, 0.2F, 0.2F, 0.13F, 0.13F};
   private static final float SPEED = 0.12566371F;
   private static final float U0 = 12.0F;
   private static final float V0 = 13.0F;
   private static final float U1 = 15.0F;
   private static final float V1 = 15.0F;

   public DormantSampleRenderer(Context ctx) {
   }

   public void render(T be, float partialTick, PoseStack pose, MultiBufferSource buffers, int packedLight, int packedOverlay) {
      BlockState state = be.getBlockState();
      if (state.hasProperty(DormantSampleBlock.STRAIN)) {
         String strainName = ((SymbioteStrain)state.getValue(DormantSampleBlock.STRAIN)).getSerializedName();
         TextureAtlasSprite sprite = (TextureAtlasSprite)Minecraft.getInstance()
            .getTextureAtlas(TextureAtlas.LOCATION_BLOCKS)
            .apply(ResourceLocation.fromNamespaceAndPath("symbiote", "block/dormant_sample_" + strainName));
         VertexConsumer buf = buffers.getBuffer(RenderType.entityCutout(TextureAtlas.LOCATION_BLOCKS));
         BlockPos pos = be.getBlockPos();
         float time = (float)((pos.hashCode() & 65535) + (be.getLevel() != null ? be.getLevel().getGameTime() : 0L)) + partialTick;

         for (int i = 0; i < LUMPS.length; i++) {
            float[] l = LUMPS[i];
            float scale = 1.0F + SWELLS[i] * (float)Math.sin(time * 0.12566371F + PHASE[i]);
            float cx = (l[0] + l[3]) / 32.0F;
            float cy = (l[1] + l[4]) / 32.0F;
            float cz = (l[2] + l[5]) / 32.0F;
            float hx = (l[3] - l[0]) / 32.0F;
            float hy = (l[4] - l[1]) / 32.0F;
            float hz = (l[5] - l[2]) / 32.0F;
            pose.pushPose();
            if (i == 0) {
               pose.translate(-0.0625F, 0.09375F, 0.5F);
               pose.mulPose(Axis.XP.rotationDegrees(-22.5F));
               pose.translate(0.0625F, -0.09375F, -0.5F);
            }

            pose.translate(cx, cy, cz);
            pose.scale(scale, scale, scale);
            drawBox(pose, buf, sprite, hx, hy, hz, packedLight, packedOverlay);
            pose.popPose();
         }
      }
   }

   private static void drawBox(PoseStack pose, VertexConsumer buf, TextureAtlasSprite sprite, float hx, float hy, float hz, int light, int overlay) {
      float u0 = sprite.getU(12.0F / 16.0F);
      float u1 = sprite.getU(15.0F / 16.0F);
      float v0 = sprite.getV(13.0F / 16.0F);
      float v1 = sprite.getV(15.0F / 16.0F);
      Pose p = pose.last();
      quad(p, buf, u0, v0, u1, v1, light, overlay, 0.0F, -1.0F, 0.0F, -hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz);
      quad(p, buf, u0, v0, u1, v1, light, overlay, 0.0F, 1.0F, 0.0F, -hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz);
      quad(p, buf, u0, v0, u1, v1, light, overlay, 0.0F, 0.0F, -1.0F, hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz);
      quad(p, buf, u0, v0, u1, v1, light, overlay, 0.0F, 0.0F, 1.0F, -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz);
      quad(p, buf, u0, v0, u1, v1, light, overlay, -1.0F, 0.0F, 0.0F, -hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz);
      quad(p, buf, u0, v0, u1, v1, light, overlay, 1.0F, 0.0F, 0.0F, hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz);
   }

   private static void quad(
      Pose p,
      VertexConsumer buf,
      float u0,
      float v0,
      float u1,
      float v1,
      int light,
      int overlay,
      float nx,
      float ny,
      float nz,
      float x1,
      float y1,
      float z1,
      float x2,
      float y2,
      float z2,
      float x3,
      float y3,
      float z3,
      float x4,
      float y4,
      float z4
   ) {
      Matrix4f m = p.pose();
      Matrix3f n = p.normal();
      Verts.normal(buf.addVertex(m, x1, y1, z1).setColor(255, 255, 255, 255).setUv(u0, v1).setOverlay(overlay).setLight(light), n, nx, ny, nz);
      Verts.normal(buf.addVertex(m, x2, y2, z2).setColor(255, 255, 255, 255).setUv(u1, v1).setOverlay(overlay).setLight(light), n, nx, ny, nz);
      Verts.normal(buf.addVertex(m, x3, y3, z3).setColor(255, 255, 255, 255).setUv(u1, v0).setOverlay(overlay).setLight(light), n, nx, ny, nz);
      Verts.normal(buf.addVertex(m, x4, y4, z4).setColor(255, 255, 255, 255).setUv(u0, v0).setOverlay(overlay).setLight(light), n, nx, ny, nz);
   }
}
