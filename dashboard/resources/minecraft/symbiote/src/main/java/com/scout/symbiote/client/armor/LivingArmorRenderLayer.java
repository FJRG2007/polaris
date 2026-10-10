package com.scout.symbiote.client.armor;

import net.minecraft.util.ARGB;
import com.scout.symbiote.client.RenderStateBridge;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.client.render.VanillaSheen;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.model.PlayerModel;
import net.minecraft.client.model.geom.EntityModelSet;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.RenderLayer;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.item.ItemStack;

public class LivingArmorRenderLayer extends RenderLayer<PlayerRenderState, PlayerModel> {
   private static final float UNDER_SCALE = 0.96F;
   private static final ResourceLocation[] TEX_BASE = new ResourceLocation[SymbioteStrain.values().length];
   private static final ResourceLocation[] TEX_EMISSIVE = new ResourceLocation[SymbioteStrain.values().length];
   private static final Map<UUID, Float> PROGRESS;
   private static final float STEP = 0.08F;
   private static long lastCrashLog;
   private static String lastCrashClass;
   private final LivingArmorModel classicModel;

   public static boolean isFormed(UUID id) {
      return PROGRESS.getOrDefault(id, 0.0F) > 0.6F;
   }

   public static float progressOf(UUID id) {
      return PROGRESS.getOrDefault(id, 0.0F);
   }

   public static ResourceLocation baseTexture(SymbioteStrain s) {
      return TEX_BASE[s.ordinal()];
   }

   public static ResourceLocation emissiveTexture(SymbioteStrain s) {
      return TEX_EMISSIVE[s.ordinal()];
   }

   public LivingArmorRenderLayer(RenderLayerParent<PlayerRenderState, PlayerModel> parent, EntityModelSet modelSet) {
      super(parent);
      this.classicModel = new LivingArmorModel(modelSet.bakeLayer(LivingArmorModel.LAYER_LOCATION));
   }

   private LivingArmorModel model() {
      return LivingArmorModel.horrorForm ? HorrorFormModels.get() : this.classicModel;
   }

   @Override
   public void render(PoseStack poseStack, MultiBufferSource bufferSource, int packedLight, PlayerRenderState state, float yRot, float xRot) {
      AbstractClientPlayer player = RenderStateBridge.player(state);
      if (player == null) {
         return;
      }

      EpicFightArmorDiagnostics.layerCall(player);

      try {
         this.renderGuarded(poseStack, bufferSource, packedLight, player, state);
      } catch (Throwable crash) {
         recoverFromCrash(crash);
      }
   }

   private static void recoverFromCrash(Throwable crash) {
      String type = crash.getClass().getName();
      long now = System.currentTimeMillis();
      if (now - lastCrashLog > 30000L || !type.equals(lastCrashClass)) {
         lastCrashLog = now;
         lastCrashClass = type;
         SymbioteLog.event("ARMOR_LAYER_CRASH_SWALLOWED type={} message={}", type, String.valueOf(crash.getMessage()));
      }
   }

