package com.scout.symbiote.client;

import com.scout.symbiote.client.RenderStateBridge;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import com.mojang.blaze3d.vertex.PoseStack;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent.Stage;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import org.joml.Matrix4f;
import org.joml.Vector4f;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class MantleBodyAnchor {
   private static Matrix4f invView = null;
   private static Vec3 camPos = Vec3.ZERO;
   private static long lastFrameNano = 0L;
   private static float frameDtSec = 0.016666668F;
   private static long frameIndex = 0L;
   private static final Map<Integer, MantleBodyAnchor.Capture> CAPTURES = new ConcurrentHashMap<>();

   public static float frameDt() {
      return frameDtSec;
   }

   public static long frameIndex() {
      return frameIndex;
   }

   @SubscribeEvent
   public static void onRenderStage(RenderLevelStageEvent event) {
      if (event.getStage() == Stage.AFTER_SKY) {
         invView = new Matrix4f(event.getPoseStack().last().pose()).invert();
         camPos = event.getCamera().getPosition();
         long now = System.nanoTime();
         if (lastFrameNano != 0L) {
            frameDtSec = Math.min(0.05F, Math.max(0.001F, (float)(now - lastFrameNano) / 1.0E9F));
         }

         lastFrameNano = now;
         frameIndex++;
      }
   }

   public static MantleBodyAnchor.Capture get(int entityId) {
      return CAPTURES.get(entityId);
   }

   public static void onLogoutOrClear() {
      CAPTURES.clear();
   }

   private MantleBodyAnchor() {
   }

   public record Capture(Vec3 origin, Vec3 up, Vec3 back, Vec3 right, Vec3 ownerLerpPos, long gameTime) {
   }

   public static final class Layer extends RenderLayer<PlayerRenderState, PlayerModel> {
      public Layer(RenderLayerParent<PlayerRenderState, PlayerModel> parent) {
         super(parent);
      }

      @Override
   public void render(PoseStack poseStack, MultiBufferSource bufferSource, int packedLight, PlayerRenderState renderState, float renderYRot, float renderXRot) {
      AbstractClientPlayer player = RenderStateBridge.player(renderState);
      if (player == null) {
         return;
      }

      float limbSwing = renderState.walkAnimationPos;
      float limbSwingAmount = renderState.walkAnimationSpeed;
      float partialTick = renderState.partialTick;
      float ageInTicks = renderState.ageInTicks;
      float netHeadYaw = renderState.yRot;
      float headPitch = renderState.xRot;
         Matrix4f iv = MantleBodyAnchor.invView;
         if (iv != null) {
            poseStack.pushPose();
            (this.getParentModel()).body.translateAndRotate(poseStack);
            Matrix4f m = poseStack.last().pose();
            poseStack.popPose();
            Vector4f o = iv.transform(m.transform(new Vector4f(0.0F, 0.0F, 0.0F, 1.0F)));
            Vector4f py = iv.transform(m.transform(new Vector4f(0.0F, 1.0F, 0.0F, 1.0F)));
            Vector4f pz = iv.transform(m.transform(new Vector4f(0.0F, 0.0F, 1.0F, 1.0F)));
            Vector4f px = iv.transform(m.transform(new Vector4f(1.0F, 0.0F, 0.0F, 1.0F)));
            Vec3 origin = MantleBodyAnchor.camPos.add(o.x(), o.y(), o.z());
            double dx = origin.x - player.getX();
            double dy = origin.y - (player.getY() + 1.0);
            double dz = origin.z - player.getZ();
            if (!(dx * dx + dy * dy + dz * dz > 9.0)) {
               Vec3 up = safeNorm(o.x() - py.x(), o.y() - py.y(), o.z() - py.z());
               Vec3 back = safeNorm(pz.x() - o.x(), pz.y() - o.y(), pz.z() - o.z());
               Vec3 right = safeNorm(px.x() - o.x(), px.y() - o.y(), px.z() - o.z());
               if (up != null && back != null && right != null) {
                  Vec3 ownerLerp = new Vec3(
                     Mth.lerp(partialTick, player.xOld, player.getX()),
                     Mth.lerp(partialTick, player.yOld, player.getY()),
                     Mth.lerp(partialTick, player.zOld, player.getZ())
                  );
                  MantleBodyAnchor.CAPTURES
                     .put(player.getId(), new MantleBodyAnchor.Capture(origin, up, back, right, ownerLerp, player.level().getGameTime()));
                  if (MantleBodyAnchor.CAPTURES.size() > 128) {
                     MantleBodyAnchor.CAPTURES.clear();
                  }
               }
            }
         }
      }

      private static Vec3 safeNorm(double x, double y, double z) {
         double len = Math.sqrt(x * x + y * y + z * z);
         return len < 1.0E-6 ? null : new Vec3(x / len, y / len, z / len);
      }
   }
}
