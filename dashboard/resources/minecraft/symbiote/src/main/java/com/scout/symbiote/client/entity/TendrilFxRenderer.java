package com.scout.symbiote.client.entity;

import com.scout.symbiote.client.render.Verts;
import net.minecraft.util.ARGB;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.math.Axis;
import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.client.MantleBodyAnchor;
import com.scout.symbiote.client.MantleTuneScreen;
import com.scout.symbiote.client.render.VanillaSheen;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.tracker.SymbioteStrain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.client.renderer.entity.EntityRendererProvider.Context;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.joml.Matrix3f;
import org.joml.Matrix4f;
import org.joml.Vector3f;

public class TendrilFxRenderer extends EntityRenderer<TendrilFxEntity, TendrilFxRenderer.State> {
   /**
    * 1.21.4 renders from a per-frame snapshot. The tendril spline reads its owner, target and synced data from the
    * live entity every frame, so the snapshot carries the entity and the partial tick the Forge renderer received.
    */
   public static final class State extends EntityRenderState {
      public TendrilFxEntity entity;
      public float partialTick;
   }

   private static final ResourceLocation TEX_GUARDIAN = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_guardian.png");
   private static final ResourceLocation TEX_PREDATOR = ResourceLocation.fromNamespaceAndPath("symbiote", "textures/entity/tendril_fx_predator.png");
   private static final int SPLINE_POINTS = 32;
   private static final int RING_SIDES = 12;
   private static final float REACH_END = 0.25F;
   private static final float HOLD_END = 0.85F;
   private static final float WHIP_EXTEND_END = 0.15F;
   private static final float WHIP_APEX_END = 0.25F;
   private static final float WHIP_OVERSHOOT = 1.35F;
   private static final float RADIUS_ROOT = 0.17F;
   private static final float RADIUS_TIP = 0.075F;
   private static final float MID_BULGE_ADD = 0.045F;
   private static final float TIP_SQUEEZE = 0.18F;
   private static final int RIDGES = 3;
   private static final float RIDGE_RADIUS_FRAC = 0.18F;
   private static final float RIDGE_SURFACE_OFFSET = 1.18F;
   public static float MANTLE_ROOT_BACK = 0.02F;
   public static float MANTLE_ROOT_BACK_SPREAD = 0.04F;
   public static float MANTLE_ROOT_SIDE = 0.22F;
   public static float MANTLE_ROOT_HEIGHT = 1.27F;
   public static float MANTLE_ROOT_HEIGHT_CENTER = -0.02F;
   public static float MANTLE_ARC_BACK = 0.97F;
   public static float MANTLE_ARC_BACK_SPREAD = 0.94F;
   public static float MANTLE_ARC_LIFT = 0.58F;
   public static float MANTLE_ARC_LIFT_CENTER = 0.38F;
   public static float MANTLE_ARC2_BACK = 0.22F;
   public static float MANTLE_ARC2_LIFT = 0.64F;
   public static float MANTLE_SIDE = 1.38F;
   public static float MANTLE_BACK = -0.42F;
   public static float MANTLE_BACK_SPREAD = -0.04F;
   public static float MANTLE_HEIGHT = 1.74F;
   public static float MANTLE_HEIGHT_CENTER = 0.82F;
   private static final float CROWN_ROOT_BACK = 0.34F;
   private static final float CROWN_ROOT_BACK_SPREAD = 0.1F;
   private static final float CROWN_ROOT_SIDE = 0.34F;
   private static final float CROWN_ROOT_HEIGHT = 1.42F;
   private static final float CROWN_ROOT_HEIGHT_CENTER = 0.18F;
   private static final float CROWN_ARC_BACK = 0.42F;
   private static final float CROWN_ARC_BACK_SPREAD = 0.22F;
   private static final float CROWN_ARC_LIFT = 0.58F;
   private static final float CROWN_ARC_LIFT_CENTER = 0.34F;
   private static final float CROWN_ARC2_BACK = 0.18F;
   private static final float CROWN_ARC2_LIFT = 0.16F;
   private static final float CROWN_SIDE = 1.08F;
   private static final float CROWN_BACK = 0.58F;
   private static final float CROWN_BACK_SPREAD = 0.28F;
   private static final float CROWN_HEIGHT = 1.86F;
   private static final float CROWN_HEIGHT_CENTER = 0.76F;
   public static float MANTLE_JOB_LIFT = 1.05F;
   public static float MANTLE_JOB_BIAS = 0.35F;
   public static float MANTLE_PIVOT_STAND = 1.4072F;
   public static float MANTLE_PIVOT_PRONE = 0.35F;
   public static float MANTLE_PRONE_FWD = 0.25F;
   public static float MANTLE_WATER_RESIST = 1.7F;
   public static float MANTLE_STREAM = 0.85F;
   public static float MANTLE_REACH_BASE = 0.48F;
   public static float MANTLE_REACH_MID = 0.12F;
   public static float MANTLE_CHAIN_SHAPE = 2.0F;
   public static float MANTLE_CHAIN_SHAPE_WATER = 0.2F;
   public static float MANTLE_CHAIN_WORK = 30.0F;
   public static float MANTLE_CHAIN_WORK_WATER = 16.0F;
   public static float MANTLE_CHAIN_EXERT_SHAPE = 16.0F;
   public static float MANTLE_CHAIN_EXERT_BRACE = 0.88F;
   public static float MANTLE_CHAIN_EXERT_MIN = 0.8F;
   public static float MANTLE_CHAIN_EXERT_SPAN = 5.0F;
   private static final Map<Integer, float[]> EXERT_CACHE = new HashMap<>();
   public static float MANTLE_CHAIN_KEEP = 0.5F;
   public static float MANTLE_CHAIN_KEEP_WATER = 0.8F;
   public static float MANTLE_CHAIN_WAVE = 0.21F;
   public static float MANTLE_CHAIN_WAVE_WATER = 0.3F;
   public static float MANTLE_CHAIN_LATCH_KICK = 0.5F;
   public static float MANTLE_CHAIN_WRAP_WIND = 0.05F;
   private static final Map<Integer, float[]> WIND_CACHE = new HashMap<>();
   public static float MANTLE_CHAIN_BEND = 0.5F;
   public static float MANTLE_CHAIN_BEND_WATER = 0.1F;
   public static float MANTLE_CHAIN_BRACE = 0.46F;
   public static float MANTLE_CHAIN_BRACE_WATER = 0.11F;
   private static final int CHAIN_N = 16;
   private static final int CHAIN_RELAX = 5;
   private static final Map<Integer, TendrilFxRenderer.ChainState> CHAIN_CACHE = new HashMap<>();
   public static float MANTLE_SWAY = 2.6F;
   public static float MANTLE_BOUNCE = 1.9F;
   public static float MANTLE_DAMP = 0.16F;
   private static final Map<Integer, Vec3> SWAY_CACHE = new HashMap<>();
   public static float WRAP_SWEEP = 6.9F;
   public static float WRAP_DROP = 0.22F;
   public static float WRAP_MARGIN = 0.03F;
   private static final Map<Integer, float[]> MOOD_CACHE = new HashMap<>();
   private static final float MOOD_DAMP = 0.055F;
   private static final float[] COL_GUARDIAN = new float[]{0.16F, 0.06F, 0.3F};
   private static final float[] COL_PREDATOR = new float[]{0.35F, 0.06F, 0.1F};
   private static final float[] COL_SHADOW = new float[]{0.08F, 0.09F, 0.14F};
   private static final float[] COL_SCULK = new float[]{0.04F, 0.22F, 0.24F};
   private static final float[] COL_ROYAL = new float[]{0.32F, 0.2F, 0.06F};
   private static final ArrayList<float[]> GLINT_VERTS = new ArrayList<>();
   private static final Vector3f GP1 = new Vector3f();
   private static final Vector3f GP2 = new Vector3f();
   private static final Vector3f GP3 = new Vector3f();
   private static final Vector3f GP4 = new Vector3f();
   private static int GLINT_QI = 0;
   private static int GLINT_SEED_BASE = 0;
   private static final Map<Integer, TendrilFxRenderer.LightKey> LIGHT_KEY_CACHE = new HashMap<>();
   private static final Vector3f GKEY = new Vector3f();

   private static float thinFactor(TendrilFxEntity entity, float t) {
      float base = entity.isThick() ? 1.0F : 0.42F + 0.18F * t;
      return base * entity.getGirth();
   }

   public TendrilFxRenderer(Context ctx) {
      super(ctx);
      this.shadowRadius = 0.0F;
   }

   /** Forge 1.20.1 overrode Entity#getBoundingBoxForCulling; 1.21.4 asks the renderer instead. */
   @Override
   protected AABB getBoundingBoxForCulling(TendrilFxEntity entity) {
      return entity.getBoundingBoxForCulling();
   }

   @Override
   public State createRenderState() {
      return new State();
   }

   @Override
   public void extractRenderState(TendrilFxEntity entity, State state, float partialTick) {
      super.extractRenderState(entity, state, partialTick);
      state.entity = entity;
      state.partialTick = partialTick;
   }

   @Override
   public void render(State state, PoseStack poseStack, MultiBufferSource bufferSource, int packedLight) {
      TendrilFxEntity entity = state.entity;
      float partialTick = state.partialTick;
      if (entity != null && entity.tickCount >= 2) {
         int mode = entity.getMode();
         if (mode == 1 || mode == 2) {
            GLINT_QI = 0;
            GLINT_SEED_BASE = entity.getId() * 977;
            this.renderGrabSpline(entity, partialTick, poseStack, bufferSource, packedLight);
            flushGlint(bufferSource);
         }

         super.render(state, poseStack, bufferSource, packedLight);
      }
   }

