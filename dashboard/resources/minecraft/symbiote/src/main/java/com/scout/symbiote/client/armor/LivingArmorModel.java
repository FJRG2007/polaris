package com.scout.symbiote.client.armor;

import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.util.ARGB;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import net.minecraft.client.model.HumanoidModel;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeDeformation;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;

public class LivingArmorModel extends HumanoidModel<PlayerRenderState> {
   public static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(ResourceLocation.fromNamespaceAndPath("symbiote", "living_armor"), "main");
   public static boolean horrorForm = false;
   public static final ModelLayerLocation HORROR_LAYER_LOCATION = new ModelLayerLocation(ResourceLocation.fromNamespaceAndPath("symbiote", "living_armor"), "horror");
   private final ModelPart chestKnotCore = this.body.getChild("chest_knot_core");
   private final ModelPart leftEyeFlame = this.head.getChild("left_eye_flame");
   private final ModelPart rightEyeFlame = this.head.getChild("right_eye_flame");
   private final ModelPart[] headTendrils = new ModelPart[]{
      this.head.getChild("crown_tendril_left"),
      this.head.getChild("crown_tendril_right"),
      this.head.getChild("jaw_tendril_left"),
      this.head.getChild("jaw_tendril_right")
   };
   private final ModelPart[] armTendrils = new ModelPart[]{
      this.leftArm.getChild("outer_arm_tendril_high"), this.leftArm.getChild("outer_arm_tendril_low")
   };
   private final ModelPart forearmMouthRidge = this.leftArm.getChild("forearm_mouth_ridge");
   private static final float[] HEAD_TENDRIL_BASE_X = new float[]{-0.24F, -0.24F, 0.14F, 0.14F};
   private static final float[] HEAD_TENDRIL_BASE_Y = new float[]{0.16F, -0.16F, 0.08F, -0.08F};
   private static final float[] HEAD_TENDRIL_BASE_Z = new float[]{-0.32F, 0.32F, -0.52F, 0.52F};
   private static final float[] ARM_TENDRIL_BASE_X = new float[]{0.18F, -0.15F};
   private static final float[] ARM_TENDRIL_BASE_Y = new float[]{0.2F, -0.24F};
   private static final float[] ARM_TENDRIL_BASE_Z = new float[]{-0.58F, -0.42F};
   public static float ARM_DROP = 4.5F;
   public static float CLAW_LEN = 4.0F;
   public static float HEAD_SINK = 2.4F;
   public static float LEG_LEN = 16.0F;

   public LivingArmorModel(ModelPart root) {
      super(root);
   }

