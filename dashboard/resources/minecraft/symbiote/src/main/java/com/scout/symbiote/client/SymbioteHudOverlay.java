package com.scout.symbiote.client;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemStack;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.LayeredDraw;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.util.ARGB;
import net.neoforged.neoforge.client.event.RegisterGuiLayersEvent;
import net.neoforged.neoforge.client.gui.VanillaGuiLayers;

public final class SymbioteHudOverlay {
   private static final int COLOR_BOND = -2785025;
   private static final int COLOR_TRUST = -7347320;
   private static final int COLOR_STRESS = -38037;
   private static final int COLOR_HUNGER = -30128;
   private static final int COLOR_LABEL = -5592406;
   private static final int COLOR_BG = -2013265920;
   private static final int COLOR_CONTROL = -15073242;
   private static final int SHADOW = -1441527794;
   private static final boolean DESCENT_CLUSTER_ENABLED = false;
   private static final ResourceLocation TEX_HUNGER_STARVING = gui("hunger_bar_fill_starving.png");
   private static final ResourceLocation[] TEX_HUNGER_FRAME_S;
   private static final ResourceLocation[] TEX_HUNGER_FILL_S;
   private static final ResourceLocation[][] TEX_BOND_STAGE_S;
   private static final ResourceLocation TEX_PIP_SOCKET;
   private static final ResourceLocation TEX_PIP_NODE_MOOD;
   private static final ResourceLocation[] TEX_PIP_NODE_S;
   private static final int PIP = 7;
   private static final int PIP_TEX_H = 7;
   private static final ResourceLocation TEX_CONTROL_VIGNETTE;
   private static final ResourceLocation TEX_SUBTITLE_PLATE;
   private static final ResourceLocation TEX_CMD_PROTECT;
   private static final ResourceLocation TEX_CMD_HUNT;
   private static final ResourceLocation TEX_CMD_HIDE;
   private static final int CMD_ICON_TEX = 28;
   private static final ResourceLocation TEX_SHANK_EMPTY;
   private static final ResourceLocation[] TEX_SHANK_FULL_S;
   private static final ResourceLocation[] TEX_SHANK_HALF_S;
   private static final int HUNGER_W = 84;
   private static final int HUNGER_H = 13;
   private static final int BOND_SIZE = 16;
   private static final int SHANK = 9;
   private static final int VIG_W = 320;
   private static final int VIG_H = 180;
   private static final int SUB_W = 160;
   private static final int SUB_H = 28;
   private static final LayeredDraw.Layer HUNGER_AND_FX;
   private static final int ARM_SLOT_BOX = -871235562;
   private static final int ARM_SLOT_BORDER = -12972470;
   private static final int ARM_SLOT_BORDER_OFF = -11197918;
   private static final LayeredDraw.Layer ARM_SLOTS;
   private static final LayeredDraw.Layer COMMAND_MODE;
   private static final LayeredDraw.Layer MOOD_BLEED;
   private static float gripSeize;
   private static boolean surgeLogged;
   private static final LayeredDraw.Layer CONTROL_PULSE;
   private static final LayeredDraw.Layer SUBTITLE;
   private static final LayeredDraw.Layer BOND_PULSE;

   /** 1.21.4 GuiGraphics has no setColor; the tint travels with each blit as an ARGB color. */
   private static int tint(float r, float g, float b, float alpha) {
      return ARGB.colorFromFloat(Math.max(0.0F, Math.min(1.0F, alpha)), r, g, b);
   }

   private static ResourceLocation gui(String f) {
      return ResourceLocation.fromNamespaceAndPath("symbiote", "textures/gui/" + f);
   }

   private static void blitTex(GuiGraphics g, ResourceLocation tex, int x, int y, int w, int h, float alpha) {
      g.blit(RenderType::guiTextured, tex, x, y, 0.0F, 0.0F, w, h, w, h, tint(1.0F, 1.0F, 1.0F, alpha));
   }

   private static void blitStretch(
      GuiGraphics g, ResourceLocation tex, int x, int y, int dw, int dh, int texW, int texH, float r, float gr, float b, float alpha
   ) {
      g.blit(RenderType::guiTextured, tex, x, y, 0.0F, 0.0F, dw, dh, texW, texH, texW, texH, tint(r, gr, b, alpha));
   }