   private void renderGrabSpline(TendrilFxEntity entity, float partialTick, PoseStack poseStack, MultiBufferSource bufferSource, int packedLight) {
      Entity owner = entity.getOwner();
      boolean isWhip = entity.getMode() == 2;
      Entity target = !isWhip && entity.getTargetId() != 0 ? entity.getTarget() : null;
      boolean useFixedTarget = isWhip || entity.getTargetId() == 0;
      if (useFixedTarget || target != null) {
         int armKind = entity.getArmKind();
         boolean isArm = armKind != 0;
         boolean mantleLimb = entity.getHoverPhaseStart() > 0 && entity.usesBackOrigin() && owner != null && entity.getTargetId() == 0;
         int mJobStart = entity.getMantleJobStart();
         boolean mantleWorking = mantleLimb && mJobStart != 0 && entity.getRetractStartTick() <= 0;
         boolean crownFollow = mantleLimb && !mantleWorking;
         float mantleU = 0.0F;
         float mantleJobAge = -1.0F;
         boolean mantleReturning = false;
         Vec3[] chainBase = null;
         int wrapFrom = -1;
         float progress = entity.getProgress(partialTick);
         float baseAlpha = alphaForProgress(progress, entity.getMode());
         float age = entity.tickCount + partialTick;
         int retractStartTick = entity.getRetractStartTick();
         if (retractStartTick <= 0 || entity.tickCount - retractStartTick < 16) {
            Vec3 entityLerp = new Vec3(
               Mth.lerp(partialTick, entity.xOld, entity.getX()),
               Mth.lerp(partialTick, entity.yOld, entity.getY()),
               Mth.lerp(partialTick, entity.zOld, entity.getZ())
            );
            Vec3 root;
            if (owner != null) {
               double ox = Mth.lerp(partialTick, owner.xOld, owner.getX());
               double oy = Mth.lerp(partialTick, owner.yOld, owner.getY());
               double oz = Mth.lerp(partialTick, owner.zOld, owner.getZ());
               double bodyScale = owner instanceof Player && ArmorStateClientCache.isActive(owner.getUUID()) ? 1.35F : 1.0;
               if (entity.usesBackOrigin()) {
                  float yawRad = (float)Math.toRadians(Mth.lerp(partialTick, owner.yRotO, owner.getYRot()));
                  double forwardX = -Math.sin(yawRad);
                  double forwardZ = Math.cos(yawRad);
                  TendrilFxRenderer.AnchorFrame fr = anchorFrame(owner, partialTick, forwardX, forwardZ, ox, oy, oz, bodyScale);
                  double pivotH = MANTLE_PIVOT_STAND * bodyScale;
                  if (mantleLimb) {
                     float slot = Mth.clamp(entity.getHoverBaseAngle(), -1.0F, 1.0F);
                     double absSlot = Math.abs(slot);
                     boolean crn = isCrown(entity);
                     double rBack = crn ? 0.34F : MANTLE_ROOT_BACK;
                     double rBackSpread = crn ? 0.1F : MANTLE_ROOT_BACK_SPREAD;
                     double rSide = crn ? 0.34F : MANTLE_ROOT_SIDE;
                     double rHeight = crn ? 1.42F : MANTLE_ROOT_HEIGHT;
                     double rHeightC = crn ? 0.18F : MANTLE_ROOT_HEIGHT_CENTER;
                     double backOffset = (rBack + absSlot * rBackSpread) * bodyScale;
                     double sideOffset = slot * rSide * bodyScale;
                     double height = (rHeight + (1.0 - absSlot) * rHeightC) * bodyScale;
                     root = fr.pivot()
                        .add(fr.bodyUp().scale(height - pivotH))
                        .add(fr.bodyBack().scale(backOffset))
                        .add(fr.rightAxis().scale(sideOffset));
                  } else if (isArm) {
                     int armSign = owner instanceof Player pl && pl.getMainArm() == HumanoidArm.LEFT ? -1 : 1;
                     float spread = entity.getHoverBaseAngle();
                     double backOffset = 0.24 * bodyScale;
                     double sideOffset = (0.04 * armSign + Math.sin(spread) * 0.2) * bodyScale;
                     root = fr.pivot()
                        .add(fr.bodyUp().scale((1.25 + Math.cos(spread) * 0.26) * bodyScale - pivotH))
                        .add(fr.bodyBack().scale(backOffset))
                        .add(fr.rightAxis().scale(-sideOffset));
                  } else {
                     double backOffset = 0.3 * bodyScale;
                     double sideOffset = Math.sin(entity.getHoverBaseAngle()) * 0.42 * bodyScale;
                     root = fr.pivot()
                        .add(fr.bodyUp().scale(1.5 * bodyScale - pivotH))
                        .add(fr.bodyBack().scale(backOffset))
                        .add(fr.rightAxis().scale(sideOffset));
                  }
               } else {
                  root = new Vec3(ox, oy + 1.0 * bodyScale, oz);
               }
            } else {
               root = entityLerp;
            }

            boolean retractActive = false;
            Vec3 targetCenter;
            if (crownFollow) {
               Vec3 rest = crownRestPos(entity, owner, partialTick);
               int retractStart = entity.getRetractStartTick();
               if (retractStart > 0 && entity.tickCount - retractStart < 16) {
                  retractActive = true;
                  float elapsed = entity.tickCount - retractStart + partialTick;
                  float frac = smoothstep(Math.min(1.0F, elapsed / 16.0F));
                  targetCenter = new Vec3(
                     rest.x + (root.x - rest.x) * frac,
                     rest.y + (root.y - rest.y) * frac,
                     rest.z + (root.z - rest.z) * frac
                  );
               } else {
                  targetCenter = rest;
               }
            } else if (useFixedTarget) {
               int retractStart = entity.getRetractStartTick();
               if (retractStart > 0 && entity.tickCount - retractStart < 16) {
                  retractActive = true;
                  float elapsed = entity.tickCount - retractStart + partialTick;
                  float frac = smoothstep(Math.min(1.0F, elapsed / 16.0F));
                  Vec3 from = entity.getTransitionFrom();
                  targetCenter = new Vec3(
                     from.x + (root.x - from.x) * frac,
                     from.y + (root.y - from.y) * frac,
                     from.z + (root.z - from.z) * frac
                  );
               } else {
                  targetCenter = entity.getTargetPos();
               }
            } else {
               targetCenter = new Vec3(
                  Mth.lerp(partialTick, target.xOld, target.getX()),
                  Mth.lerp(partialTick, target.yOld, target.getY()) + target.getBbHeight() * 0.5,
                  Mth.lerp(partialTick, target.zOld, target.getZ())
               );
            }

            boolean curvedGrab = !isWhip && entity.getArcAmplitude() > 0.001F;
            boolean armArc = isArm && !isWhip && !curvedGrab;
            int reachOverride = entity.getReachTicksOverride();
            float effectiveReachEnd = reachOverride > 0 ? Math.max(1.0E-6F, Math.min(0.5F, (float)reachOverride / Math.max(1, entity.getLifetime()))) : 0.25F;
            Vec3 splineControl = null;
            Vec3 splineControl2 = null;
            Vec3 splineApex = null;
            float splineProgressTip = 0.0F;
            float miningChip = Mth.sin(age * 0.9F);
            Vec3 tip;
            if (isWhip) {
               Vec3 toTarget = targetCenter.subtract(root);
               splineApex = root.add(toTarget.scale(1.35F));
               double dist = toTarget.length();
               double arcHeight = Math.min(Math.max(dist * 0.55, 0.8), 3.0);
               Vec3 forwardHoriz = new Vec3(toTarget.x, 0.0, toTarget.z);
               double forwardHorizLen = forwardHoriz.length();
               Vec3 backOffset = forwardHorizLen > 1.0E-4 ? forwardHoriz.scale(-dist * 0.2 / forwardHorizLen) : Vec3.ZERO;
               Vec3 midpoint = root.add(splineApex.subtract(root).scale(0.5));
               splineControl = midpoint.add(new Vec3(0.0, arcHeight, 0.0)).add(backOffset);
               if (progress < 0.15F) {
                  splineProgressTip = smoothstep(progress / 0.15F);
               } else if (progress < 0.25F) {
                  splineProgressTip = 1.0F;
               } else {
                  splineProgressTip = 1.0F - smoothstep((progress - 0.25F) / 0.75F);
               }

               tip = bezier(root, splineControl, splineApex, splineProgressTip);
            } else if (curvedGrab) {
               Vec3 toTarget = targetCenter.subtract(root);
               double dist = toTarget.length();
               if (dist < 1.0E-4) {
                  return;
               }

               splineApex = targetCenter;
               Vec3 forwardN = toTarget.normalize();
               Vec3 worldUpV = new Vec3(0.0, 1.0, 0.0);
               Vec3 perpRight;
               if (Math.abs(forwardN.dot(worldUpV)) > 0.99) {
                  perpRight = new Vec3(1.0, 0.0, 0.0).cross(forwardN).normalize();
               } else {
                  perpRight = forwardN.cross(worldUpV).normalize();
               }

               Vec3 perpUp = perpRight.cross(forwardN).normalize();
               float angle = entity.getArcAngle();
               float amplitude = entity.getArcAmplitude();
               double arcHeight = dist * amplitude;
               Vec3 arcDir = perpUp.scale(Math.cos(angle)).add(perpRight.scale(Math.sin(angle)));
               Vec3 midpoint = root.add(toTarget.scale(0.5));
               splineControl = midpoint.add(arcDir.scale(arcHeight));
               if (progress < effectiveReachEnd) {
                  splineProgressTip = smoothstep(progress / effectiveReachEnd);
               } else if (progress < 0.85F) {
                  splineProgressTip = 1.0F;
               } else {
                  splineProgressTip = 1.0F - smoothstep((progress - 0.85F) / 0.14999998F);
               }

               tip = bezier(root, splineControl, splineApex, splineProgressTip);
            } else if (armArc) {
               if (!crownFollow && !mantleWorking) {
                  boolean armRetract = retractActive;
                  Vec3 arcApex = armRetract ? entity.getTransitionFrom() : targetCenter;
                  if (armKind == 1) {
                     Vec3 d = arcApex.subtract(root);
                     if (d.lengthSqr() > 1.0E-6) {
                        arcApex = arcApex.subtract(d.normalize().scale(1.15));
                     }

                     if (!armRetract) {
                        arcApex = arcApex.add(0.0, -Mth.sin(age * 0.98F) * 0.16, 0.0);
                     }
                  }

                  Vec3 toTarget = arcApex.subtract(root);
                  double dist = toTarget.length();
                  if (dist < 1.0E-4) {
                     return;
                  }

                  splineApex = arcApex;
                  Vec3 fN = toTarget.scale(1.0 / dist);
                  Vec3 wUp = new Vec3(0.0, 1.0, 0.0);
                  Vec3 perpRight = Math.abs(fN.dot(wUp)) > 0.99 ? new Vec3(1.0, 0.0, 0.0).cross(fN).normalize() : fN.cross(wUp).normalize();
                  Vec3 perpUp = perpRight.cross(fN).normalize();
                  Vec3 horiz = new Vec3(toTarget.x, 0.0, toTarget.z);
                  Vec3 backDir = horiz.lengthSqr() > 1.0E-4 ? horiz.normalize().scale(-1.0) : new Vec3(0.0, 0.0, -1.0);
                  float ha = entity.getHoverBaseAngle();
                  double rRise = 1.0 + 0.32 * Math.sin(ha * 1.7);
                  double rEmerge = 1.0 + 0.3 * Math.cos(ha * 2.3);
                  double emerge = Mth.clamp(dist * 0.18, 0.4, 0.9) * rEmerge;
                  double riseH = Mth.clamp(dist * 0.85, 3.0, 5.0) * rRise;
                  double sideClear = (Math.sin(ha) >= 0.0 ? 1.0 : -1.0) * (0.35 + 0.45 * Math.abs(Math.sin(ha * 1.3)));
                  Vec3 c1 = root.add(backDir.scale(emerge));
                  splineControl = c1;
                  splineControl2 = c1.add(perpUp.scale(riseH)).add(perpRight.scale(sideClear));
                  if (armRetract) {
                     float rf = smoothstep(Math.min(1.0F, (entity.tickCount - entity.getRetractStartTick() + partialTick) / 16.0F));
                     int reachT = Math.max(1, entity.getReachTicksOverride());
                     float extAtRetract = smoothstep(Mth.clamp((float)entity.getRetractStartTick() / reachT, 0.0F, 1.0F));
                     splineProgressTip = extAtRetract * (1.0F - rf);
                  } else if (progress < effectiveReachEnd) {
                     splineProgressTip = smoothstep(progress / effectiveReachEnd);
                  } else {
                     splineProgressTip = 1.0F;
                  }

                  tip = bezierCubic(root, splineControl, splineControl2, splineApex, splineProgressTip);
               } else {
                  Vec3 restTip = crownFollow ? targetCenter : crownRestPos(entity, owner, partialTick);
                  Vec3 toRest = restTip.subtract(root);
                  if (toRest.length() < 1.0E-4) {
                     return;
                  }

                  splineApex = restTip;
                  float slot = Mth.clamp(entity.getHoverBaseAngle(), -1.0F, 1.0F);
                  double absSlot = Math.abs(slot);
                  double centerLift = 1.0 - absSlot;
                  float yawRad = (float)Math.toRadians(Mth.lerp(partialTick, owner.yRotO, owner.getYRot()));
                  Vec3 forwardDir = new Vec3(-Math.sin(yawRad), 0.0, Math.cos(yawRad));
                  double bodyScale = owner instanceof Player && ArmorStateClientCache.isActive(owner.getUUID()) ? 1.35F : 1.0;
                  TendrilFxRenderer.AnchorFrame frArc = anchorFrame(
                     owner,
                     partialTick,
                     forwardDir.x,
                     forwardDir.z,
                     Mth.lerp(partialTick, owner.xOld, owner.getX()),
                     Mth.lerp(partialTick, owner.yOld, owner.getY()),
                     Mth.lerp(partialTick, owner.zOld, owner.getZ()),
                     bodyScale
                  );
                  Vec3 backDir = frArc.drapeBack();
                  Vec3 liftDir = frArc.drapeUp();
                  Vec3 rightDir = frArc.rightAxis();
                  boolean crnArc = isCrown(entity);
                  double aBack = crnArc ? 0.42F : MANTLE_ARC_BACK;
                  double aBackSpread = crnArc ? 0.22F : MANTLE_ARC_BACK_SPREAD;
                  double aLift = crnArc ? 0.58F : MANTLE_ARC_LIFT;
                  double aLiftC = crnArc ? 0.34F : MANTLE_ARC_LIFT_CENTER;
                  double a2Back = crnArc ? 0.18F : MANTLE_ARC2_BACK;
                  double a2Lift = crnArc ? 0.16F : MANTLE_ARC2_LIFT;
                  splineControl = root.add(backDir.scale((aBack + aBackSpread * absSlot) * bodyScale))
                     .add(rightDir.scale(slot * 0.1 * bodyScale))
                     .add(liftDir.scale((aLift + centerLift * aLiftC) * bodyScale));
                  splineControl2 = restTip.add(backDir.scale((a2Back + 0.16 * absSlot) * bodyScale))
                     .add(rightDir.scale(slot * 0.06 * bodyScale))
                     .add(liftDir.scale((a2Lift + centerLift * 0.28) * bodyScale));
                  if (mantleWorking) {
                     int gtI = (int)owner.level().getGameTime();
                     int jEnd = entity.getMantleJobEnd();
                     int reachT = entity.getReachTicksOverride() > 0 ? entity.getReachTicksOverride() : 8;
                     float uReach = smoothstep(Mth.clamp((gtI - mJobStart + partialTick) / reachT, 0.0F, 1.0F));
                     float uReturn = jEnd == 0 ? 1.0F : 1.0F - smoothstep(Mth.clamp((gtI - jEnd + partialTick) / 8.0F, 0.0F, 1.0F));
                     float u = uReach * uReturn;
                     mantleU = u;
                     mantleJobAge = gtI - mJobStart + partialTick;
                     mantleReturning = jEnd != 0 && gtI >= jEnd;
                     Vec3 jobTgt = targetCenter;
                     if (armKind == 1) {
                        Vec3 dMine = jobTgt.subtract(root);
                        if (dMine.lengthSqr() > 1.0E-6) {
                           jobTgt = jobTgt.subtract(dMine.normalize().scale(1.15));
                        }

                        if (!mantleReturning) {
                           jobTgt = jobTgt.add(0.0, -Mth.sin(age * 0.98F) * 0.16, 0.0);
                        }
                     }

                     Vec3 toJob = jobTgt.subtract(root);
                     double jobDist = toJob.length();
                     if (jobDist > 1.0E-4 && u > 0.0F) {
                        Vec3 fN2 = toJob.scale(1.0 / jobDist);
                        Vec3 wUp2 = new Vec3(0.0, 1.0, 0.0);
                        Vec3 pR2 = Math.abs(fN2.dot(wUp2)) > 0.99 ? new Vec3(1.0, 0.0, 0.0).cross(fN2).normalize() : fN2.cross(wUp2).normalize();
                        Vec3 pU2 = pR2.cross(fN2).normalize();
                        Vec3 horiz2 = new Vec3(toJob.x, 0.0, toJob.z);
                        Vec3 backDir2 = horiz2.lengthSqr() > 1.0E-4 ? horiz2.normalize().scale(-1.0) : backDir;
                        double emerge2 = Mth.clamp(jobDist * 0.18, 0.4, 0.9);
                        double riseH2 = Mth.clamp(jobDist * 0.85, 2.0, 3.0);
                        double sideClear2 = (slot >= 0.0F ? 1.0 : -1.0) * (0.35 + 0.45 * absSlot);
                        Vec3 c1s = root.add(backDir2.scale(emerge2))
                           .add(backDir.scale((aBack + aBackSpread * absSlot) * 0.5 * bodyScale))
                           .add(liftDir.scale((aLift + centerLift * aLiftC) * 0.6 * bodyScale));
                        Vec3 c2s = c1s.add(pU2.scale(riseH2)).add(pR2.scale(sideClear2)).add(fN2.scale(Math.min(jobDist * 0.5, 4.0)));
                        splineControl = splineControl.lerp(c1s, u * MANTLE_REACH_BASE);
                        splineControl2 = splineControl2.lerp(c2s, u * MANTLE_REACH_MID);
                        Vec3 wp = restTip.add(jobTgt.subtract(restTip).scale(MANTLE_JOB_BIAS)).add(0.0, MANTLE_JOB_LIFT * bodyScale, 0.0);
                        Vec3 pA = restTip.lerp(wp, u);
                        Vec3 pB = wp.lerp(jobTgt, u);
                        splineApex = pA.lerp(pB, u);
                     }

                     splineProgressTip = 1.0F;
                     tip = splineApex;
                     if (!isCrown(entity)) {
                        chainBase = chainSim(entity, owner, root, splineControl, splineControl2, splineApex, 1.0F, false, 1.6F);
                        tip = chainBase[31];
                     }
                  } else {
                     if (progress < effectiveReachEnd) {
                        splineProgressTip = smoothstep(progress / effectiveReachEnd);
                     } else {
                        splineProgressTip = 1.0F;
                     }

                     tip = bezierCubic(root, splineControl, splineControl2, splineApex, splineProgressTip);
                     if (!crnArc) {
                        chainBase = chainSim(entity, owner, root, splineControl, splineControl2, splineApex, splineProgressTip, retractActive, 1.0F);
                        tip = chainBase[31];
                     }
                  }
               }
            } else if (progress < effectiveReachEnd) {
               float reachFrac = smoothstep(progress / effectiveReachEnd);
               tip = root.add(targetCenter.subtract(root).scale(reachFrac));
            } else if (progress < 0.85F) {
               tip = targetCenter;
            } else {
               float retractFrac = smoothstep((progress - 0.85F) / 0.14999998F);
               tip = root.add(targetCenter.subtract(root).scale(1.0F - retractFrac));
            }

            Vec3 forward = tip.subtract(root);
            if (!(forward.lengthSqr() < 0.0025)) {
               Vec3 forwardN = forward.normalize();
               Vec3 worldUp = new Vec3(0.0, 1.0, 0.0);
               Vec3 right;
               if (Math.abs(forwardN.dot(worldUp)) > 0.99) {
                  right = new Vec3(1.0, 0.0, 0.0).cross(forwardN).normalize();
               } else {
                  right = forwardN.cross(worldUp).normalize();
               }

               Vec3 up = right.cross(forwardN).normalize();
               Vec3[] points = new Vec3[32];
               boolean inTransition = entity.getTransitionStartTick() > 0 && entity.tickCount - entity.getTransitionStartTick() < 16;
               double writheBoost = inTransition ? 2.5 : 1.0;
               if (mantleLimb) {
                  writheBoost += moodAgitation(entity.getId()) * 0.8;
               }

               if (chainBase != null) {
                  writheBoost *= 0.6;
               }

               double writheAmpScaled = isWhip
                  ? Mth.clamp(forward.length() * 0.06, 0.1, 0.3)
                  : Mth.clamp(forward.length() * 0.025 * writheBoost, 0.04, 0.35);
               double writheTimeFreq = isWhip ? 0.55 : (inTransition ? 0.45 : 0.18);
               double writheTimeFreqB = isWhip ? 0.65 : (inTransition ? 0.55 : 0.23);

               for (int i = 0; i < 32; i++) {
                  float t = i / 31.0F;
                  float envelope = (float)Math.sin(Math.PI * t);
                  envelope *= envelope;
                  double waveA = Math.sin(age * writheTimeFreq + t * 10.0);
                  double waveB = Math.cos(age * writheTimeFreqB + t * 14.0);
                  Vec3 base;
                  if (chainBase != null) {
                     base = chainBase[i];
                  } else if (armArc) {
                     base = bezierCubic(root, splineControl, splineControl2, splineApex, t * splineProgressTip);
                  } else if (!isWhip && !curvedGrab) {
                     base = root.add(forward.scale(t));
                  } else {
                     base = bezier(root, splineControl, splineApex, t * splineProgressTip);
                  }

                  points[i] = base.add(right.scale(waveA * writheAmpScaled * envelope)).add(up.scale(waveB * writheAmpScaled * 0.7 * envelope));
               }

               if (!isWhip && entity.getRetractStartTick() <= 0) {
                  Entity wrapT = wrapTargetOf(entity);
                  if (wrapT != null && (chainBase != null || progress >= effectiveReachEnd)) {
                     Vec3 cc = wrapCenter(wrapT, partialTick);
                     double nearSq = wrapT.getBbWidth() * 0.5 + 0.9;
                     nearSq *= nearSq;
                     boolean contact = points[31].distanceToSqr(cc) < nearSq;
                     float wind = windProgress(entity.getId(), contact);
                     int wrapN = 18;
                     int lead = 3;
                     wrapFrom = 32 - wrapN + lead;

                     for (int i = 32 - wrapN; i < 32; i++) {
                        int k = i - (32 - wrapN);
                        float blend;
                        float frac;
                        if (k < lead) {
                           blend = (float)(k + 1) / (lead + 1);
                           frac = 0.1F * (k + 1) / lead;
                        } else {
                           blend = 1.0F;
                           frac = 0.1F + 0.9F * (k - lead) / (wrapN - lead - 1);
                        }

                        frac *= wind;
                        Vec3 coil = wrapPoint(wrapT, frac, points[32 - wrapN - 1], partialTick);
                        Vec3 radial = coil.subtract(cc);
                        double breathe = 1.0 + 0.05 * Math.sin(age * 0.22 + frac * 9.0);
                        coil = cc.add(radial.scale(breathe)).add(0.0, Math.sin(age * 0.31 + frac * 12.0) * 0.03, 0.0);
                        points[i] = points[i].lerp(coil, blend);
                     }
                  }
               }

               Vec3[] frameR = new Vec3[32];
               Vec3[] frameU = new Vec3[32];
               Vec3 prevR = right;
               Vec3 prevU = up;

               for (int i = 0; i < 32; i++) {
                  Vec3 tan;
                  if (i == 0) {
                     tan = points[Math.min(1, 31)].subtract(points[0]);
                  } else if (i == 31) {
                     tan = points[i].subtract(points[i - 1]);
                  } else {
                     tan = points[i + 1].subtract(points[i - 1]);
                  }

                  if (tan.lengthSqr() < 1.0E-8) {
                     frameR[i] = prevR;
                     frameU[i] = prevU;
                  } else {
                     tan = tan.normalize();
                     Vec3 r = prevR.subtract(tan.scale(prevR.dot(tan)));
                     if (r.lengthSqr() < 1.0E-8) {
                        r = prevU.subtract(tan.scale(prevU.dot(tan)));
                     }

                     r = r.normalize();
                     Vec3 u = tan.cross(r).normalize();
                     frameR[i] = r;
                     frameU[i] = u;
                     prevR = r;
                     prevU = u;
                  }
               }

               Vec3[][] rings = new Vec3[32][12];

               for (int i = 0; i < 32; i++) {
                  float t = i / 31.0F;
                  float baseRadius = radiusAt(t) * thinFactor(entity, t);
                  if (wrapFrom >= 0 && i >= wrapFrom) {
                     baseRadius = Math.max(baseRadius, radiusAt(0.45F) * thinFactor(entity, 0.45F) * 0.92F);
                  }

                  Vec3 center = points[i];
                  Vec3 lr = frameR[i];
                  Vec3 lu = frameU[i];

                  for (int side = 0; side < 12; side++) {
                     double angle = (Math.PI * 2) * side / 12.0;
                     double cosA = Math.cos(angle);
                     double sinA = Math.sin(angle);
                     float wobbledRadius = organicRadius(baseRadius, t, side, age);
                     rings[i][side] = center.add(lr.scale(cosA * wobbledRadius)).add(lu.scale(sinA * wobbledRadius));
                  }
               }

               ResourceLocation tex = this.getTextureLocation(entity);
               VertexConsumer buf = bufferSource.getBuffer(RenderType.entityCutoutNoCull(tex));
               float[] baseColor = strainBaseColor(entity.getStrain());
               float colR = baseColor[0];
               float colG = baseColor[1];
               float colB = baseColor[2];
               if (entity.isShiny()) {
                  colR = 0.85F;
                  colG = 0.62F;
                  colB = 0.18F;
                  packedLight = 15728880;
               }

               Vec3 camPos = Minecraft.getInstance().gameRenderer.getMainCamera().getPosition();
               boolean fadeNearCam = owner != null && owner == Minecraft.getInstance().player && Minecraft.getInstance().options.getCameraType().isFirstPerson();
               Matrix4f m = poseStack.last().pose();
               Matrix3f n = poseStack.last().normal();
               if (VanillaSheen.GLINT_STRENGTH > 0.01F && !VanillaSheen.shadersActive()) {
                  TendrilFxRenderer.LightKey lk = worldLightDir(entity);
                  if (lk.valid) {
                     GKEY.set(lk.x, lk.y, lk.z);
                     n.transform(GKEY);
                     GKEY.normalize();
                  } else {
                     GKEY.set(VanillaSheen.KEY_X, VanillaSheen.KEY_Y, VanillaSheen.KEY_Z);
                  }
               }

               for (int i = 0; i < 31; i++) {
                  float t0 = i / 31.0F;
                  float t1 = (i + 1) / 31.0F;
                  float tMid = (t0 + t1) * 0.5F;

                  for (int side = 0; side < 12; side++) {
                     int sideNext = (side + 1) % 12;
                     Vec3 a = rings[i][side].subtract(entityLerp);
                     Vec3 b = rings[i + 1][side].subtract(entityLerp);
                     Vec3 c = rings[i + 1][sideNext].subtract(entityLerp);
                     Vec3 d = rings[i][sideNext].subtract(entityLerp);
                     double angleMid = (Math.PI * 2) * (side + 0.5) / 12.0;
                     Vec3 normal = frameR[i].scale(Math.cos(angleMid)).add(frameU[i].scale(Math.sin(angleMid)));
                     float u0 = side / 12.0F;
                     float u1 = (side + 1) / 12.0F;
                     float litFromAbove = 0.5F + 0.5F * (float)Math.max(-0.4, normal.y);
                     Vec3 faceMidLocal = a.add(b).add(c).add(d).scale(0.25);
                     Vec3 faceMidWorld = faceMidLocal.add(entityLerp);
                     Vec3 viewDir = faceMidWorld.subtract(camPos).normalize();
                     float facing = (float)Math.abs(normal.dot(viewDir));
                     float fresnel = 1.0F - facing;
                     float bright = 0.35F + litFromAbove * 0.55F + fresnel * 0.35F;
                     float streak = (float)Math.sin(tMid * 34.0 + side * 1.7 + age * 0.08);
                     if (streak > 0.7F && litFromAbove > 0.4F) {
                        bright += 0.25F;
                     }

                     float fr = Mth.clamp(colR * bright, 0.0F, 1.0F);
                     float fg = Mth.clamp(colG * bright, 0.0F, 1.0F);
                     float fb = Mth.clamp(colB * bright, 0.0F, 1.0F);
                     if (!fadeNearCam || !(faceMidWorld.distanceTo(camPos) < 1.05)) {
                        quad(buf, m, n, packedLight, fr, fg, fb, baseAlpha, a, u0, t0, b, u0, t1, c, u1, t1, d, u1, t0, normal);
                     }
                  }
               }

               float ridgeColR = colR * 1.55F;
               float ridgeColG = colG * 1.55F;
               float ridgeColB = colB * 1.55F;

               for (int rIdx = 0; rIdx < 3; rIdx++) {
                  float ridgePhase = (float)(rIdx * 2 * Math.PI / 3.0);
                  Vec3 prevRidge = null;
                  Vec3 prevSideAxis = null;

                  for (int i = 0; i < 32; i++) {
                     float t = i / 31.0F;
                     float twist = age * 0.16F + t * 14.0F + ridgePhase;
                     float armR = thinFactor(entity, t);
                     float surfaceRadius = radiusAt(t) * 1.18F * armR;
                     Vec3 center = points[i];
                     Vec3 lr = frameR[i];
                     Vec3 lu = frameU[i];
                     Vec3 ridgePoint = center.add(lr.scale(Math.cos(twist) * surfaceRadius)).add(lu.scale(Math.sin(twist) * surfaceRadius));
                     Vec3 radial = lr.scale(Math.cos(twist)).add(lu.scale(Math.sin(twist)));
                     Vec3 localTan = lr.cross(lu);
                     Vec3 sideAxis = localTan.cross(radial).normalize();
                     if (prevRidge != null) {
                        if (fadeNearCam && ridgePoint.distanceTo(camPos) < 1.05) {
                           prevRidge = ridgePoint;
                           prevSideAxis = sideAxis;
                           continue;
                        }

                        float ridgeAlpha = baseAlpha;
                        float ridgeRadius = radiusAt(t) * 0.18F * armR;
                        Vec3 a = prevRidge.subtract(entityLerp);
                        Vec3 b = ridgePoint.subtract(entityLerp);
                        Vec3 aL = a.add(prevSideAxis.scale(ridgeRadius));
                        Vec3 aR = a.add(prevSideAxis.scale(-ridgeRadius));
                        Vec3 bL = b.add(sideAxis.scale(ridgeRadius));
                        Vec3 bR = b.add(sideAxis.scale(-ridgeRadius));
                        Vec3 normal = radial;
                        float t0 = (i - 1) / 31.0F;
                        quad(buf, m, n, packedLight, ridgeColR, ridgeColG, ridgeColB, ridgeAlpha, aL, 0.0F, t0, bL, 0.0F, t, bR, 1.0F, t, aR, 1.0F, t0, normal);
                     }

                     prevRidge = ridgePoint;
                     prevSideAxis = sideAxis;
                  }
               }

               if (!isWhip && !useFixedTarget && target != null && progress >= effectiveReachEnd && progress < 0.85F) {
                  renderGripCollar(buf, m, n, packedLight, baseAlpha, target, partialTick, targetCenter, entityLerp, age, colR, colG, colB);
               }

               ItemStack held = entity.getHeldItem();
               boolean showHeld = mantleLimb ? mantleWorking && mantleU > 0.05F : progress > 0.04F;
               if (!held.isEmpty() && showHeld) {
                  double yawDeg = Math.toDegrees(Math.atan2(forwardN.x, forwardN.z));
                  double pitchDeg = Math.toDegrees(Math.asin(Mth.clamp((float)(-forwardN.y), -1.0F, 1.0F)));
                  poseStack.pushPose();
                  if (armKind != 1) {
                     if (armKind == 3) {
                        Vec3 rel = tip.subtract(entityLerp);
                        poseStack.translate(rel.x, rel.y, rel.z);
                        poseStack.mulPose(Axis.YP.rotationDegrees((float)yawDeg));
                        poseStack.mulPose(Axis.XP.rotationDegrees((float)pitchDeg + 90.0F));
                     } else {
                        float swingAge = mantleJobAge >= 0.0F ? mantleJobAge : age;
                        float swingT = Mth.clamp((swingAge - 3.0F) / 5.0F, 0.0F, 1.0F);
                        float swing = Mth.lerp(smoothstep(swingT), -90.0F, 65.0F);
                        float lunge = Mth.sin(swingT * (float) Math.PI) * 0.55F;
                        Vec3 strike = tip.add(forwardN.scale(lunge));
                        Vec3 rel = strike.subtract(entityLerp);
                        poseStack.translate(rel.x, rel.y, rel.z);
                        poseStack.mulPose(Axis.YP.rotationDegrees((float)yawDeg));
                        poseStack.mulPose(Axis.XP.rotationDegrees((float)pitchDeg + 90.0F));
                        poseStack.mulPose(Axis.XP.rotationDegrees(swing));
                     }
                  } else {
                     Vec3 handle = tip.subtract(forwardN.scale(0.4));
                     Vec3 rel = handle.subtract(entityLerp);
                     poseStack.translate(rel.x, rel.y, rel.z);
                     poseStack.mulPose(Axis.YP.rotationDegrees((float)yawDeg));
                     poseStack.mulPose(Axis.XP.rotationDegrees((float)pitchDeg + 90.0F));
                     poseStack.mulPose(Axis.XP.rotationDegrees(!retractActive && !mantleReturning ? miningChip * 22.0F : 0.0F));
                     poseStack.translate(0.0, 0.4, 0.0);
                  }

                  poseStack.scale(0.95F, 0.95F, 0.95F);
                  Minecraft.getInstance()
                     .getItemRenderer()
                     .renderStatic(
                        held,
                        ItemDisplayContext.THIRD_PERSON_RIGHT_HAND,
                        packedLight,
                        OverlayTexture.NO_OVERLAY,
                        poseStack,
                        bufferSource,
                        entity.level(),
                        entity.getId()
                     );
                  poseStack.popPose();
               }
            }
         }
      }
   }