   public static LayerDefinition createBodyLayer() {
      MeshDefinition mesh = HumanoidModel.createMesh(CubeDeformation.NONE, 0.0F);
      PartDefinition root = mesh.getRoot();
      PartDefinition body = root.addOrReplaceChild(
         "body",
         CubeListBuilder.create()
            .texOffs(16, 16)
            .addBox(-4.55F, -0.35F, -2.25F, 9.1F, 4.7F, 4.5F, new CubeDeformation(0.26F))
            .texOffs(16, 16)
            .addBox(-3.85F, 3.75F, -2.18F, 7.7F, 3.45F, 4.35F, new CubeDeformation(0.18F))
            .texOffs(16, 16)
            .addBox(-3.25F, 7.0F, -2.12F, 6.5F, 5.2F, 4.25F, new CubeDeformation(0.14F))
            .texOffs(48, 0)
            .addBox(-5.55F, 0.0F, -1.95F, 1.0F, 4.9F, 3.9F)
            .addBox(4.55F, 0.0F, -1.95F, 1.0F, 4.9F, 3.9F)
            .addBox(-0.8F, 0.2F, 2.35F, 1.6F, 7.1F, 1.25F)
            .texOffs(16, 16)
            .addBox(-4.0F, -0.2F, -3.0F, 3.4F, 2.6F, 0.55F)
            .addBox(0.6F, -0.2F, -3.0F, 3.4F, 2.6F, 0.55F)
            .addBox(-4.2F, 3.4F, -2.7F, 1.8F, 3.2F, 0.5F)
            .addBox(2.4F, 3.4F, -2.7F, 1.8F, 3.2F, 0.5F)
            .addBox(-3.8F, 6.6F, -2.9F, 3.4F, 2.6F, 0.5F)
            .addBox(0.4F, 6.6F, -2.9F, 3.4F, 2.6F, 0.5F),
         PartPose.offset(0.0F, 0.0F, 0.0F)
      );
      body.addOrReplaceChild(
         "chest_knot_core",
         CubeListBuilder.create().texOffs(64, 8).addBox(-0.95F, -0.95F, -0.45F, 1.9F, 1.9F, 0.9F, new CubeDeformation(0.08F)),
         PartPose.offset(0.0F, 4.35F, -3.05F)
      );
      PartDefinition head = root.addOrReplaceChild(
         "head",
         CubeListBuilder.create().texOffs(0, 0).addBox(-4.0F, -8.75F, -4.0F, 8.0F, 8.75F, 8.0F, new CubeDeformation(0.5F)),
         PartPose.offset(0.0F, -0.2F, 0.0F)
      );
      head.addOrReplaceChild("left_eye_flame", CubeListBuilder.create(), PartPose.offsetAndRotation(-2.25F, -3.75F, -4.32F, 0.0F, 0.0F, -0.22F));
      head.addOrReplaceChild("right_eye_flame", CubeListBuilder.create(), PartPose.offsetAndRotation(2.25F, -3.75F, -4.32F, 0.0F, 0.0F, 0.22F));
      head.addOrReplaceChild("crown_tendril_left", crownTendrilBuilder(3.2F), PartPose.offsetAndRotation(-2.6F, -7.15F, -2.35F, -0.32F, 0.18F, -0.42F));
      head.addOrReplaceChild("crown_tendril_right", crownTendrilBuilder(3.2F), PartPose.offsetAndRotation(2.6F, -7.15F, -2.35F, -0.32F, -0.18F, 0.42F));
      head.addOrReplaceChild("jaw_tendril_left", crownTendrilBuilder(2.0F), PartPose.offsetAndRotation(-3.7F, -2.5F, -4.0F, 0.18F, 0.1F, -0.75F));
      head.addOrReplaceChild("jaw_tendril_right", crownTendrilBuilder(2.0F), PartPose.offsetAndRotation(3.7F, -2.5F, -4.0F, 0.18F, -0.1F, 0.75F));
      root.addOrReplaceChild(
         "right_arm",
         CubeListBuilder.create()
            .texOffs(40, 16)
            .addBox(-3.75F, -2.6F, -2.3F, 4.75F, 5.1F, 4.6F, new CubeDeformation(0.22F))
            .texOffs(40, 16)
            .addBox(-3.55F, 2.0F, -2.35F, 4.75F, 9.7F, 4.7F, new CubeDeformation(0.18F))
            .texOffs(96, 0)
            .addBox(-3.75F, -3.0F, -1.0F, 0.8F, 2.3F, 2.0F),
         PartPose.offset(-5.0F, 2.0F, 0.0F)
      );
      PartDefinition leftArm = root.addOrReplaceChild(
         "left_arm",
         CubeListBuilder.create()
            .texOffs(40, 16)
            .mirror()
            .addBox(-1.05F, -2.45F, -2.35F, 4.85F, 5.85F, 4.7F, new CubeDeformation(0.22F))
            .texOffs(40, 16)
            .mirror()
            .addBox(-0.85F, 3.55F, -2.25F, 4.35F, 6.2F, 4.5F, new CubeDeformation(0.24F))
            .texOffs(96, 0)
            .mirror()
            .addBox(3.1F, -3.25F, -1.65F, 1.15F, 4.4F, 3.3F),
         PartPose.offset(5.0F, 2.0F, 0.0F)
      );
      leftArm.addOrReplaceChild("outer_arm_tendril_high", armTendrilBuilder(5.3F), PartPose.offsetAndRotation(3.75F, 1.15F, -0.85F, 0.18F, 0.2F, -0.58F));
      leftArm.addOrReplaceChild("outer_arm_tendril_low", armTendrilBuilder(4.6F), PartPose.offsetAndRotation(3.35F, 5.8F, 1.15F, -0.15F, -0.24F, -0.42F));
      leftArm.addOrReplaceChild(
         "forearm_mouth_ridge",
         CubeListBuilder.create().texOffs(112, 0).addBox(-0.35F, -2.4F, -0.45F, 0.7F, 4.8F, 0.9F, new CubeDeformation(0.04F)),
         PartPose.offsetAndRotation(3.2F, 6.3F, -2.65F, 0.0F, 0.0F, -0.22F)
      );
      root.addOrReplaceChild(
         "right_leg",
         CubeListBuilder.create()
            .texOffs(0, 16)
            .addBox(-2.2F, 0.0F, -2.0F, 4.4F, 5.3F, 4.0F, new CubeDeformation(0.1F))
            .texOffs(0, 16)
            .addBox(-2.05F, 5.0F, -2.05F, 4.1F, 6.4F, 4.1F, new CubeDeformation(0.05F))
            .texOffs(96, 0)
            .addBox(-2.55F, 10.25F, -2.95F, 5.1F, 1.65F, 1.55F),
         PartPose.offset(-1.9F, 12.0F, 0.0F)
      );
      root.addOrReplaceChild(
         "left_leg",
         CubeListBuilder.create()
            .texOffs(0, 16)
            .mirror()
            .addBox(-2.2F, 0.0F, -2.0F, 4.4F, 5.3F, 4.0F, new CubeDeformation(0.1F))
            .texOffs(0, 16)
            .mirror()
            .addBox(-2.05F, 5.0F, -2.05F, 4.1F, 6.4F, 4.1F, new CubeDeformation(0.05F))
            .texOffs(96, 0)
            .mirror()
            .addBox(-2.55F, 10.25F, -2.95F, 5.1F, 1.65F, 1.55F)
            .texOffs(112, 0)
            .mirror()
            .addBox(-1.0F, 4.8F, -2.75F, 2.0F, 4.2F, 0.8F),
         PartPose.offset(1.9F, 12.0F, 0.0F)
      );
      head.addOrReplaceChild("hat", CubeListBuilder.create(), PartPose.offset(0.0F, 0.0F, 0.0F));
      return LayerDefinition.create(mesh, 128, 64);
   }

