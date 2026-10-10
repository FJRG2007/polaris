package com.scout.symbiote.client.bloom;

import com.scout.symbiote.client.RenderStateBridge;
import com.scout.symbiote.client.SymbioteClientState;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.PlayerModel;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Post;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Pre;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class BloomHeadHandler {
   private static boolean applied = false;

   @SubscribeEvent
   public static void onRenderPre(Pre event) {
      if (Minecraft.getInstance().player != null && RenderStateBridge.player(event.getRenderState()) == Minecraft.getInstance().player) {
         if (Minecraft.getInstance().level != null) {
            float progress = BloomRenderLayer.preview
               ? 1.0F
               : SymbioteClientState.getBloomProgress(Minecraft.getInstance().level.getGameTime(), event.getPartialTick());
            if (!(progress <= 0.01F)) {
               float scale = 1.0F - (1.0F - BloomRenderLayer.HEAD_CORE) * progress;
               PlayerModel model = event.getRenderer().getModel();
               setScale(model, scale);
               applied = true;
            }
         }
      }
   }

   @SubscribeEvent
   public static void onRenderPost(Post event) {
      if (applied) {
         setScale(event.getRenderer().getModel(), 1.0F);
         applied = false;
      }
   }

   private static void setScale(PlayerModel model, float s) {
      model.head.xScale = s;
      model.head.yScale = s;
      model.head.zScale = s;
      model.hat.xScale = s;
      model.hat.yScale = s;
      model.hat.zScale = s;
   }

   private BloomHeadHandler() {
   }
}