   private static void renderGripCollar(
      VertexConsumer buf,
      Matrix4f m,
      Matrix3f n,
      int packedLight,
      float baseAlpha,
      Entity target,
      float partialTick,
      Vec3 targetCenter,
      Vec3 entityLerp,
      float age,
      float colR,
      float colG,
      float colB
   ) {
      int hooks = 3;
      int hookSamples = 8;
      float wrapRadius = Math.max(target.getBbWidth() * 0.45F, 0.3F);
      float hookRadius = 0.06F;
      Vec3 hookRight = new Vec3(1.0, 0.0, 0.0);
      Vec3 hookUp = new Vec3(0.0, 1.0, 0.0);

      for (int h = 0; h < hooks; h++) {
         float startAngle = (float)(h * 2 * Math.PI / hooks);
         float twist = age * 0.04F;
         Vec3[] hookPts = new Vec3[hookSamples + 1];

         for (int i = 0; i <= hookSamples; i++) {
            float arcT = (float)i / hookSamples;
            float angle = startAngle + twist + arcT * 1.2F;
            float yOff = (float)Math.sin(arcT * Math.PI) * 0.1F * (h - 1);
            hookPts[i] = targetCenter.add(hookRight.scale(Math.cos(angle) * wrapRadius))
               .add(hookUp.scale(yOff))
               .add(new Vec3(0.0, 0.0, 1.0).scale(Math.sin(angle) * wrapRadius));
         }

         for (int i = 0; i < hookSamples; i++) {
            Vec3 a = hookPts[i].subtract(entityLerp);
            Vec3 b = hookPts[i + 1].subtract(entityLerp);
            Vec3 dir = b.subtract(a);
            if (!(dir.lengthSqr() < 1.0E-6)) {
               Vec3 dirN = dir.normalize();
               Vec3 perpA;
               if (Math.abs(dirN.y) > 0.99) {
                  perpA = new Vec3(1.0, 0.0, 0.0);
               } else {
                  perpA = dirN.cross(new Vec3(0.0, 1.0, 0.0)).normalize();
               }

               Vec3 perpB = perpA.cross(dirN).normalize();
               Vec3 aRU = a.add(perpA.scale(hookRadius)).add(perpB.scale(hookRadius));
               Vec3 aRD = a.add(perpA.scale(hookRadius)).add(perpB.scale(-hookRadius));
               Vec3 aLD = a.add(perpA.scale(-hookRadius)).add(perpB.scale(-hookRadius));
               Vec3 aLU = a.add(perpA.scale(-hookRadius)).add(perpB.scale(hookRadius));
               Vec3 bRU = b.add(perpA.scale(hookRadius)).add(perpB.scale(hookRadius));
               Vec3 bRD = b.add(perpA.scale(hookRadius)).add(perpB.scale(-hookRadius));
               Vec3 bLD = b.add(perpA.scale(-hookRadius)).add(perpB.scale(-hookRadius));
               Vec3 bLU = b.add(perpA.scale(-hookRadius)).add(perpB.scale(hookRadius));
               quad(buf, m, n, packedLight, colR, colG, colB, baseAlpha, aRU, 0.0F, 0.0F, bRU, 0.0F, 1.0F, bRD, 1.0F, 1.0F, aRD, 1.0F, 0.0F, perpA);
               quad(
                  buf, m, n, packedLight, colR, colG, colB, baseAlpha, aLD, 0.0F, 0.0F, bLD, 0.0F, 1.0F, bLU, 1.0F, 1.0F, aLU, 1.0F, 0.0F, perpA.scale(-1.0)
               );
               quad(buf, m, n, packedLight, colR, colG, colB, baseAlpha, aLU, 0.0F, 0.0F, bLU, 0.0F, 1.0F, bRU, 1.0F, 1.0F, aRU, 1.0F, 0.0F, perpB);
               quad(
                  buf, m, n, packedLight, colR, colG, colB, baseAlpha, aRD, 0.0F, 0.0F, bRD, 0.0F, 1.0F, bLD, 1.0F, 1.0F, aLD, 1.0F, 0.0F, perpB.scale(-1.0)
               );
            }
         }
      }
   }