   private static float lift() {
      return LEG_LEN - 12.0F;
   }

   public static LayerDefinition createHorrorBodyLayer() {
      MeshDefinition mesh = HumanoidModel.createMesh(CubeDeformation.NONE, 0.0F);
      PartDefinition root = mesh.getRoot();
      PartDefinition body = root.addOrReplaceChild(
         "body",
         CubeListBuilder.create()
            .texOffs(16, 16)
            .addBox(-4.0F, 0.0F, -2.0F, 8.0F, 12.0F, 4.0F, new CubeDeformation(0.1F))
            .texOffs(16, 16)
            .addBox(-4.2F, 1.0F, -2.9F, 3.0F, 4.5F, 1.0F)
            .addBox(-3.4F, 6.2F, -2.8F, 2.2F, 3.0F, 0.9F)
            .addBox(1.4F, 2.4F, -2.7F, 2.4F, 2.6F, 0.8F)
            .texOffs(48, 0)
            .addBox(-0.9F, 0.5F, 1.9F, 1.8F, 9.0F, 1.4F),
         PartPose.offset(0.0F, -lift(), 0.0F)
      );
      body.addOrReplaceChild(
         "shoulder_mass",
         CubeListBuilder.create()
            .texOffs(48, 0)
            .addBox(-4.6F, -2.2F, -3.0F, 5.2F, 4.6F, 6.0F)
            .texOffs(48, 0)
            .addBox(-4.2F, 2.0F, -2.6F, 3.6F, 3.8F, 5.2F)
            .texOffs(48, 0)
            .addBox(-3.6F, 5.4F, -2.2F, 2.4F, 3.2F, 4.2F)
            .texOffs(112, 0)
            .addBox(-4.9F, 0.4F, -1.0F, 1.2F, 5.0F, 2.0F),
         PartPose.offset(-3.4F, 0.6F, 0.0F)
      );
      body.addOrReplaceChild(
         "shoulder_nub", CubeListBuilder.create().texOffs(48, 0).addBox(0.0F, 0.0F, -1.8F, 1.8F, 3.4F, 3.6F), PartPose.offset(4.0F, 0.4F, 0.0F)
      );
      body.addOrReplaceChild(
         "chest_knot_core",
         CubeListBuilder.create().texOffs(64, 8).addBox(-0.95F, -0.95F, -0.45F, 1.9F, 1.9F, 0.9F, new CubeDeformation(0.08F)),
         PartPose.offset(-1.2F, 4.6F, -2.9F)
      );
      PartDefinition head = root.addOrReplaceChild(
         "head",
         CubeListBuilder.create()
            .texOffs(0, 0)
            .addBox(-3.4F, -6.2F, -3.4F, 6.8F, 6.2F, 6.8F)
            .texOffs(0, 0)
            .addBox(-4.6F, -8.0F, -2.8F, 3.8F, 3.6F, 5.6F)
            .texOffs(48, 0)
            .addBox(-4.2F, -4.6F, -2.4F, 1.4F, 4.0F, 4.8F)
            .texOffs(48, 0)
            .addBox(2.6F, -5.4F, -1.6F, 1.6F, 2.6F, 3.4F)
            .texOffs(0, 0)
            .addBox(-2.4F, -1.2F, -2.4F, 4.8F, 2.0F, 4.8F),
         PartPose.offset(0.0F, HEAD_SINK - lift(), 0.0F)
      );
      head.addOrReplaceChild(
         "socket",
         CubeListBuilder.create().texOffs(112, 0).addBox(-1.3F, -1.3F, -0.5F, 2.6F, 2.6F, 0.5F),
         PartPose.offsetAndRotation(-1.5F, -4.2F, -3.5F, 0.0F, -0.18F, 0.12F)
      );
      head.addOrReplaceChild("left_eye_flame", CubeListBuilder.create(), PartPose.offset(-2.25F, -3.75F, -3.5F));
      head.addOrReplaceChild("right_eye_flame", CubeListBuilder.create(), PartPose.offset(2.25F, -3.75F, -3.5F));
      head.addOrReplaceChild("crown_tendril_left", crownTendrilBuilder(4.2F), PartPose.offsetAndRotation(-3.2F, -7.6F, -1.4F, -0.34F, 0.2F, -0.56F));
      head.addOrReplaceChild("crown_tendril_right", crownTendrilBuilder(1.8F), PartPose.offsetAndRotation(2.9F, -5.2F, -1.2F, -0.28F, -0.16F, 0.3F));
      head.addOrReplaceChild("jaw_tendril_left", crownTendrilBuilder(2.8F), PartPose.offsetAndRotation(-3.4F, -1.6F, -3.0F, 0.22F, 0.12F, -0.88F));
      head.addOrReplaceChild("jaw_tendril_right", crownTendrilBuilder(1.3F), PartPose.offsetAndRotation(3.1F, -2.2F, -2.8F, 0.16F, -0.1F, 0.6F));
      PartDefinition rightArm = root.addOrReplaceChild(
         "right_arm",
         CubeListBuilder.create()
            .texOffs(40, 16)
            .addBox(-3.5F, -2.5F, -2.5F, 5.0F, 6.0F, 5.0F)
            .texOffs(40, 16)
            .addBox(-4.4F, -1.2F, -1.8F, 1.6F, 3.4F, 3.6F)
            .texOffs(40, 16)
            .addBox(-2.5F, 3.4F, -1.5F, 3.0F, 6.6F + ARM_DROP, 3.0F),
         PartPose.offset(-5.0F, 2.0F - lift(), 0.0F)
      );
      addClaw(rightArm, -1.0F, 10.0F + ARM_DROP, -1);
      PartDefinition leftArm = root.addOrReplaceChild(
         "left_arm",
         CubeListBuilder.create()
            .texOffs(40, 16)
            .mirror()
            .addBox(-1.5F, -2.6F, -2.7F, 5.4F, 6.6F, 5.4F)
            .texOffs(40, 16)
            .mirror()
            .addBox(2.9F, -1.4F, -2.0F, 1.8F, 4.0F, 4.0F)
            .texOffs(40, 16)
            .mirror()
            .addBox(-0.4F, 4.0F, -1.6F, 3.2F, 6.0F + ARM_DROP, 3.2F),
         PartPose.offset(5.0F, 2.0F - lift(), 0.0F)
      );
      addClaw(leftArm, 1.2F, 10.0F + ARM_DROP, 1);
      leftArm.addOrReplaceChild("outer_arm_tendril_high", armTendrilBuilder(5.3F), PartPose.offsetAndRotation(3.9F, 1.0F, -0.8F, 0.18F, 0.2F, -0.58F));
      leftArm.addOrReplaceChild("outer_arm_tendril_low", armTendrilBuilder(4.6F), PartPose.offsetAndRotation(3.1F, 6.2F, 1.1F, -0.15F, -0.24F, -0.42F));
      leftArm.addOrReplaceChild(
         "forearm_mouth_ridge",
         CubeListBuilder.create().texOffs(112, 0).addBox(-0.35F, -2.4F, -0.45F, 0.7F, 4.8F, 0.9F, new CubeDeformation(0.04F)),
         PartPose.offsetAndRotation(2.6F, 7.0F, -2.0F, 0.0F, 0.0F, -0.22F)
      );
      root.addOrReplaceChild("right_leg", legBuilder(false), PartPose.offset(-1.9F, 12.0F - lift(), 0.0F));
      root.addOrReplaceChild("left_leg", legBuilder(true), PartPose.offset(1.9F, 12.0F - lift(), 0.0F));
      head.addOrReplaceChild("hat", CubeListBuilder.create(), PartPose.offset(0.0F, 0.0F, 0.0F));
      return LayerDefinition.create(mesh, 128, 64);
   }

