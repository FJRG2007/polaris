package com.scout.symbiote.client.armor;

import com.scout.symbiote.client.RenderStateBridge;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.player.AbstractClientPlayer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent.Stage;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Post;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Pre;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class LivingArmorHideBaseHandler {
   private static boolean inLevelPass = false;

   public static boolean isInLevelPass() {
      return inLevelPass;
   }

   @SubscribeEvent
   public static void onLevelStage(RenderLevelStageEvent event) {
      if (event.getStage() == Stage.AFTER_SKY) {
         inLevelPass = true;
      } else if (event.getStage() == Stage.AFTER_LEVEL) {
         inLevelPass = false;
      }
   }

   /**
    * Forge 1.20.1 called {@code setAllVisible(false)} here. In 1.21.4 the model's setupAnim runs after this event and
    * turns visibility back on, so the base skin is suppressed with {@code skipDraw}, which setupAnim leaves alone.
    * The model is shared by every player with the same skin type, so it is set for each render and cleared after.
    */
   @SubscribeEvent
   public static void onRenderPre(Pre event) {
      AbstractClientPlayer player = RenderStateBridge.player(event.getRenderState());
      setBaseHidden(event.getRenderer().getModel(), player != null && LivingArmorRenderLayer.isFormed(player.getUUID()));
   }

   @SubscribeEvent
   public static void onRenderPost(Post event) {
      setBaseHidden(event.getRenderer().getModel(), false);
   }

   private static void setBaseHidden(PlayerModel model, boolean hidden) {
      model.head.skipDraw = hidden;
      model.hat.skipDraw = hidden;
      model.body.skipDraw = hidden;
      model.jacket.skipDraw = hidden;
      model.rightArm.skipDraw = hidden;
      model.leftArm.skipDraw = hidden;
      model.rightSleeve.skipDraw = hidden;
      model.leftSleeve.skipDraw = hidden;
      model.rightLeg.skipDraw = hidden;
      model.leftLeg.skipDraw = hidden;
      model.rightPants.skipDraw = hidden;
      model.leftPants.skipDraw = hidden;
   }

   private LivingArmorHideBaseHandler() {
   }
}