   private static double exertion(TendrilFxEntity entity, Entity owner, float dt) {
      double spd = new Vec3(owner.getX() - owner.xOld, owner.getY() - owner.yOld, owner.getZ() - owner.zOld).length() * 20.0;
      double target = Mth.clamp((spd - MANTLE_CHAIN_EXERT_MIN) / MANTLE_CHAIN_EXERT_SPAN, 0.0, 1.0);
      if (owner instanceof LivingEntity le && le.hurtTime > 0) {
         target = Math.max(target, 0.85);
      }

      float[] c = EXERT_CACHE.computeIfAbsent(entity.getId(), k -> new float[1]);
      double damp = target > c[0] ? Math.min(1.0, 10.0 * dt) : Math.min(1.0, 1.6 * dt);
      c[0] = (float)(c[0] + (target - c[0]) * damp);
      if (EXERT_CACHE.size() > 512) {
         EXERT_CACHE.clear();
      }

      return c[0];
   }

   private static float windProgress(int entityId, boolean advance) {
      if (WIND_CACHE.size() > 256) {
         WIND_CACHE.clear();
      }

      float[] w = WIND_CACHE.computeIfAbsent(entityId, k -> new float[]{0.0F, -1.0F});
      if (!advance) {
         return w[0];
      }

      long frame = MantleBodyAnchor.frameIndex();
      if (w[1] != (float)frame) {
         w[1] = (float)frame;
         w[0] = Math.min(1.0F, w[0] + MantleBodyAnchor.frameDt() / Math.max(0.05F, MANTLE_CHAIN_WRAP_WIND));
      }

      return w[0];
   }