   private static CubeListBuilder legBuilder(boolean mirror) {
      float thigh = LEG_LEN * 0.44F;
      float shin = LEG_LEN * 0.48F;
      float footTop = thigh + shin - 0.4F;
      CubeListBuilder b = CubeListBuilder.create();
      if (mirror) {
         b = b.mirror();
      }

      return b.texOffs(0, 16)
         .addBox(-2.0F, 0.0F, -2.0F, 4.0F, thigh, 4.0F)
         .texOffs(0, 16)
         .addBox(mirror ? 1.7F : -2.9F, thigh * 0.2F, -1.6F, 1.2F, thigh * 0.55F, 3.2F)
         .texOffs(0, 16)
         .addBox(-1.5F, thigh - 0.3F, -1.5F, 3.0F, shin, 3.0F)
         .texOffs(96, 0)
         .addBox(-2.0F, footTop, -3.2F, 4.0F, 1.6F, 5.2F);
   }

   private static void addClaw(PartDefinition arm, float x, float y, int dir) {
      for (int i = 0; i < 4; i++) {
         float len = CLAW_LEN * (0.68F + 0.18F * (i % 3));
         float spread = i - 1.5F;
         arm.addOrReplaceChild(
            "claw_" + i,
            CubeListBuilder.create().texOffs(112, 0).addBox(-0.4F, 0.0F, -0.4F, 0.8F, len, 0.8F),
            PartPose.offsetAndRotation(x + spread * 0.62F, y, spread * 0.42F, 0.1F + i * 0.06F, 0.0F, dir * (0.08F + i * 0.05F))
         );
      }
   }

