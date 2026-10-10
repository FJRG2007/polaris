package com.scout.symbiote.client.armor;

import com.scout.symbiote.client.RenderStateBridge;
import net.minecraft.client.player.AbstractClientPlayer;
import com.mojang.blaze3d.vertex.PoseStack;
import com.scout.symbiote.ability.LivingArmorSizing;
import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.EntityDimensions;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.player.Player;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent.Stage;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Post;
import net.neoforged.neoforge.client.event.RenderPlayerEvent.Pre;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.event.entity.EntityEvent.Size;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class LivingArmorClientSizing {
   private static final Set<UUID> SCALED_RENDERS = new HashSet<>();
   private static final Map<UUID, PoseStack> PUSHED_ON = new HashMap<>();
   private static long lastStrandLogMs;
   private static final float SIZE_EPSILON = 0.01F;
   private static final int RECONCILE_INTERVAL = 10;
   private static int reconcileCounter;
   private static long lastReconcileLogMs;

   @SubscribeEvent
   public static void onEntitySize(Size event) {
      if (event.getEntity() instanceof Player player) {
         if (player.level().isClientSide) {
            if (isLivingArmorActive(player)) {
               LivingArmorSizing.applyLargeDimensions(event);
            }
         }
      }
   }

   @SubscribeEvent(priority = EventPriority.LOWEST)
   public static void onRenderPlayerPre(Pre event) {
      AbstractClientPlayer player = RenderStateBridge.player(event.getRenderState());
      if (player != null && isLivingArmorActive(player)) {
         EpicFightArmorDiagnostics.playerPass(player);
         event.getPoseStack().pushPose();
         event.getPoseStack().scale(1.35F, 1.35F, 1.35F);
         SCALED_RENDERS.add(player.getUUID());
         PUSHED_ON.put(player.getUUID(), event.getPoseStack());
      }
   }

   @SubscribeEvent(priority = EventPriority.HIGHEST)
   public static void onRenderPlayerPost(Post event) {
      AbstractClientPlayer player = RenderStateBridge.player(event.getRenderState());
      if (player != null && SCALED_RENDERS.remove(player.getUUID())) {
         PUSHED_ON.remove(player.getUUID());
         event.getPoseStack().popPose();
      }
   }

   @SubscribeEvent
   public static void onRenderStage(RenderLevelStageEvent event) {
      if (event.getStage() == Stage.AFTER_ENTITIES) {
         if (!SCALED_RENDERS.isEmpty()) {
            PoseStack main = event.getPoseStack();
            int recovered = 0;

            for (UUID id : SCALED_RENDERS) {
               if (PUSHED_ON.get(id) == main && !main.clear()) {
                  main.popPose();
                  recovered++;
               }
            }

            long now = System.currentTimeMillis();
            if (now - lastStrandLogMs > 10000L) {
               lastStrandLogMs = now;
               SymbioteLog.notice(
                  "[armor_size] %d scale push(es) stranded: a player was rendered without RenderPlayerEvent.Post firing (another mod's render path). Recovered %d on the main stack.",
                  SCALED_RENDERS.size(),
                  recovered
               );
            }

            SCALED_RENDERS.clear();
            PUSHED_ON.clear();
         }
      }
   }

   @SubscribeEvent
   public static void onClientTick(ClientTickEvent.Post event) {
      if (true) {
         if (++reconcileCounter >= 10) {
            reconcileCounter = 0;
            Minecraft minecraft = Minecraft.getInstance();
            if (minecraft.level != null && !minecraft.isPaused()) {
               for (Player player : minecraft.level.players()) {
                  reconcile(player);
               }
            }
         }
      }
   }

   private static void reconcile(Player player) {
      Pose pose = player.getPose();
      EntityDimensions base = player.getDimensions(pose);
      if (!base.fixed() && pose != Pose.SLEEPING && pose != Pose.DYING) {
         boolean active = isLivingArmorActive(player);
         float scaled = base.height() * 1.35F;
         float want = active ? scaled : base.height();
         float stale = active ? base.height() : scaled;


         float have = player.getBbHeight();
         if (!(Math.abs(have - want) <= 0.01F)) {
            if (!(Math.abs(have - stale) > 0.01F)) {
               player.refreshDimensions();
               long now = System.currentTimeMillis();
               if (now - lastReconcileLogMs > 10000L) {
                  lastReconcileLogMs = now;
                  SymbioteLog.notice(
                     "[armor_size] ARMOR_SIZE_RECONCILE player=%s active=%s height %.2f to %.2f: a dimension refresh was missed and has been replayed.",
                     player.getGameProfile().getName(),
                     active,
                     have,
                     want
                  );
               }
            }
         }
      }
   }

   public static void refreshPlayerDimensions(UUID playerId) {
      Minecraft minecraft = Minecraft.getInstance();
      if (minecraft.level != null) {
         Player player = minecraft.level.getPlayerByUUID(playerId);
         if (player != null) {
            player.refreshDimensions();
         }
      }
   }

   public static void refreshLocalPlayerDimensions() {
      Minecraft minecraft = Minecraft.getInstance();
      if (minecraft.player != null) {
         minecraft.player.refreshDimensions();
      }
   }

   private static boolean isLivingArmorActive(Player player) {
      return !(player instanceof LocalPlayer)
         ? ArmorStateClientCache.isActive(player.getUUID())
         : SymbioteClientState.isBonded() && SymbioteClientState.isLivingArmorActive();
   }

   private LivingArmorClientSizing() {
   }
}