   private static Vec3[] chainSim(
      TendrilFxEntity entity, Entity owner, Vec3 root, Vec3 c1, Vec3 c2, Vec3 tipTarget, float progressTip, boolean retracting, float shapeBoost
   ) {
      TendrilFxRenderer.ChainState st = CHAIN_CACHE.computeIfAbsent(entity.getId(), k -> new TendrilFxRenderer.ChainState());
      if (CHAIN_CACHE.size() > 256) {
         CHAIN_CACHE.clear();
      }

      long frame = MantleBodyAnchor.frameIndex();
      Vec3[] tgt = new Vec3[16];

      for (int i = 0; i < 16; i++) {
         tgt[i] = bezierCubic(root, c1, c2, tipTarget, i / 15.0F * progressTip);
      }

      if (!retracting && entity.getWrapTarget() != 0) {
         int iMax = 0;

         for (int i = 1; i < 16; i++) {
            if (tgt[i].y > tgt[iMax].y) {
               iMax = i;
            }
         }

         if (iMax < 13) {
            double span = tgt[15].subtract(tgt[iMax]).length();
            double amp = Mth.clamp(span * 0.14, 0.1, 0.6);

            for (int i = iMax + 1; i < 16; i++) {
               double q = (double)(i - iMax) / (15 - iMax);
               tgt[i] = tgt[i].add(0.0, -amp * Math.sin(Math.PI * q), 0.0);
            }
         }
      }

      if (owner.level() != null) {
         for (int i = 1; i < 16; i++) {
            Vec3 from = tgt[i - 1];
            Vec3 to = tgt[i];
            if (from.distanceToSqr(to) > 1.0E-6) {
               BlockHitResult hit = owner.level().clip(new ClipContext(from, to, Block.COLLIDER, Fluid.NONE, owner));
               if (hit.getType() == Type.BLOCK) {
                  Vec3 dir = to.subtract(from);
                  double len = dir.length();
                  to = hit.getLocation().subtract(dir.scale(Math.min(0.14 / len, 1.0)));
                  Vec3 n = new Vec3(hit.getDirection().getStepX(), hit.getDirection().getStepY(), hit.getDirection().getStepZ());
                  to = to.add(n.scale(0.12));
               }
            }

            TendrilFxRenderer.PushOut po = pushOut(owner.level(), to, 0.12);
            if (po != null) {
               to = po.pos();
            }

            tgt[i] = to;
         }
      }

      if (!retracting) {
         Entity wrapT = wrapTargetOf(entity);
         if (wrapT != null) {
            if (st.lastWrapId != wrapT.getId() && st.live) {
               st.lastWrapId = wrapT.getId();
               st.wrapWind = 0.0F;
               ThreadLocalRandom rnd = ThreadLocalRandom.current();
               Vec3 tCenter = wrapT.position().add(0.0, wrapT.getBbHeight() * 0.5, 0.0);

               for (int k = Math.max(0, 11); k < 16; k++) {
                  Vec3 toT = tCenter.subtract(st.pos[k]);
                  Vec3 n = toT.lengthSqr() < 1.0E-6 ? new Vec3(0.0, -1.0, 0.0) : toT.normalize();
                  Vec3 lat = new Vec3(rnd.nextDouble() - 0.5, rnd.nextDouble() - 0.5, rnd.nextDouble() - 0.5).scale(0.9);
                  st.vel[k] = st.vel[k].add(n.add(lat).scale(MANTLE_CHAIN_LATCH_KICK));
               }
            }

            st.wrapWind = Math.min(1.0F, st.wrapWind + MantleBodyAnchor.frameDt() / Math.max(0.05F, MANTLE_CHAIN_WRAP_WIND));

            for (int k = 0; k < 4; k++) {
               int idx = 12 + k;
               tgt[idx] = wrapPoint(wrapT, (k + 1) / 4.0F * st.wrapWind, tgt[11], 1.0F);
            }
         } else {
            st.lastWrapId = 0;
            st.wrapWind = 0.0F;
         }
      }

      boolean park = Minecraft.getInstance().screen instanceof MantleTuneScreen && !MantleTuneScreen.physicsPage;
      if (st.live && !park && !(st.pos[0].distanceToSqr(root) > 36.0)) {
         if (st.frame == frame && st.sampled != null) {
            return st.sampled;
         }

         st.frame = frame;
         float dt = MantleBodyAnchor.frameDt();
         boolean water = owner.isUnderWater();
         boolean workingLimb = shapeBoost > 1.01F;
         double exert = workingLimb ? 0.0 : exertion(entity, owner, dt);
         double shapeRate = (water ? MANTLE_CHAIN_SHAPE_WATER : MANTLE_CHAIN_SHAPE) * (retracting ? 3.0 : 1.0) * shapeBoost;
         if (workingLimb) {
            shapeRate = Math.max(shapeRate, water ? MANTLE_CHAIN_WORK_WATER : MANTLE_CHAIN_WORK);
         }

         if (workingLimb && entity.getWrapTarget() != 0) {
            shapeRate = Math.min(shapeRate, 9.0);
         } else if (exert > 0.001) {
            shapeRate = Mth.lerp((float)exert, (float)shapeRate, Math.max((float)shapeRate, MANTLE_CHAIN_EXERT_SHAPE));
         }

         double keepBase = water ? MANTLE_CHAIN_KEEP_WATER : MANTLE_CHAIN_KEEP;
         if (workingLimb) {
            keepBase = Math.min(keepBase, 0.55);
         } else if (exert > 0.001) {
            keepBase = Mth.lerp((float)exert, (float)keepBase, Math.min((float)keepBase, 0.55F));
         }

         double keep = Math.pow(keepBase, dt * 60.0);
         double brace = water ? MANTLE_CHAIN_BRACE_WATER : MANTLE_CHAIN_BRACE;
         if (workingLimb) {
            brace = Math.max(brace, 0.92);
         } else if (exert > 0.001) {
            brace = Mth.lerp((float)exert, (float)brace, Math.max((float)brace, MANTLE_CHAIN_EXERT_BRACE));
         }

         double lift = water ? 0.45 : -1.1;
         Vec3[] oldPos = new Vec3[16];
         Vec3[] predicted = new Vec3[16];
         Vec3[] tgtVel = new Vec3[16];
         Vec3[] pushN = new Vec3[16];
         st.pos[0] = root;

         for (int i = 1; i < 16; i++) {
            oldPos[i] = st.pos[i];
            Vec3 tv = tgt[i].subtract(st.prevTgt[i]);
            if (tv.lengthSqr() > 4.0) {
               tv = Vec3.ZERO;
            }

            if (tv.lengthSqr() > 0.12249999999999998) {
               tv = tv.normalize().scale(0.35);
            }

            tgtVel[i] = tv;
            double w = 1.0 - 0.4 * (i / 15.0);
            Vec3 err = tgt[i].subtract(st.pos[i]);
            Vec3 shapeMove = err.scale(1.0 - Math.exp(-shapeRate * w * dt));
            st.vel[i] = st.vel[i].add(0.0, lift * dt, 0.0);
            st.pos[i] = st.pos[i].add(st.vel[i].scale(dt)).add(shapeMove);
            predicted[i] = st.pos[i];
         }

         double bend = water ? MANTLE_CHAIN_BEND_WATER : MANTLE_CHAIN_BEND;
         if (workingLimb) {
            bend = Math.max(bend, 0.45);
         }

         for (int r = 0; r < 5; r++) {
            st.pos[0] = root;

            for (int i = 0; i < 15; i++) {
               Vec3 d = st.pos[i + 1].subtract(st.pos[i]);
               double dist = d.length();
               if (!(dist < 1.0E-6)) {
                  double restL = tgt[i + 1].subtract(tgt[i]).length();
                  if (shapeBoost > 1.01F) {
                     restL *= 1.035;
                  }

                  double diff = (dist - restL) / dist;
                  if (i == 0) {
                     st.pos[1] = st.pos[1].subtract(d.scale(diff));
                  } else {
                     st.pos[i] = st.pos[i].add(d.scale(0.5 * diff));
                     st.pos[i + 1] = st.pos[i + 1].subtract(d.scale(0.5 * diff));
                  }
               }
            }

            for (int i = 0; i < 14; i++) {
               Vec3 d = st.pos[i + 2].subtract(st.pos[i]);
               double dist = d.length();
               if (!(dist < 1.0E-6)) {
                  double restL = tgt[i + 2].subtract(tgt[i]).length();
                  double diff = (dist - restL) / dist * bend;
                  if (i == 0) {
                     st.pos[2] = st.pos[2].subtract(d.scale(diff));
                  } else {
                     st.pos[i] = st.pos[i].add(d.scale(0.5 * diff));
                     st.pos[i + 2] = st.pos[i + 2].subtract(d.scale(0.5 * diff));
                  }
               }
            }
         }

         if (owner.level() != null) {
            for (int i = 1; i < 16; i++) {
               TendrilFxRenderer.PushOut po = pushOut(owner.level(), st.pos[i], 0.06);
               if (po != null) {
                  st.pos[i] = po.pos();
                  pushN[i] = po.n();
               }
            }
         }

         double wave = water ? MANTLE_CHAIN_WAVE_WATER : MANTLE_CHAIN_WAVE;
         double invDt = 1.0 / Math.max(1.0E-4, dt);

         for (int i = 1; i < 16; i++) {
            Vec3 free = predicted[i].subtract(oldPos[i]);
            Vec3 cDelta = st.pos[i].subtract(predicted[i]);
            Vec3 rel = free.subtract(tgtVel[i]);
            Vec3 nv = tgtVel[i]
               .scale(brace * invDt)
               .add(rel.scale(keep * invDt))
               .add(pushN[i] == null ? cDelta.scale(wave * invDt) : Vec3.ZERO);
            if (pushN[i] != null) {
               double into = nv.dot(pushN[i]);
               if (into < 0.0) {
                  nv = nv.subtract(pushN[i].scale(into));
               }
            }

            if (nv.lengthSqr() > 400.0) {
               nv = nv.normalize().scale(20.0);
            }

            st.vel[i] = nv;
            st.prevTgt[i] = tgt[i];
         }

         st.prevTgt[0] = tgt[0];
         st.sampled = resampleChain(st.pos);
         return st.sampled;
      } else {
         for (int i = 0; i < 16; i++) {
            st.pos[i] = tgt[i];
            st.vel[i] = Vec3.ZERO;
            st.prevTgt[i] = tgt[i];
         }

         st.live = true;
         st.frame = frame;
         st.sampled = resampleChain(st.pos);
         return st.sampled;
      }
   }

