package com.scout.symbiote.client;

import net.minecraft.world.entity.ai.attributes.Attributes;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.network.ServerboundArmActionPacket;
import com.scout.symbiote.tracker.BondStage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.InputEvent.InteractionKeyMappingTriggered;
import net.neoforged.neoforge.common.NeoForgeMod;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class ReachExtensionHandler {
   private static int tick = 0;
   private static int lastMineSendTick = -100;
   private static int lastMeleeSendTick = -100;
   private static final int MINE_HOLD_MIN_TICKS = 10;
   private static final ReachMiningHold MINE_HOLD = new ReachMiningHold(10);

   @SubscribeEvent
   public static void onAttackInput(InteractionKeyMappingTriggered event) {
      if (event.isAttack()) {
         Minecraft mc = Minecraft.getInstance();
         LocalPlayer player = mc.player;
         if (player != null && mc.level != null && armed()) {
            if (mc.hitResult == null || mc.hitResult.getType() == Type.MISS) {
               double entityReach = reach(player, Attributes.ENTITY_INTERACTION_RANGE, 3.0);
               if (raycastEntity(player, 7.0) instanceof LivingEntity le && le != player) {
                  double d = player.getEyePosition().distanceTo(le.position().add(0.0, le.getBbHeight() * 0.5, 0.0));
                  if (d > entityReach + 0.4 && tick - lastMeleeSendTick >= 6) {
                     lastMeleeSendTick = tick;
                     net.neoforged.neoforge.network.PacketDistributor.sendToServer(ServerboundArmActionPacket.melee(le.getId()));
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent
   public static void onClientTick(ClientTickEvent.Post event) {
      if (true) {
         tick++;
         Minecraft mc = Minecraft.getInstance();
         LocalPlayer player = mc.player;
         if (player != null && mc.level != null) {
            boolean attackDown = mc.options.keyAttack.isDown();
            boolean hasArms = armed();
            boolean vanillaTarget = mc.hitResult != null && mc.hitResult.getType() != Type.MISS;
            if (MINE_HOLD.canAttempt(attackDown, hasArms, vanillaTarget)) {
               if (tick - lastMineSendTick >= 8) {
                  double blockReach = reach(player, Attributes.BLOCK_INTERACTION_RANGE, 4.5);
                  BlockHitResult bhr = raycastBlock(player, 7.0);
                  if (bhr != null && bhr.getType() == Type.BLOCK) {
                     BlockPos pos = bhr.getBlockPos();
                     double d = player.getEyePosition().distanceTo(Vec3.atCenterOf(pos));
                     if (d > blockReach + 0.4 && !mc.level.getBlockState(pos).isAir()) {
                        lastMineSendTick = tick;
                        MINE_HOLD.markSent();
                        net.neoforged.neoforge.network.PacketDistributor.sendToServer(ServerboundArmActionPacket.mining(pos));
                     }
                  }
               }
            }
         }
      }
   }

   private static boolean armed() {
      LocalPlayer lp = Minecraft.getInstance().player;
      if (lp != null && !lp.isCreative() && !lp.isSpectator()) {
         if (!SymbioteClientState.getStage().isAtLeast(BondStage.COOPERATIVE)) {
            return false;
         }

         for (int i = 0; i < SymbioteClientState.getArmSlotCount(); i++) {
            if (!SymbioteClientState.getArmSlot(i).isEmpty()) {
               return true;
            }
         }

         return false;
      } else {
         return false;
      }
   }

   private static double reach(LocalPlayer player, net.minecraft.core.Holder<Attribute> attr, double fallback) {
      return player.getAttribute(attr) != null ? player.getAttributeValue(attr) : fallback;
   }

   private static Entity raycastEntity(LocalPlayer player, double range) {
      Vec3 eye = player.getEyePosition();
      Vec3 end = eye.add(player.getLookAngle().scale(range));
      AABB box = player.getBoundingBox().expandTowards(player.getLookAngle().scale(range)).inflate(1.0);
      EntityHitResult hit = ProjectileUtil.getEntityHitResult(
         player.level(), player, eye, end, box, e -> e instanceof LivingEntity && e != player && e.isPickable() && e.isAlive()
      );
      return hit == null ? null : hit.getEntity();
   }

   private static BlockHitResult raycastBlock(LocalPlayer player, double range) {
      Vec3 eye = player.getEyePosition();
      Vec3 end = eye.add(player.getLookAngle().scale(range));
      return player.level().clip(new ClipContext(eye, end, Block.OUTLINE, Fluid.NONE, player));
   }

   private ReachExtensionHandler() {
   }
}