   public static void register(RegisterGuiLayersEvent event) {
      event.registerAbove(VanillaGuiLayers.HOTBAR, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_mood_bleed"), MOOD_BLEED);
      event.registerAbove(VanillaGuiLayers.HOTBAR, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_control_pulse"), CONTROL_PULSE);
      event.registerAbove(VanillaGuiLayers.HOTBAR, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_arm_slots"), ARM_SLOTS);
      event.registerAbove(VanillaGuiLayers.AIR_LEVEL, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_command_mode"), COMMAND_MODE);
      event.registerAbove(VanillaGuiLayers.AIR_LEVEL, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_hud"), HUNGER_AND_FX);
      event.registerAbove(VanillaGuiLayers.HOTBAR, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_subtitle"), SUBTITLE);
      event.registerAbove(VanillaGuiLayers.HOTBAR, ResourceLocation.fromNamespaceAndPath("symbiote", "symbiote_bond_pulse"), BOND_PULSE);
   }

   private static void drawDescentPips(GuiGraphics g, BondStage stage, int x, int y, int strainIdx) {
      int reached = stage.ordinal();
      int cur;
      int next;
      switch (stage) {
         case ATTACHED:
            cur = 0;
            next = (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get();
            break;
         case INTEGRATED:
            cur = (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get();
            next = (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get();
            break;
         case COOPERATIVE:
            cur = (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get();
            next = (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get();
            break;
         default:
            cur = 0;
            next = 0;
      }

      float frac = next > cur ? Math.max(0.0F, Math.min(1.0F, (float)(SymbioteClientState.getBond() - cur) / (next - cur))) : 0.0F;
      ResourceLocation node = TEX_PIP_NODE_S[strainIdx];

      for (int i = 0; i < 4; i++) {
         int px = x + i * 8;
         blitTex(g, TEX_PIP_SOCKET, px, y, 7, 7, 1.0F);
         if (i < reached) {
            float alpha = 1.0F;
            if (i == 3 && stage == BondStage.DOMINANT) {
               alpha = 0.6F + 0.4F * (float)Math.sin(SymbioteClientState.getClientTick() / 12.0);
            }

            blitNode(g, node, px, y, 7, 1.0F, 1.0F, 1.0F, alpha);
         } else if (i == reached && frac > 0.0F) {
            int h = Math.max(0, Math.round(7.0F * frac));
            if (h > 0) {
               blitNode(g, node, px, y + 7 - h, h, 1.0F, 1.0F, 1.0F, 1.0F);
            }
         }
      }
   }

   private static void blitNode(GuiGraphics g, ResourceLocation tex, int x, int y, int h, float r, float gr, float b, float alpha) {
      g.blit(RenderType::guiTextured, tex, x, y, 0.0F, 7 - h, 7, h, 7, 7, tint(r, gr, b, alpha));
   }

   private static void drawStageLabel(GuiGraphics g, BondStage stage, int bondX, int bondY) {
      long since = SymbioteClientState.getClientTick() - SymbioteClientState.getLastStageChangeTick();
      int show = 80;
      if (since >= 0L && since < show) {
         float alpha = since < 10L ? (float)since / 10.0F : (since > show - 20 ? (float)(show - since) / 20.0F : 1.0F);
         int a = Math.max(4, (int)(alpha * 255.0F)) & 0xFF;
         Font font = Minecraft.getInstance().font;
         String name = stage.name().charAt(0) + stage.name().substring(1).toLowerCase();
         g.drawString(font, name, bondX, bondY - 11, a << 24 | 15260912, true);
      }
   }

   private static void drawMoodTick(GuiGraphics g, int x, int y) {
      MoodEngine.Mood mood = SymbioteClientState.getMood();
      long tick = SymbioteClientState.getClientTick();
      int rgb;
      double period;
      float floor;
      switch (mood) {
         case CONTENT:
            rgb = 8112507;
            period = 24.0;
            floor = 0.55F;
            break;
         case ANXIOUS:
            rgb = 13154416;
            period = 10.0;
            floor = 0.45F;
            break;
         case COILED:
            rgb = 14702680;
            period = 4.0;
            floor = 0.3F;
            break;
         default:
            rgb = 8949928;
            period = 40.0;
            floor = 0.25F;
      }

      float breathe = 0.5F + 0.5F * (float)Math.sin(tick / period);
      float alphaF = floor + (1.0F - floor) * breathe;
      if (mood == MoodEngine.Mood.GRIEVING) {
         alphaF *= 0.6F;
      }

      blitTex(g, TEX_PIP_SOCKET, x, y, 7, 7, 1.0F);
      blitNode(g, TEX_PIP_NODE_MOOD, x, y, 7, (rgb >> 16 & 0xFF) / 255.0F, (rgb >> 8 & 0xFF) / 255.0F, (rgb & 0xFF) / 255.0F, alphaF);
   }

   private static void renderVignette(GuiGraphics g, String fxId, int color, int sw, int sh) {
      if (OverrideFxClient.isActive(fxId)) {
         float frac = OverrideFxClient.getFraction(fxId);
         float alpha = frac < 0.8F ? frac / 0.8F : 1.0F;
         int barAlpha = (int)(alpha * 180.0F) & 0xFF;
         int edgeColor = barAlpha << 24 | color & 16777215;
         int thickness = (int)(sh * 0.15F);
         g.fillGradient(0, 0, sw, thickness, edgeColor, edgeColor & 16777215);
         g.fillGradient(0, sh - thickness, sw, sh, edgeColor & 16777215, edgeColor);
         g.fillGradient(0, 0, (int)(sw * 0.12F), sh, edgeColor, edgeColor & 16777215);
         g.fillGradient(sw - (int)(sw * 0.12F), 0, sw, sh, edgeColor & 16777215, edgeColor);
      }
   }

   private static void drawArmSlot(GuiGraphics g, int x, int y, ItemStack stack, boolean off, boolean contraband) {
      g.fill(x, y, x + 20, y + 20, -871235562);
      int rim = off ? -11197918 : -12972470;
      g.fill(x, y, x + 20, y + 1, rim);
      g.fill(x, y + 19, x + 20, y + 20, rim);
      g.fill(x, y, x + 1, y + 20, rim);
      g.fill(x + 19, y, x + 20, y + 20, rim);
      if (stack != null && !stack.isEmpty()) {
         Font font = Minecraft.getInstance().font;
         g.renderItem(stack, x + 2, y + 2);
         g.renderItemDecorations(font, stack, x + 2, y + 2);
      }

      if (off) {
         g.fill(x + 1, y + 1, x + 19, y + 19, -1728053248);
      }

      if (contraband) {
         long tick = SymbioteClientState.getClientTick();
         float breathe = 0.72F + 0.16F * (float)Math.sin(tick / 14.0);
         int veil = ((int)(breathe * 255.0F) & 0xFF) << 24 | 1179658;
         g.fill(x + 1, y + 1, x + 19, y + 19, veil);
         g.fill(x, y, x + 20, y + 1, -10875366);
         g.fill(x, y + 19, x + 20, y + 20, -10875366);
         g.fill(x, y, x + 1, y + 20, -10875366);
         g.fill(x + 19, y, x + 20, y + 20, -10875366);
      }
   }

   private static int applyAlpha(int color, float alphaMul) {
      int alpha = color >> 24 & 0xFF;
      int newAlpha = Math.max(0, Math.min(255, (int)(alpha * alphaMul)));
      return newAlpha << 24 | color & 16777215;
   }

   private SymbioteHudOverlay() {
      SymbioteMod.LOGGER.debug("HUD overlay class loaded");
   }

   static {
      SymbioteStrain[] strains = SymbioteStrain.values();
      TEX_HUNGER_FRAME_S = new ResourceLocation[strains.length];
      TEX_HUNGER_FILL_S = new ResourceLocation[strains.length];
      TEX_BOND_STAGE_S = new ResourceLocation[strains.length][4];

      for (int i = 0; i < strains.length; i++) {
         String s = strains[i].getSerializedName();
         TEX_HUNGER_FRAME_S[i] = gui("hunger_bar_frame_" + s + ".png");
         TEX_HUNGER_FILL_S[i] = gui("hunger_bar_fill_" + s + ".png");

         for (int st = 0; st < 4; st++) {
            TEX_BOND_STAGE_S[i][st] = gui("bond_stage_" + st + "_" + s + ".png");
         }
      }

      TEX_PIP_SOCKET = gui("pip_socket.png");
      TEX_PIP_NODE_MOOD = gui("pip_node_mood.png");
      strains = SymbioteStrain.values();
      TEX_PIP_NODE_S = new ResourceLocation[strains.length];

      for (int i = 0; i < strains.length; i++) {
         TEX_PIP_NODE_S[i] = gui("pip_node_" + strains[i].getSerializedName() + ".png");
      }

      TEX_CONTROL_VIGNETTE = gui("control_vignette.png");
      TEX_SUBTITLE_PLATE = gui("subtitle_plate.png");
      TEX_CMD_PROTECT = gui("icon_protect.png");
      TEX_CMD_HUNT = gui("icon_hunt.png");
      TEX_CMD_HIDE = gui("icon_hide.png");
      TEX_SHANK_EMPTY = gui("sym_hunger_empty.png");
      strains = SymbioteStrain.values();
      TEX_SHANK_FULL_S = new ResourceLocation[strains.length];
      TEX_SHANK_HALF_S = new ResourceLocation[strains.length];

      for (int i = 0; i < strains.length; i++) {
         String s = strains[i].getSerializedName();
         TEX_SHANK_FULL_S[i] = gui("sym_hunger_full_" + s + ".png");
         TEX_SHANK_HALF_S[i] = gui("sym_hunger_half_" + s + ".png");
      }

      HUNGER_AND_FX = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            if (SymbioteClientState.isBonded()) {
               int strainIdx = SymbioteClientState.getStrain().ordinal();
               if (strainIdx < 0 || strainIdx >= TEX_HUNGER_FILL_S.length) {
                  strainIdx = 0;
               }

               int leftStatusLeft = sw / 2 - 91;
               int barX = leftStatusLeft + -1;
               int armorComp = Minecraft.getInstance().player != null && Minecraft.getInstance().player.getArmorValue() > 0 ? 0 : 10;
               int barY = sh - gui.leftHeight - 13 + 11 + armorComp;
               int stamina = SymbioteClientState.getStamina();
               int staminaMax = Math.max(1, SymbioteClientState.getStaminaMax());
               float sfrac = Math.max(0.0F, Math.min(1.0F, (float)stamina / staminaMax));
               boolean lowStam = sfrac < 0.2F;
               float spulse = lowStam ? 0.5F + 0.5F * (float)Math.sin(SymbioteClientState.getClientTick() / 5.0) : 1.0F;
               blitTex(g, TEX_HUNGER_FRAME_S[strainIdx], barX, barY, 84, 13, 1.0F);
               int fw = Math.round(84.0F * sfrac);
               if (fw > 0) {
                  g.blit(RenderType::guiTextured, TEX_HUNGER_FILL_S[strainIdx], barX, barY, 0.0F, 0.0F, fw, 13, 84, 13, tint(1.0F, 1.0F, 1.0F, spulse));
               }

               BondStage stage = SymbioteClientState.getStage();
               int stageIdx = stage.ordinal() - 1;
               int hunger = SymbioteClientState.getHunger();
               boolean starving = hunger <= SymbioteConfig.HUNGER_STARVE_THRESHOLD.get();
               float hpulse = starving ? 0.55F + 0.45F * (float)Math.sin(SymbioteClientState.getClientTick() / 4.0) : 1.0F;
               int rightStatusRight = sw / 2 + 91;
               int shankRowY = sh - gui.rightHeight;
               int halves = Math.round(hunger / 5.0F);

               for (int ix = 0; ix < 10; ix++) {
                  int ixx = rightStatusRight - 9 - ix * 8;
                  blitTex(g, TEX_SHANK_EMPTY, ixx, shankRowY, 9, 9, 1.0F);
                  int unitHalves = halves - ix * 2;
                  if (unitHalves >= 2) {
                     blitTex(g, TEX_SHANK_FULL_S[strainIdx], ixx, shankRowY, 9, 9, hpulse);
                  } else if (unitHalves == 1) {
                     blitTex(g, TEX_SHANK_HALF_S[strainIdx], ixx, shankRowY, 9, 9, hpulse);
                  }
               }

               renderVignette(g, "vignette_red", -65536, sw, sh);
               renderVignette(g, "vignette_black", -16777216, sw, sh);
               renderVignette(g, "fire_panic_pulse", -32768, sw, sh);
               renderVignette(g, "bond_up", -2785025, sw, sh);
               renderVignette(g, "bond_down", -12298906, sw, sh);
               renderVignette(g, "consumption", -16777216, sw, sh);
               renderVignette(g, "rejection", -5636096, sw, sh);
               renderVignette(g, "tendril_burst", -14548941, sw, sh);
               renderVignette(g, "bell_stun", -4203026, sw, sh);
               renderVignette(g, "bloom", 0xFF000000 | SymbioteClientState.getStrain().getDisplayColor(), sw, sh);
               renderVignette(g, "stage_up", 0xFF000000 | SymbioteClientState.getStrain().getDisplayColor(), sw, sh);
               renderVignette(g, "stage_down", -12958640, sw, sh);
            }
         }
      };
      ARM_SLOTS = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         Minecraft mc = Minecraft.getInstance();
         if (!mc.options.hideGui) {
            if (SymbioteClientState.isBonded()) {
               BondStage stage = SymbioteClientState.getStage();
               int slots = stage == BondStage.DOMINANT ? 5 : (stage == BondStage.COOPERATIVE ? 3 : 0);
               if (slots > 0) {
                  int hotbarLeft = sw / 2 - 91;
                  int hotbarRight = sw / 2 + 91;
                  int boxY = sh - 22;
                  boolean rightSide = mc.player == null || mc.player.getMainArm() == HumanoidArm.RIGHT;
                  int contraband = SymbioteClientState.getContrabandSlot();

                  for (int ix = 0; ix < slots; ix++) {
                     int x = rightSide ? hotbarRight + 3 + ix * 22 : hotbarLeft - 23 - ix * 22;
                     drawArmSlot(g, x, boxY, SymbioteClientState.getArmSlot(ix), false, ix == contraband);
                  }
               }
            }
         }
      };
      COMMAND_MODE = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            if (SymbioteClientState.isBonded()) {
               PlayerCommandDispatcher.CommandMode mode = SymbioteClientState.getCommandMode();
               if (mode != PlayerCommandDispatcher.CommandMode.DEFAULT) {
                  ResourceLocation icon;
                  String label;
                  int color;
                  switch (mode) {
                     case PROTECT_ME:
                        icon = TEX_CMD_PROTECT;
                        label = "Protect Me";
                        color = -7354113;
                        break;
                     case HUNT:
                        icon = TEX_CMD_HUNT;
                        label = "Hunt";
                        color = -34197;
                        break;
                     case HIDE:
                        icon = TEX_CMD_HIDE;
                        label = "Hide";
                        color = -4020000;
                        break;
                     default:
                        return;
                  }

                  Font font = Minecraft.getInstance().font;
                  int iconSz = 11;
                  int x = sw / 2 - 91;
                  int armorComp = Minecraft.getInstance().player != null && Minecraft.getInstance().player.getArmorValue() > 0 ? 0 : 10;
                  int y = sh - gui.leftHeight - 13 + 11 + armorComp - 15;
                  float pulse = 0.72F + 0.28F * (float)Math.sin(SymbioteClientState.getClientTick() / 8.0);
                  int labelW = font.width(label);
                  g.fill(x - 2, y - 2, x + iconSz + 3 + labelW + 3, y + iconSz + 2, -2013265920);
                  blitStretch(g, icon, x, y, iconSz, iconSz, 28, 28, 1.0F, 1.0F, 1.0F, pulse);
                  g.drawString(font, label, x + iconSz + 3, y + (iconSz - 9) / 2 + 1, color, true);
               }
            }
         }
      };
      MOOD_BLEED = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            if (SymbioteClientState.isBonded()) {
               ClientLevel lvl = Minecraft.getInstance().level;
               if (lvl == null || SymbioteClientState.getInstabilityUntilTick() <= lvl.getGameTime()) {
                  MoodEngine.Mood mood = SymbioteClientState.getMood();
                  int rgb;
                  double period;
                  float strength;
                  switch (mood) {
                     case ANXIOUS:
                        rgb = 2761784;
                        period = 10.0;
                        strength = 0.13F;
                        break;
                     case COILED:
                        rgb = 5574668;
                        period = 4.0;
                        strength = 0.21F;
                        break;
                     case GRIEVING:
                        rgb = 1975856;
                        period = 40.0;
                        strength = 0.14F;
                        break;
                     default:
                        return;
                  }

                  long tick = SymbioteClientState.getClientTick();
                  float rampIn = Math.min(1.0F, (float)(tick - SymbioteClientState.getLastMoodChangeTick()) / 80.0F);
                  float breathe = 0.6F + 0.4F * (float)Math.sin(tick / period);
                  float stressLift = 0.8F + 0.5F * (SymbioteClientState.getStress() / 100.0F);
                  int alpha = (int)(strength * breathe * rampIn * stressLift * 255.0F) & 0xFF;
                  if (alpha > 2) {
                     int edgeColor = alpha << 24 | rgb;
                     int thickness = (int)(sh * 0.22F);
                     g.fillGradient(0, 0, sw, thickness, edgeColor, edgeColor & 16777215);
                     g.fillGradient(0, sh - thickness, sw, sh, edgeColor & 16777215, edgeColor);
                     int sideW = (int)(sw * 0.14F);
                     g.fillGradient(0, 0, sideW, sh, edgeColor, edgeColor & 16777215);
                     g.fillGradient(sw - sideW, 0, sw, sh, edgeColor & 16777215, edgeColor);
                  }
               }
            }
         }
      };
      gripSeize = 0.0F;
      surgeLogged = false;
      CONTROL_PULSE = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            if ((Boolean)SymbioteConfig.TENDRIL_OVERLAY.get()) {
               if (SymbioteClientState.isBonded()) {
                  float dt = MantleBodyAnchor.frameDt();
                  boolean seized = SymbioteClientState.isBodySeized();
                  boolean fxCtl = OverrideFxClient.isActive("controlled");
                  boolean fxDeep = OverrideFxClient.findActiveWithPrefix("deepgrip:") != null;
                  boolean fxPrey = OverrideFxClient.findActiveWithPrefix("preylock:") != null;
                  boolean lastStand = OverrideFxClient.isActive("laststand");
                  boolean controlled = seized || fxCtl || fxDeep || fxPrey || lastStand;
                  if (controlled != surgeLogged) {
                     surgeLogged = controlled;
                     SymbioteLog.event(
                        "SURGE_STATE controlled={} seized={} fxCtl={} fxDeep={} fxPrey={} grip={}",
                        controlled,
                        seized,
                        fxCtl,
                        fxDeep,
                        fxPrey,
                        String.format("%.2f", gripSeize)
                     );
                  }

                  float target = controlled ? 1.0F : 0.0F;
                  float rate = target > gripSeize ? 9.0F : 2.2F;
                  gripSeize = gripSeize + (target - gripSeize) * (1.0F - (float)Math.exp(-rate * dt));
                  BondStage stage = SymbioteClientState.getStage();
                  double stageBase;
                  if (stage == BondStage.DOMINANT) {
                     stageBase = 0.55;
                  } else if (stage == BondStage.COOPERATIVE) {
                     stageBase = 0.28;
                  } else {
                     stageBase = 0.0;
                  }

                  if (!(stageBase <= 0.0) || !(gripSeize < 0.01F)) {
                     long tick = SymbioteClientState.getClientTick();
                     double period = 18.0 - 4.0 * gripSeize;
                     float breathe = 0.5F + 0.5F * (float)Math.sin(tick / period);
                     float stressFactor = 0.5F + SymbioteClientState.getStress() / 100.0F * 0.5F;
                     float ambient = (float)stageBase * (0.55F + 0.45F * breathe) * stressFactor;
                     float intensity = ambient * (1.0F + 0.9F * gripSeize) + gripSeize * (0.2F + 0.1F * breathe);
                     float a = Math.min(0.95F, intensity * (1.3F + 0.9F * gripSeize));
                     if (lastStand) {
                        float ra = Math.min(0.95F, 0.52F + 0.16F * breathe + intensity * 0.35F);
                        blitStretch(g, TEX_CONTROL_VIGNETTE, 0, 0, sw, sh, 320, 180, 1.0F, 0.2F, 0.16F, ra);
                     } else {
                        blitStretch(g, TEX_CONTROL_VIGNETTE, 0, 0, sw, sh, 320, 180, 1.0F, 1.0F, 1.0F, a);
                     }
                  }
               }
            }
         }
      };
      SUBTITLE = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            String line = SymbioteVoiceClient.getActiveLine();
            if (line != null) {
               String text = SymbioteVoiceClient.resolve(line);
               Font font = Minecraft.getInstance().font;
               int remaining = SymbioteVoiceClient.getRemainingTicks();
               int total = SymbioteVoiceClient.getTotalTicks();
               int fade = SymbioteVoiceClient.getFadeTicks();
               float alpha;
               if (remaining > total - fade) {
                  alpha = 1.0F - (float)(remaining - (total - fade)) / fade;
                  alpha = 1.0F - alpha;
               } else if (remaining < fade) {
                  alpha = (float)remaining / fade;
               } else {
                  alpha = 1.0F;
               }

               int speakerOrdinal = SymbioteVoiceClient.getSpeakerStrain();
               SymbioteStrain[] strainsx = SymbioteStrain.values();
               SymbioteStrain speaker = speakerOrdinal >= 0 && speakerOrdinal < strainsx.length ? strainsx[speakerOrdinal] : SymbioteClientState.getStrain();
               int strainRgb = speaker.getDisplayColor();
               int lr = strainRgb >> 16 & 0xFF;
               int lg = strainRgb >> 8 & 0xFF;
               int lb = strainRgb & 0xFF;
               lr += (255 - lr) * 35 / 100;
               lg += (255 - lg) * 35 / 100;
               lb += (255 - lb) * 35 / 100;
               int color = (int)(alpha * 255.0F) << 24 | lr << 16 | lg << 8 | lb;
               int width = font.width(text);
               int x = sw / 2 - width / 2;
               int y = sh / 2 - 40;
               int padX = 14;
               int padY = 7;
               int plateW = width + padX * 2;
               int plateH = 9 + padY * 2;
               int plateX = x - padX;
               int plateY = y - padY + 1;
               blitStretch(
                  g,
                  TEX_SUBTITLE_PLATE,
                  plateX,
                  plateY,
                  plateW,
                  plateH,
                  160,
                  28,
                  (strainRgb >> 16 & 0xFF) / 255.0F * 0.85F,
                  (strainRgb >> 8 & 0xFF) / 255.0F * 0.85F,
                  (strainRgb & 0xFF) / 255.0F * 0.85F,
                  alpha
               );
               g.drawString(font, Component.literal(text).withStyle(ChatFormatting.ITALIC), x, y, color, true);
            }
         }
      };
      BOND_PULSE = (g, deltaTracker) -> {
         Gui gui = Minecraft.getInstance().gui;
         float partialTick = deltaTracker.getGameTimeDeltaPartialTick(false);
         int sw = g.guiWidth();
         int sh = g.guiHeight();
         if (!Minecraft.getInstance().options.hideGui) {
            if (SymbioteClientState.isBonded()) {
               long now = SymbioteClientState.getClientTick();
               long since = now - SymbioteClientState.getLastBondChangeTick();
               int displayTicks = 50;
               if (since >= 0L && since < displayTicks) {
                  float frac = 1.0F - (float)since / displayTicks;
                  int dir = SymbioteClientState.getLastBondChangeDir();
                  int amount = SymbioteClientState.getLastBondChangeAmount();
                  if (dir != 0) {
                     Font font = Minecraft.getInstance().font;
                     String text = (dir > 0 ? "§a▲ Bond " : "§c▼ Bond ") + (amount > 0 ? "+" : "") + amount;
                     int alpha = (int)(frac * 255.0F) & 0xFF;
                     int color = alpha << 24 | 16777215;
                     int x = sw / 2 - font.width(text) / 2;
                     int y = sh / 2 - 60;
                     g.drawString(font, Component.literal(text), x, y, color, true);
                  }
               }
            }
         }
      };
   }
}