   private static TendrilFxRenderer.PushOut pushOut(Level level, Vec3 p, double margin) {
      BlockPos bp = BlockPos.containing(p);
      VoxelShape shp = level.getBlockState(bp).getCollisionShape(level, bp);
      if (shp.isEmpty()) {
         return null;
      }

      for (AABB box : shp.toAabbs()) {
         AABB wb = box.move(bp);
         if (wb.contains(p)) {
            double[] push = new double[]{
               wb.maxX - p.x,
               p.x - wb.minX,
               wb.maxY - p.y,
               p.y - wb.minY,
               wb.maxZ - p.z,
               p.z - wb.minZ
            };
            int best = 0;

            for (int j = 1; j < 6; j++) {
               if (push[j] < push[best]) {
                  best = j;
               }
            }
            Vec3 n = switch (best) {
               case 0 -> new Vec3(1.0, 0.0, 0.0);
               case 1 -> new Vec3(-1.0, 0.0, 0.0);
               case 2 -> new Vec3(0.0, 1.0, 0.0);
               case 3 -> new Vec3(0.0, -1.0, 0.0);
               case 4 -> new Vec3(0.0, 0.0, 1.0);
               default -> new Vec3(0.0, 0.0, -1.0);
            };
            return new TendrilFxRenderer.PushOut(p.add(n.scale(push[best] + margin)), n);
         }
      }

      return null;
   }

   private static Vec3[] resampleChain(Vec3[] p) {
      Vec3[] out = new Vec3[32];
      int segs = p.length - 1;

      for (int i = 0; i < 32; i++) {
         double u = i / 31.0 * segs;
         int s = Math.min(segs - 1, (int)u);
         double t = u - s;
         Vec3 p0 = p[Math.max(0, s - 1)];
         Vec3 p1 = p[s];
         Vec3 p2 = p[s + 1];
         Vec3 p3 = p[Math.min(segs, s + 2)];
         double t2 = t * t;
         double t3 = t2 * t;
         out[i] = p1.scale(2.0)
            .add(p2.subtract(p0).scale(t))
            .add(p0.scale(2.0).subtract(p1.scale(5.0)).add(p2.scale(4.0)).subtract(p3).scale(t2))
            .add(p3.subtract(p0).add(p1.scale(3.0)).subtract(p2.scale(3.0)).scale(t3))
            .scale(0.5);
      }

      return out;
   }

   private static TendrilFxRenderer.BodyBasis bodyBasis(Entity owner, float partialTick, double forwardX, double forwardZ) {
      double prone = 0.0;
      double pitchDeg = 0.0;
      if (owner instanceof LivingEntity le) {
         prone = le.getSwimAmount(partialTick);
         if (le.isFallFlying()) {
            prone = Math.max(prone, Mth.clamp((le.getFallFlyingTicks() + partialTick) / 10.0F, 0.0F, 1.0F));
         }

         if (prone > 0.001 && (le.isInWater() || le.isFallFlying())) {
            pitchDeg = Mth.lerp(partialTick, le.xRotO, le.getXRot());
         }
      }

      Vec3 worldUp = new Vec3(0.0, 1.0, 0.0);
      Vec3 backFlat = new Vec3(-forwardX, 0.0, -forwardZ);
      if (prone <= 0.001) {
         return new TendrilFxRenderer.BodyBasis(0.0, worldUp, backFlat, worldUp, backFlat);
      }

      double theta = prone * Math.toRadians(90.0 + pitchDeg);
      double sin = Math.sin(theta);
      double cos = Math.cos(theta);
      Vec3 bodyUp = new Vec3(forwardX * sin, cos, forwardZ * sin);
      Vec3 bodyBack = new Vec3(-forwardX * cos, sin, -forwardZ * cos);
      Vec3 drapeUp = worldUp.lerp(bodyBack, prone).normalize();
      Vec3 drapeBack = backFlat.lerp(bodyUp.scale(-1.0), prone).normalize();
      return new TendrilFxRenderer.BodyBasis(prone, bodyUp, bodyBack, drapeUp, drapeBack);
   }

   private static Vec3 bodyPivot(double ox, double oy, double oz, double forwardX, double forwardZ, TendrilFxRenderer.BodyBasis bb, double bodyScale) {
      double pivotY = Mth.lerp((float)bb.prone(), MANTLE_PIVOT_STAND, MANTLE_PIVOT_PRONE) * bodyScale;
      double fwdShift = bb.prone() * MANTLE_PRONE_FWD * bodyScale;
      return new Vec3(ox + forwardX * fwdShift, oy + pivotY, oz + forwardZ * fwdShift);
   }

   private static TendrilFxRenderer.AnchorFrame anchorFrame(
      Entity owner, float partialTick, double forwardX, double forwardZ, double ox, double oy, double oz, double bodyScale
   ) {
      Vec3 worldUp = new Vec3(0.0, 1.0, 0.0);
      Vec3 backFlat = new Vec3(-forwardX, 0.0, -forwardZ);
      MantleBodyAnchor.Capture cap = MantleBodyAnchor.get(owner.getId());
      if (cap != null && owner.level() != null && Math.abs(owner.level().getGameTime() - cap.gameTime()) <= 2L) {
         double prone = Mth.clamp(1.0 - cap.up().y, 0.0, 1.0);
         Vec3 drapeUp = worldUp.lerp(cap.back(), prone).normalize();
         Vec3 drapeBack = backFlat.lerp(cap.up().scale(-1.0), prone).normalize();
         Vec3 origin = cap.origin().add(ox - cap.ownerLerpPos().x, oy - cap.ownerLerpPos().y, oz - cap.ownerLerpPos().z);
         return new TendrilFxRenderer.AnchorFrame(origin, cap.up(), cap.back(), cap.right(), drapeUp, drapeBack, prone);
      } else {
         TendrilFxRenderer.BodyBasis bb = bodyBasis(owner, partialTick, forwardX, forwardZ);
         Vec3 pivot = bodyPivot(ox, oy, oz, forwardX, forwardZ, bb, bodyScale);
         Vec3 right = new Vec3(forwardZ, 0.0, -forwardX);
         return new TendrilFxRenderer.AnchorFrame(pivot, bb.bodyUp(), bb.bodyBack(), right, bb.drapeUp(), bb.drapeBack(), bb.prone());
      }
   }