   private static CubeListBuilder crownTendrilBuilder(float length) {
      return CubeListBuilder.create().texOffs(112, 0).addBox(-0.22F, -length, -0.22F, 0.44F, length, 0.44F, new CubeDeformation(0.03F));
   }

   private static CubeListBuilder armTendrilBuilder(float length) {
      return CubeListBuilder.create().texOffs(112, 0).addBox(-0.28F, -length, -0.28F, 0.56F, length, 0.56F, new CubeDeformation(0.04F));
   }

   public void applyLivingMotion(AbstractClientPlayer entity, float limbSwing, float limbSwingAmount, float ageInTicks) {
      float t = ageInTicks + entity.getId() % 19 * 1.73F;
      float motion = Mth.clamp(limbSwingAmount, 0.0F, 1.0F);
      float slowBreath = wave(t, 0.16F, 0.0F);
      float quickTissue = wave(t, 0.57F, 1.4F);
      float heartbeat = pulse(t, 0.42F, 0.6F);
      float stride = Mth.sin(limbSwing * 0.6662F);
      float roll = stride * motion;
      float idleSway = wave(t, 0.18F, 0.0F);
      this.body.yRot += roll * 0.06F + idleSway * 0.01F;
      this.body.xScale = 1.0F + slowBreath * 0.024F + heartbeat * 0.018F;
      this.body.yScale = 1.0F + wave(t, 0.19F, 2.0F) * 0.01F;
      this.body.zScale = 1.0F + slowBreath * 0.032F + heartbeat * 0.026F;
      this.head.xScale = 1.0F + quickTissue * 0.006F;
      this.head.yScale = 1.0F + wave(t, 0.24F, 1.0F) * 0.007F;
      this.head.zScale = 1.0F + quickTissue * 0.006F;
      this.rightArm.xScale = 1.0F + wave(t, 0.21F, 2.2F) * 0.008F;
      this.rightArm.yScale = 1.0F + wave(t, 0.17F, 0.5F) * 0.006F;
      this.rightArm.zScale = 1.0F + wave(t, 0.21F, 2.2F) * 0.008F;
      this.leftArm.xScale = 1.025F + heartbeat * 0.035F + wave(t, 0.31F, 1.7F) * 0.012F;
      this.leftArm.yScale = 1.015F + wave(t, 0.22F, 0.4F) * 0.012F;
      this.leftArm.zScale = 1.035F + heartbeat * 0.04F + wave(t, 0.35F, 2.6F) * 0.015F;
      this.leftArm.yRot = this.leftArm.yRot + wave(t, 0.2F, 0.7F) * 0.045F;
      this.leftArm.zRot = this.leftArm.zRot + wave(t, 0.18F, 1.9F) * 0.035F;
      this.rightLeg.xScale = 1.0F + wave(t, 0.2F, 0.0F) * 0.007F;
      this.rightLeg.zScale = this.rightLeg.xScale;
      this.leftLeg.xScale = 1.0F + wave(t, 0.23F, 1.2F) * 0.009F;
      this.leftLeg.zScale = this.leftLeg.xScale;
      this.chestKnotCore.xScale = 1.0F + heartbeat * 0.16F;
      this.chestKnotCore.yScale = 1.0F + heartbeat * 0.16F;
      this.chestKnotCore.zScale = 1.0F + heartbeat * 0.28F;
      this.chestKnotCore.y = 4.35F + wave(t, 0.3F, 1.1F) * 0.035F;
      this.chestKnotCore.z = -3.05F - heartbeat * 0.12F;
      float eyePulse = 0.5F + 0.5F * wave(t, 0.72F, 0.3F);
      float eyeTwitch = wave(t, 2.15F, 0.9F) * 0.02F;
      this.leftEyeFlame.zRot = -0.22F - eyePulse * 0.045F + eyeTwitch;
      this.rightEyeFlame.zRot = 0.22F + eyePulse * 0.045F - eyeTwitch;
      this.leftEyeFlame.yScale = 1.0F + eyePulse * 0.1F;
      this.rightEyeFlame.yScale = 1.0F + (1.0F - eyePulse * 0.35F) * 0.07F;
      this.leftEyeFlame.xScale = 0.88F + eyePulse * 0.07F;
      this.rightEyeFlame.xScale = 0.94F + wave(t, 0.64F, 2.0F) * 0.05F;
      this.leftEyeFlame.y = -3.75F - eyePulse * 0.05F;
      this.rightEyeFlame.y = -3.75F - (1.0F - eyePulse) * 0.04F;

      for (int i = 0; i < this.headTendrils.length; i++) {
         ModelPart tendril = this.headTendrils[i];
         float phase = i * 1.9F;
         tendril.xRot = HEAD_TENDRIL_BASE_X[i] + wave(t, 0.33F, phase) * 0.15F;
         tendril.yRot = HEAD_TENDRIL_BASE_Y[i] + wave(t, 0.29F, phase + 1.0F) * 0.18F;
         tendril.zRot = HEAD_TENDRIL_BASE_Z[i] + wave(t, 0.43F, phase + 2.0F) * 0.2F;
         tendril.yScale = 1.0F + wave(t, 0.47F, phase + 0.2F) * 0.08F;
         tendril.xScale = 1.0F + wave(t, 0.55F, phase + 2.6F) * 0.035F;
         tendril.zScale = tendril.xScale;
      }

      for (int i = 0; i < this.armTendrils.length; i++) {
         ModelPart tendril = this.armTendrils[i];
         float phase = i * 2.4F + motion * 1.2F;
         tendril.xRot = ARM_TENDRIL_BASE_X[i] + wave(t, 0.46F, phase) * 0.2F;
         tendril.yRot = ARM_TENDRIL_BASE_Y[i] + wave(t, 0.38F, phase + 0.8F) * 0.18F;
         tendril.zRot = ARM_TENDRIL_BASE_Z[i] + wave(t, 0.52F, phase + 1.6F) * 0.24F;
         tendril.yScale = 1.0F + wave(t, 0.61F, phase) * 0.1F + heartbeat * 0.05F;
      }

      this.forearmMouthRidge.zRot = -0.22F + wave(t, 0.55F, 1.4F) * 0.1F;
      this.forearmMouthRidge.xScale = 1.0F + heartbeat * 0.08F;
      this.forearmMouthRidge.zScale = 1.0F + heartbeat * 0.1F;
      if (horrorForm) {
         this.applyHorrorGait(limbSwing, motion, t, heartbeat);
      }
   }