   private void renderGuarded(PoseStack poseStack, MultiBufferSource bufferSource, int packedLight, AbstractClientPlayer player, PlayerRenderState state) {
      float limbSwing = state.walkAnimationPos;
      float limbSwingAmount = state.walkAnimationSpeed;
      float ageInTicks = state.ageInTicks;
      boolean local = player == Minecraft.getInstance().player;
      boolean dbg = (Boolean)SymbioteConfig.VERBOSE_LOGGING.get() && local && player.tickCount % 10 == 0;
      if (player.isInvisible()) {
         if (dbg) {
            SymbioteLog.event("ARMOR_LAYER_DEBUG bail=invisible");
         }
      } else {
         boolean active;
         SymbioteStrain strain;
         if (local) {
            active = SymbioteClientState.isBonded() && SymbioteClientState.isLivingArmorActive();
            strain = SymbioteClientState.getStrain();
         } else {
            active = ArmorStateClientCache.isActive(player.getUUID());
            strain = ArmorStateClientCache.strainOf(player.getUUID());
         }

         UUID id = player.getUUID();
         float progress = PROGRESS.getOrDefault(id, 0.0F);
         float target = active ? 1.0F : 0.0F;
         progress += Math.signum(target - progress) * 0.08F;
         progress = Math.max(0.0F, Math.min(1.0F, progress));
         if (progress <= 0.001F && !active) {
            if (dbg) {
               SymbioteLog.event("ARMOR_LAYER_DEBUG bail=retracted active=false");
            }

            PROGRESS.remove(id);
         } else {
            PROGRESS.put(id, progress);
            boolean inWorld = LivingArmorHideBaseHandler.isInLevelPass();
            boolean headless = local && inWorld && Minecraft.getInstance().options.getCameraType().isFirstPerson();
            if (dbg) {
               SymbioteLog.event(
                  "ARMOR_LAYER_DEBUG draw progress={} active={} inWorld={} headless={} covers={}",
                  progress,
                  active,
                  inWorld,
                  headless,
                  ArmorStateClientCache.coversGear(id)
               );
            }

            boolean covers = ArmorStateClientCache.coversGear(id);
            boolean tucked = false;
            if (!covers) {
               for (ItemStack st : player.getInventory().armor) {
                  if (!st.isEmpty()) {
                     tucked = true;
                     break;
                  }
               }
            }

            if (tucked) {
               poseStack.pushPose();
               poseStack.translate(0.0, 0.060040034F, 0.0);
               poseStack.scale(0.96F, 0.96F, 0.96F);
            }

            try {
               LivingArmorModel model = this.model();
               model.setupAnim(state);
               PlayerModel pm = this.getParentModel();
               model.head.copyFrom(pm.head);
               model.hat.copyFrom(pm.hat);
               model.head.visible = !headless;
               model.hat.visible = !headless;
               model.body.copyFrom(pm.body);
               model.leftArm.copyFrom(pm.leftArm);
               model.rightArm.copyFrom(pm.rightArm);
               model.leftLeg.copyFrom(pm.leftLeg);
               model.rightLeg.copyFrom(pm.rightLeg);
               model.applyLivingMotion(player, limbSwing, limbSwingAmount, ageInTicks);
               int si = strain.ordinal();
               boolean formed = progress >= 0.99F;
               VanillaSheen.Consumer base = new VanillaSheen.Consumer(
                  formed ? bufferSource.getBuffer(RenderType.armorCutoutNoCull(TEX_BASE[si])) : bufferSource.getBuffer(RenderType.entityTranslucent(TEX_BASE[si])), 15.0F, 0.5F
               );
               model.renderToBuffer(poseStack, base, packedLight, OverlayTexture.NO_OVERLAY, ARGB.colorFromFloat(formed ? 1.0F : progress, 1.0F, 1.0F, 1.0F));
               LivingArmorTendrils.render(poseStack, bufferSource, packedLight, model.body, model.rightArm, model.leftArm, strain, ageInTicks, progress);
               float glowPulse = Mth.clamp(
                  progress * (0.72F + Mth.sin(ageInTicks * 0.33F) * 0.18F + Mth.sin(ageInTicks * 1.17F + player.getId()) * 0.07F), 0.18F, 1.0F
               );
               VertexConsumer glow = bufferSource.getBuffer(RenderType.eyes(TEX_EMISSIVE[si]));
               model.renderToBuffer(poseStack, glow, packedLight, OverlayTexture.NO_OVERLAY, ARGB.colorFromFloat(1.0F, glowPulse, glowPulse, glowPulse));
               if (local && SymbioteClientState.isGrafted()) {
                  int gi = SymbioteClientState.getGraftStrain().ordinal();
                  if (gi != si) {
                     VertexConsumer wash = bufferSource.getBuffer(RenderType.entityTranslucent(TEX_BASE[gi]));
                     model.renderToBuffer(poseStack, wash, packedLight, OverlayTexture.NO_OVERLAY, ARGB.colorFromFloat(0.34F * progress, 1.0F, 1.0F, 1.0F));
                  }

                  float g2 = Mth.clamp(progress * (0.44F + Mth.sin(ageInTicks * 0.27F + 1.9F) * 0.16F), 0.1F, 0.7F);
                  VertexConsumer glow2 = bufferSource.getBuffer(RenderType.eyes(TEX_EMISSIVE[gi]));
                  model.renderToBuffer(poseStack, glow2, packedLight, OverlayTexture.NO_OVERLAY, ARGB.colorFromFloat(1.0F, g2, g2, g2));
               }
            } finally {
               if (tucked) {
                  poseStack.popPose();
               }
            }
         }
      }
   }

   static {
      for (SymbioteStrain s : SymbioteStrain.values()) {
         String n = s.getSerializedName();
         TEX_BASE[s.ordinal()] = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/living_armor_" + n + ".png");
         TEX_EMISSIVE[s.ordinal()] = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/living_armor_" + n + "_emissive.png");
      }

      PROGRESS = new HashMap<>();
      lastCrashClass = "";
   }
}