   private static Vec3 swayOffset(TendrilFxEntity entity, Entity owner, float partialTick, float slot) {
      Vec3 vel = new Vec3(owner.getX() - owner.xOld, owner.getY() - owner.yOld, owner.getZ() - owner.zOld);
      Vec3 prev = SWAY_CACHE.getOrDefault(entity.getId(), Vec3.ZERO);
      boolean under = owner.isUnderWater();
      boolean wet = under || owner.isInWater();
      double resist = under ? MANTLE_WATER_RESIST : (wet ? MANTLE_WATER_RESIST * 0.65 : 1.0);
      double dampScale = under ? 0.55 : (wet ? 0.75 : 1.0);
      double damp = MANTLE_DAMP * dampScale * (1.0 - Math.abs(slot) * 0.25);
      Vec3 smooth = prev.add(vel.scale(resist).subtract(prev).scale(damp));
      if (smooth.lengthSqr() > 0.30250000000000005) {
         smooth = smooth.normalize().scale(0.55);
      }

      SWAY_CACHE.put(entity.getId(), smooth);
      if (SWAY_CACHE.size() > 512) {
         SWAY_CACHE.clear();
      }

      Vec3 out = new Vec3(-smooth.x * MANTLE_SWAY, -smooth.y * MANTLE_BOUNCE, -smooth.z * MANTLE_SWAY);
      if (owner instanceof LivingEntity le && le.hurtTime > 0) {
         double f = le.hurtTime / 10.0;
         float t = entity.tickCount + partialTick;
         double shudder = 0.15 * f;
         out = out.add(
            Math.sin(slot * 7.3) * shudder * Math.sin(t * 2.9),
            0.55 * shudder * Math.abs(Math.sin(t * 3.4 + slot * 5.0)),
            Math.cos(slot * 7.3) * shudder * Math.sin(t * 2.9 + 1.1)
         );
      }

      return out;
   }

   private static boolean isCrown(TendrilFxEntity e) {
      return e.isShiny();
   }

   private static Vec3 wrapPoint(Entity target, float frac, Vec3 approachFrom, float partialTick) {
      if (target.getBbHeight() / Math.max(0.1F, target.getBbWidth()) >= 1.6F) {
         return beltPoint(target, frac, approachFrom, partialTick);
      }

      double cx = Mth.lerp(partialTick, target.xOld, target.getX());
      double cy = Mth.lerp(partialTick, target.yOld, target.getY()) + target.getBbHeight() * 0.5;
      double cz = Mth.lerp(partialTick, target.zOld, target.getZ());
      float yaw = target instanceof LivingEntity le ? Mth.lerp(partialTick, le.yBodyRotO, le.yBodyRot) : target.getYRot();
      double yawRad = Math.toRadians(yaw);
      Vec3 axis = new Vec3(-Math.sin(yawRad), 0.0, Math.cos(yawRad));
      Vec3 side = new Vec3(axis.z, 0.0, -axis.x);
      double rV = Math.max(0.3, target.getBbHeight() * 0.5 + WRAP_MARGIN);
      double rH = Math.max(0.3, target.getBbWidth() * 0.5 + WRAP_MARGIN);
      double au = approachFrom.y - cy;
      double as = (approachFrom.x - cx) * side.x + (approachFrom.z - cz) * side.z;
      double baseAng = Math.atan2(as, Math.max(0.001, Math.abs(au)) * Math.signum(au == 0.0 ? 1.0 : au));
      double ang = baseAng + frac * WRAP_SWEEP;
      double axial = (frac - 0.5) * target.getBbWidth() * WRAP_DROP;
      return new Vec3(
         cx + Math.cos(ang) * 0.0 + side.x * Math.sin(ang) * rH + axis.x * axial,
         cy + Math.cos(ang) * rV,
         cz + side.z * Math.sin(ang) * rH + axis.z * axial
      );
   }

   private static Vec3 beltPoint(Entity target, float frac, Vec3 approachFrom, float partialTick) {
      double cx = Mth.lerp(partialTick, target.xOld, target.getX());
      double cy = Mth.lerp(partialTick, target.yOld, target.getY());
      double cz = Mth.lerp(partialTick, target.zOld, target.getZ());
      double h = target.getBbHeight();
      double r = Math.max(0.35, target.getBbWidth() * 0.5 + WRAP_MARGIN);
      double baseAng = Math.atan2(approachFrom.z - cz, approachFrom.x - cx);
      double ang = baseAng + frac * WRAP_SWEEP;
      double y = cy + h * 0.62 - frac * h * WRAP_DROP;
      return new Vec3(cx + Math.cos(ang) * r, y, cz + Math.sin(ang) * r);
   }

   private static Vec3 wrapCenter(Entity target, float partialTick) {
      return new Vec3(
         Mth.lerp(partialTick, target.xOld, target.getX()),
         Mth.lerp(partialTick, target.yOld, target.getY()) + target.getBbHeight() * 0.5,
         Mth.lerp(partialTick, target.zOld, target.getZ())
      );
   }

   private static Entity wrapTargetOf(TendrilFxEntity entity) {
      int id = entity.getWrapTarget();
      if (id != 0 && entity.level() != null) {
         Entity t = entity.level().getEntity(id);
         return t != null && t.isAlive() ? t : null;
      } else {
         return null;
      }
   }

   private static float[] moodPose(TendrilFxEntity entity, double chestX, double chestY, double chestZ) {
      int packed = entity.getMantleMood();
      int moodOrd = packed & 7;
      boolean fix = (packed & 8) != 0 && entity.getMantleJobStart() == 0;
      float tH = 0.0F;
      float tS = 0.0F;
      float tB = 0.0F;
      float tA = 0.0F;
      switch (moodOrd) {
         case 1:
            tH = 0.28F;
            tS = 0.16F;
            tB = 0.06F;
            tA = 1.0F;
            break;
         case 2:
            tH = 0.15F;
            tS = -0.1F;
            tB = -0.3F;
            tA = 0.55F;
            break;
         case 3:
            tH = -0.42F;
            tS = -0.15F;
            tB = 0.18F;
            tA = -1.0F;
      }

      float tLx = 0.0F;
      float tLy = 0.0F;
      float tLz = 0.0F;
      if (fix) {
         Vec3 to = entity.getTargetPos().subtract(chestX, chestY, chestZ);
         double horiz = Math.sqrt(to.x * to.x + to.z * to.z);
         if (horiz > 0.5) {
            tLx = (float)(to.x / horiz * 0.45);
            tLz = (float)(to.z / horiz * 0.45);
            tLy = (float)Mth.clamp(to.y * 0.06, -0.15, 0.25);
         }
      }

      if (Minecraft.getInstance().screen instanceof MantleTuneScreen) {
         tH = 0.0F;
         tS = 0.0F;
         tB = 0.0F;
         tA = 0.0F;
         tLx = 0.0F;
         tLy = 0.0F;
         tLz = 0.0F;
      }

      float[] sm = MOOD_CACHE.computeIfAbsent(entity.getId(), k -> new float[7]);
      sm[0] += (tH - sm[0]) * 0.055F;
      sm[1] += (tS - sm[1]) * 0.055F;
      sm[2] += (tB - sm[2]) * 0.055F;
      sm[3] += (tA - sm[3]) * 0.055F;
      sm[4] += (tLx - sm[4]) * 0.055F;
      sm[5] += (tLy - sm[5]) * 0.055F;
      sm[6] += (tLz - sm[6]) * 0.055F;
      if (MOOD_CACHE.size() > 512) {
         MOOD_CACHE.clear();
      }

      return sm;
   }

   private static float moodAgitation(int entityId) {
      float[] sm = MOOD_CACHE.get(entityId);
      return sm == null ? 0.0F : Math.max(0.0F, sm[3]);
   }

   private static Vec3 crownRestPos(TendrilFxEntity entity, Entity owner, float partialTick) {
      double ox = Mth.lerp(partialTick, owner.xOld, owner.getX());
      double oy = Mth.lerp(partialTick, owner.yOld, owner.getY());
      double oz = Mth.lerp(partialTick, owner.zOld, owner.getZ());
      double bodyScale = owner instanceof Player && ArmorStateClientCache.isActive(owner.getUUID()) ? 1.35F : 1.0;
      float slot = Mth.clamp(entity.getHoverBaseAngle(), -1.0F, 1.0F);
      double absSlot = Math.abs(slot);
      float age = entity.tickCount + partialTick;
      double bob = Math.sin(age * 0.1 + slot * 2.7) * 0.25;
      float yawRad = (float)Math.toRadians(Mth.lerp(partialTick, owner.yRotO, owner.getYRot()));
      double forwardX = -Math.sin(yawRad);
      double forwardZ = Math.cos(yawRad);
      double rightZ = -forwardX;
      boolean crn = isCrown(entity);
      float[] mood = crn ? null : moodPose(entity, ox, oy + 1.3, oz);
      double agit = mood == null ? 0.0 : Math.max(0.0F, mood[3]);
      double grief = mood == null ? 0.0 : Math.max(0.0F, -mood[3]);
      double bobShaped = bob * (1.0 + 0.55 * agit - 0.5 * grief) + agit * Math.sin(age * 0.9 + slot * 4.0) * 0.05;
      double side = slot * ((crn ? 1.08F : MANTLE_SIDE) * (1.0 + (mood == null ? 0.0F : mood[1]))) * bodyScale;
      double back = ((crn ? 0.58F : MANTLE_BACK) + absSlot * (crn ? 0.28F : MANTLE_BACK_SPREAD) + (mood == null ? 0.0F : mood[2])) * bodyScale;
      double height = (
            (crn ? 1.86F : MANTLE_HEIGHT)
               + (1.0 - absSlot) * (crn ? 0.76F : MANTLE_HEIGHT_CENTER)
               + (mood == null ? 0.0F : mood[0])
               + bobShaped * (0.45 + (1.0 - absSlot) * 0.35)
         )
         * bodyScale;
      TendrilFxRenderer.AnchorFrame fr = anchorFrame(owner, partialTick, forwardX, forwardZ, ox, oy, oz, bodyScale);
      Vec3 rest = fr.pivot()
         .add(fr.drapeUp().scale(height - MANTLE_PIVOT_STAND * bodyScale))
         .add(fr.drapeBack().scale(back))
         .add(fr.rightAxis().scale(side));
      if (mood != null) {
         rest = rest.add(mood[4], mood[5], mood[6]);
      }

      if (!crn) {
         Vec3 trail = SWAY_CACHE.getOrDefault(entity.getId(), Vec3.ZERO);
         double trailLen = trail.length();
         double streamAmt = 0.0;
         if (owner.isUnderWater() && trailLen > 0.001) {
            streamAmt = Mth.clamp(trailLen / 0.32, 0.0, 1.0) * MANTLE_STREAM;
            Vec3 trailDir = trail.scale(-1.0 / trailLen);
            Vec3 streamed = fr.pivot()
               .add(trailDir.scale(1.05 + absSlot * 0.6))
               .add(fr.rightAxis().scale(slot * 0.38))
               .add(fr.drapeUp().scale(0.18 + (1.0 - absSlot) * 0.1));
            rest = rest.lerp(streamed, streamAmt);
         }

         if (owner.isUnderWater()) {
            rest = rest.add(fr.drapeUp().scale(Math.sin(age * 0.045 + slot * 1.9) * 0.09 * (1.0 - streamAmt)));
         }

         rest = rest.add(swayOffset(entity, owner, partialTick, slot).scale(0.55 * (1.0 - 0.6 * streamAmt)));
      }

      return rest;
   }