   private void applyHorrorGait(float limbSwing, float motion, float t, float heartbeat) {
      float stride = Mth.cos(limbSwing * 0.6662F) * motion;
      float strideHalf = Mth.cos(limbSwing * 0.3331F) * motion;
      float drag = 0.55F + 0.45F * strideHalf;
      this.rightLeg.xRot += stride * 0.34F * motion;
      this.leftLeg.xRot += -stride * 0.34F * motion * drag;
      this.rightLeg.zRot += 0.05F + stride * 0.05F * motion;
      this.leftLeg.zRot += -0.07F - stride * 0.04F * motion;
      this.body.zRot += strideHalf * 0.055F * motion;
      this.body.y = this.body.y + (0.35F + 0.55F * Math.abs(stride)) * motion;
      this.body.xRot = this.body.xRot + (0.03F * motion + Math.abs(stride) * 0.02F * motion);
      this.rightArm.xRot += -stride * 0.055F * motion;
      this.leftArm.xRot += stride * 0.045F * motion;
      this.rightArm.zRot += 0.035F + stride * 0.02F * motion;
      this.leftArm.zRot += -0.055F - stride * 0.02F * motion;
      this.head.zRot = this.head.zRot + (-strideHalf * 0.045F * motion + wave(t, 0.14F, 0.0F) * 0.02F);
      this.head.xRot = this.head.xRot + (0.06F + Math.abs(stride) * 0.035F * motion + heartbeat * 0.015F);
   }

   private static float wave(float time, float speed, float phase) {
      return Mth.sin(time * speed + phase);
   }

   private static float pulse(float time, float speed, float phase) {
      float v = 0.5F + 0.5F * Mth.sin(time * speed + phase);
      return v * v * v;
   }

   /** 1.20.1-style float tint; 1.21.4 models take one packed ARGB color. */
   public void renderToBuffer(PoseStack poseStack, VertexConsumer buffer, int packedLight, int packedOverlay, float red, float green, float blue, float alpha) {
      this.renderToBuffer(poseStack, buffer, packedLight, packedOverlay, ARGB.colorFromFloat(alpha, red, green, blue));
   }
}