   private static float[] strainBaseColor(SymbioteStrain strain) {
      return switch (strain) {
         case GUARDIAN -> COL_GUARDIAN;
         case PREDATOR -> COL_PREDATOR;
         case SHADOW -> COL_SHADOW;
         case SCULK -> COL_SCULK;
         case ROYAL -> COL_ROYAL;
      };
   }

   private static Vec3 bezier(Vec3 p0, Vec3 p1, Vec3 p2, float t) {
      double oneMinus = 1.0 - t;
      return p0.scale(oneMinus * oneMinus).add(p1.scale(2.0 * oneMinus * t)).add(p2.scale((double)t * t));
   }

   private static Vec3 bezierCubic(Vec3 p0, Vec3 p1, Vec3 p2, Vec3 p3, float t) {
      double u = 1.0 - t;
      return p0.scale(u * u * u).add(p1.scale(3.0 * u * u * t)).add(p2.scale(3.0 * u * t * t)).add(p3.scale((double)t * t * t));
   }

   private static float radiusAt(float t) {
      float base = Mth.lerp(t * t, 0.17F, 0.075F);
      float bulge = 0.045F * (float)Math.sin(Math.PI * t);
      float tipSqueeze = 1.0F - 0.18F * smoothstep(0.72F, 1.0F, t);
      return (base + bulge) * tipSqueeze;
   }

   private static float organicRadius(float baseRadius, float t, int side, float age) {
      float w1 = 0.08F * (float)Math.sin(age * 0.18F + t * 18.0F + side * 1.7F);
      float w2 = 0.04F * (float)Math.sin(age * 0.31F + t * 31.0F + side * 2.3F);
      return baseRadius * (1.0F + w1 + w2);
   }

   private static float hash01(int x) {
      x ^= x >>> 16;
      x *= 2146121005;
      x ^= x >>> 15;
      x *= -2073254261;
      x ^= x >>> 16;
      return (x & 16777215) / 1.6777215E7F;
   }

   private static TendrilFxRenderer.LightKey worldLightDir(TendrilFxEntity entity) {
      TendrilFxRenderer.LightKey c = LIGHT_KEY_CACHE.get(entity.getId());
      long now = entity.level().getGameTime();
      if (c != null && now - c.at < 20L) {
         return c;
      }

      if (LIGHT_KEY_CACHE.size() > 256) {
         LIGHT_KEY_CACHE.clear();
      }

      if (c == null) {
         c = new TendrilFxRenderer.LightKey();
         LIGHT_KEY_CACHE.put(entity.getId(), c);
      }

      c.at = now;
      Level level = entity.level();
      BlockPos base = entity.blockPosition().above();
      int r = 3;
      float gx = level.getBrightness(LightLayer.BLOCK, base.east(r)) - level.getBrightness(LightLayer.BLOCK, base.west(r));
      float gy = level.getBrightness(LightLayer.BLOCK, base.above(r)) - level.getBrightness(LightLayer.BLOCK, base.below(r));
      float gz = level.getBrightness(LightLayer.BLOCK, base.south(r)) - level.getBrightness(LightLayer.BLOCK, base.north(r));
      float bl = level.getBrightness(LightLayer.BLOCK, base) / 15.0F;
      float sk = level.getBrightness(LightLayer.SKY, base) / 15.0F;
      float gm = (float)Math.sqrt(gx * gx + gy * gy + gz * gz);
      float a = entity.level().getSunAngle(1.0F);
      float sunX = Mth.cos(a);
      float sunY = Mth.sin(a);
      boolean day = level.isDay();
      if (!day) {
         sunX = -sunX;
         sunY = -sunY;
      }

      if (sunY < 0.0F) {
         sunX = -sunX;
         sunY = -sunY;
      }

      float wSun = sk * (day ? 1.0F : 0.35F);
      float wBlock = gm > 0.5F ? bl * 1.4F : 0.0F;
      float x = sunX * wSun;
      float y = sunY * wSun;
      float z = 0.0F;
      if (wBlock > 0.0F) {
         x += gx / gm * wBlock;
         y += gy / gm * wBlock;
         z += gz / gm * wBlock;
      }

      float len = (float)Math.sqrt(x * x + y * y + z * z);
      c.valid = len > 0.1F;
      if (c.valid) {
         c.x = x / len;
         c.y = y / len;
         c.z = z / len;
      }

      return c;
   }

   private static void flushGlint(MultiBufferSource bufferSource) {
      if (!GLINT_VERTS.isEmpty()) {
         VertexConsumer g = bufferSource.getBuffer(RenderType.lightning());

         for (float[] v : GLINT_VERTS) {
            g.addVertex(v[0], v[1], v[2]).setColor(v[3], v[3], v[3], 1.0F);
         }

         GLINT_VERTS.clear();
      }
   }

   private static void quad(
      VertexConsumer buf,
      Matrix4f m,
      Matrix3f n,
      int light,
      float r,
      float g,
      float b,
      float a,
      Vec3 p1,
      float u1,
      float v1,
      Vec3 p2,
      float u2,
      float v2,
      Vec3 p3,
      float u3,
      float v3,
      Vec3 p4,
      float u4,
      float v4,
      Vec3 normal
   ) {
      vertex(buf, m, n, light, r, g, b, a, p1, u1, v1, normal);
      vertex(buf, m, n, light, r, g, b, a, p2, u2, v2, normal);
      vertex(buf, m, n, light, r, g, b, a, p3, u3, v3, normal);
      vertex(buf, m, n, light, r, g, b, a, p4, u4, v4, normal);
      int facet = GLINT_SEED_BASE + GLINT_QI++;
      if (VanillaSheen.GLINT_STRENGTH > 0.01F && a > 0.15F && !VanillaSheen.shadersActive()) {
         float chaos = VanillaSheen.GLINT_CHAOS;
         float h1 = hash01(facet * 3);
         float h2 = hash01(facet * 3 + 1);
         float h3 = hash01(facet * 3 + 2);
         if (h1 < 0.4F * chaos) {
            return;
         }

         float gain = 1.0F + chaos * (h2 * 1.6F - 0.5F);
         Vec3 gn = chaos > 0.01F ? normal.add((h1 - 0.5F) * 0.9F * chaos, (h2 - 0.5F) * 0.9F * chaos, (h3 - 0.5F) * 0.9F * chaos).normalize() : normal;
         float ge = VanillaSheen.GLINT_EXP;
         float gs = VanillaSheen.GLINT_STRENGTH * a * gain;
         Vec3 off = normal.scale(0.004);
         float s1 = VanillaSheen.specTransform(m, n, p1.add(off), gn, light, ge, gs, GP1, GKEY.x, GKEY.y, GKEY.z);
         float s2 = VanillaSheen.specTransform(m, n, p2.add(off), gn, light, ge, gs, GP2, GKEY.x, GKEY.y, GKEY.z);
         float s3 = VanillaSheen.specTransform(m, n, p3.add(off), gn, light, ge, gs, GP3, GKEY.x, GKEY.y, GKEY.z);
         float s4 = VanillaSheen.specTransform(m, n, p4.add(off), gn, light, ge, gs, GP4, GKEY.x, GKEY.y, GKEY.z);
         if (s1 > 0.02F || s2 > 0.02F || s3 > 0.02F || s4 > 0.02F) {
            GLINT_VERTS.add(new float[]{GP1.x, GP1.y, GP1.z, s1});
            GLINT_VERTS.add(new float[]{GP2.x, GP2.y, GP2.z, s2});
            GLINT_VERTS.add(new float[]{GP3.x, GP3.y, GP3.z, s3});
            GLINT_VERTS.add(new float[]{GP4.x, GP4.y, GP4.z, s4});
         }
      }
   }

   private static void vertex(
      VertexConsumer buf, Matrix4f m, Matrix3f n, int light, float r, float g, float b, float a, Vec3 pos, float u, float v, Vec3 normal
   ) {
      float spec = VanillaSheen.spec(m, n, pos, normal, light, 9.0F, 0.42F);
      if (spec > 0.0F) {
         r += (1.0F - r) * spec;
         g += (1.0F - g) * spec;
         b += (1.0F - b) * spec;
      }

      Verts.normal(buf.addVertex(m, (float)pos.x, (float)pos.y, (float)pos.z)
         .setColor(r, g, b, a)
         .setUv(u, v)
         .setOverlay(OverlayTexture.NO_OVERLAY)
         .setLight(light)
         , n, (float)normal.x, (float)normal.y, (float)normal.z);
   }

   public ResourceLocation getTextureLocation(TendrilFxEntity entity) {
      return switch (entity.getStrain()) {
         case GUARDIAN, SHADOW, SCULK -> TEX_GUARDIAN;
         case PREDATOR, ROYAL -> TEX_PREDATOR;
      };
   }

   private static float alphaForProgress(float p, int mode) {
      if (mode == 1) {
         return p > 0.92F ? Mth.clamp((1.0F - p) / 0.08F, 0.0F, 1.0F) : 1.0F;
      } else if (p < 0.1F) {
         return Mth.clamp(p / 0.1F, 0.0F, 1.0F);
      } else {
         return p > 0.85F ? Mth.clamp((1.0F - p) / 0.15F, 0.0F, 1.0F) : 1.0F;
      }
   }

   private static float smoothstep(float t) {
      t = Mth.clamp(t, 0.0F, 1.0F);
      return t * t * (3.0F - 2.0F * t);
   }

   private static float smoothstep(float edge0, float edge1, float x) {
      float t = Mth.clamp((x - edge0) / (edge1 - edge0), 0.0F, 1.0F);
      return t * t * (3.0F - 2.0F * t);
   }

   private record AnchorFrame(Vec3 pivot, Vec3 bodyUp, Vec3 bodyBack, Vec3 rightAxis, Vec3 drapeUp, Vec3 drapeBack, double prone) {
   }

   private record BodyBasis(double prone, Vec3 bodyUp, Vec3 bodyBack, Vec3 drapeUp, Vec3 drapeBack) {
   }

   private static final class ChainState {
      final Vec3[] pos = new Vec3[16];
      final Vec3[] vel = new Vec3[16];
      final Vec3[] prevTgt = new Vec3[16];
      Vec3[] sampled;
      long frame = -1L;
      boolean live = false;
      int lastWrapId = 0;
      float wrapWind = 0.0F;
   }

   private static final class LightKey {
      long at;
      float x;
      float y;
      float z;
      boolean valid;
   }

   private record PushOut(Vec3 pos, Vec3 n) {
   }
}
