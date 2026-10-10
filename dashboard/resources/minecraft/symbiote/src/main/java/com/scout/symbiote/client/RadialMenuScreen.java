package com.scout.symbiote.client;

import com.mojang.blaze3d.platform.InputConstants.Key;
import com.mojang.blaze3d.platform.InputConstants.Type;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.util.ARGB;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

public class RadialMenuScreen extends Screen {
   private static final String[] LABELS = new String[]{"Protect Me", "Hunt", "Hide"};
   private static final String[] COMMAND_IDS = new String[]{"protect_me", "hunt", "hide"};
   private static final float[] ANGLES = new float[]{-90.0F, 30.0F, 150.0F};
   private static final ResourceLocation TEX_WEB = gui("radial_web.png");
   private static final ResourceLocation TEX_NODE = gui("radial_node.png");
   private static final ResourceLocation[] TEX_ICONS = new ResourceLocation[]{gui("icon_protect.png"), gui("icon_hunt.png"), gui("icon_hide.png")};
   private static final int WEB = 140;
   private static final int NODE = 36;
   private static final int ICON = 28;
   private static final int NODE_RADIUS = 50;
   private int hovered = -1;
   private boolean statusHovered = false;
   private boolean graftHovered = false;

   private static ResourceLocation gui(String f) {
      return ResourceLocation.fromNamespaceAndPath("symbiote", "textures/gui/" + f);
   }

   public RadialMenuScreen() {
      super(Component.literal("Symbiote Radial"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(0, 0, this.width, this.height, 1711276032);
      int cx = this.width / 2;
      int cy = this.height / 2;
      float dx = mouseX - cx;
      float dy = mouseY - cy;
      float distSq = dx * dx + dy * dy;
      float angleDeg = (float)Math.toDegrees(Math.atan2(dy, dx));
      if (angleDeg > 180.0F) {
         angleDeg -= 360.0F;
      }

      if (angleDeg < -180.0F) {
         angleDeg += 360.0F;
      }

      boolean grafted = SymbioteClientState.isGrafted();
      int statusX = grafted ? cx - 24 : cx;
      int statusY = cy + 70 + 22;
      int graftX = cx + 24;
      this.statusHovered = Math.abs(mouseX - statusX) <= 18 && Math.abs(mouseY - statusY) <= 18;
      this.graftHovered = grafted && Math.abs(mouseX - graftX) <= 18 && Math.abs(mouseY - statusY) <= 18;
      boolean integrating = integrating();
      this.hovered = -1;
      if (!integrating && !this.statusHovered && !this.graftHovered && distSq > 625.0F) {
         float best = 9999.0F;

         for (int i = 0; i < ANGLES.length; i++) {
            float diff = Math.abs(angularDiff(angleDeg, ANGLES[i]));
            if (diff < best) {
               best = diff;
               this.hovered = i;
            }
         }

         if (best > 60.0F) {
            this.hovered = -1;
         }

         if (mouseY > cy + 70) {
            this.hovered = -1;
         }
      }

      PlayerCommandDispatcher.CommandMode activeMode = SymbioteClientState.getCommandMode();

      int activeIndex = switch (activeMode) {
         case PROTECT_ME -> 0;
         case HUNT -> 1;
         case HIDE -> 2;
         default -> -1;
      };
      int tint = tint(1.0F, 1.0F, 1.0F, 1.0F);
      g.blit(RenderType::guiTextured, TEX_WEB, cx - 70, cy - 70, 0.0F, 0.0F, 140, 140, 140, 140, tint);
      float pulse = 0.6F + 0.4F * (float)Math.sin(System.currentTimeMillis() / 180.0);
      int coreAlpha = (int)(pulse * 255.0F) & 0xFF;
      g.fill(cx - 3, cy - 3, cx + 3, cy + 3, coreAlpha << 24 | 13992191);
      g.fill(cx - 1, cy - 1, cx + 1, cy + 1, -1);
      float greenPulse = 0.6F + 0.4F * (float)Math.sin(System.currentTimeMillis() / 200.0);

      for (int i = 0; i < ANGLES.length; i++) {
         float rad = (float)Math.toRadians(ANGLES[i]);
         int nx = cx + (int)(Math.cos(rad) * 50.0);
         int ny = cy + (int)(Math.sin(rad) * 50.0);
         boolean hot = i == this.hovered;
         boolean active = i == activeIndex;
         if (integrating) {
            tint = tint(0.3F, 0.28F, 0.33F, 1.0F);
         } else if (hot) {
            tint = tint(1.0F, 1.0F, 1.0F, 1.0F);
         } else if (active) {
            tint = tint(0.35F, greenPulse, 0.5F, 1.0F);
         } else {
            tint = tint(0.7F, 0.7F, 0.78F, 1.0F);
         }

         g.blit(RenderType::guiTextured, TEX_NODE, nx - 18, ny - 18, 0.0F, 0.0F, 36, 36, 36, 36, tint);
         tint = tint(1.0F, 1.0F, 1.0F, integrating ? 0.35F : (hot ? 1.0F : 0.85F));
         g.blit(RenderType::guiTextured, TEX_ICONS[i], nx - 14, ny - 14, 0.0F, 0.0F, 28, 28, 28, 28, tint);
         tint = tint(1.0F, 1.0F, 1.0F, 1.0F);
         String label = active && hot ? "Stand Down" : LABELS[i];
         int textColor = integrating ? -10857120 : (active ? -7347320 : (hot ? -1 : -5205824));
         int strW = this.font.width(label);
         g.drawString(this.font, label, nx - strW / 2, ny + 18 + 2, textColor, true);
      }

      if (activeIndex >= 0) {
         String hint = "Re-select the lit command to stand down";
         int hw = this.font.width(hint);
         g.drawString(this.font, hint, cx - hw / 2, cy + 70 + 4, -7823200, true);
      }

      tint = tint(this.statusHovered ? 1.0F : 0.6F, this.statusHovered ? 1.0F : 0.6F, this.statusHovered ? 1.0F : 0.68F, 1.0F);
      g.blit(RenderType::guiTextured, TEX_NODE, statusX - 18, statusY - 18, 0.0F, 0.0F, 36, 36, 36, 36, tint);
      tint = tint(1.0F, 1.0F, 1.0F, 1.0F);
      String glyph = "◉";
      g.drawString(this.font, glyph, statusX - this.font.width(glyph) / 2, statusY - 4, this.statusHovered ? -1 : -4151088, true);
      String statusLabel = Component.translatable("screen.symbiote.status").getString();
      g.drawString(this.font, statusLabel, statusX - this.font.width(statusLabel) / 2, statusY + 18 + 2, this.statusHovered ? -1 : -5205824, true);
      if (SymbioteClientState.isGrafted()) {
         int gc = SymbioteClientState.getGraftStrain().getDisplayColor();
         float gr = (gc >> 16 & 0xFF) / 255.0F;
         float gg = (gc >> 8 & 0xFF) / 255.0F;
         float gb = (gc & 0xFF) / 255.0F;
         float lit = this.graftHovered ? 1.0F : 0.65F;
         tint = tint(gr * lit + (this.graftHovered ? 0.2F : 0.0F), gg * lit, gb * lit, 1.0F);
         g.blit(RenderType::guiTextured, TEX_NODE, graftX - 18, statusY - 18, 0.0F, 0.0F, 36, 36, 36, 36, tint);
         tint = tint(1.0F, 1.0F, 1.0F, 1.0F);
         String gGlyph = "✦";
         g.drawString(this.font, gGlyph, graftX - this.font.width(gGlyph) / 2, statusY - 4, this.graftHovered ? -1 : -3096352, true);
         String gLabel = "Graft";
         g.drawString(this.font, gLabel, graftX - this.font.width(gLabel) / 2, statusY + 18 + 2, this.graftHovered ? -1 : -5205824, true);
      }

      super.render(g, mouseX, mouseY, partialTick);
   }

   private static boolean integrating() {
      Minecraft mc = Minecraft.getInstance();
      return mc.level != null && SymbioteClientState.getInstabilityUntilTick() > mc.level.getGameTime();
   }

   public void onClose() {
      super.onClose();
      if (this.hovered >= 0 && this.hovered < COMMAND_IDS.length && !integrating()) {
         SymbioteKeybindHandler.sendCommandPacket(COMMAND_IDS[this.hovered]);
      } else if (this.statusHovered) {
         Minecraft.getInstance().setScreen(new SymbioteStatusScreen());
      } else if (this.graftHovered) {
         Minecraft.getInstance().setScreen(new GraftStatusScreen());
      }
   }

   public boolean mouseClicked(double mouseX, double mouseY, int button) {
      if (this.statusHovered) {
         Minecraft.getInstance().setScreen(new SymbioteStatusScreen());
         return true;
      } else if (this.graftHovered) {
         Minecraft.getInstance().setScreen(new GraftStatusScreen());
         return true;
      } else if (this.hovered >= 0 && this.hovered < COMMAND_IDS.length && !integrating()) {
         SymbioteKeybindHandler.sendCommandPacket(COMMAND_IDS[this.hovered]);
         Minecraft.getInstance().setScreen(null);
         return true;
      } else {
         return super.mouseClicked(mouseX, mouseY, button);
      }
   }

   public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
      Key bound = SymbioteKeybinds.RADIAL_MENU.getKey();
      if (bound.getType() == Type.KEYSYM && bound.getValue() == keyCode) {
         this.hovered = -1;
         Minecraft.getInstance().setScreen(null);
         return true;
      } else {
         return super.keyPressed(keyCode, scanCode, modifiers);
      }
   }

   private static float angularDiff(float a, float b) {
      float diff = (a - b) % 360.0F;
      if (diff > 180.0F) {
         diff -= 360.0F;
      }

      if (diff < -180.0F) {
         diff += 360.0F;
      }

      return diff;
   }

   /** 1.21.4 GuiGraphics has no setColor; the tint travels with each blit as an ARGB color, clamped per channel. */
   private static int tint(float r, float g, float b, float a) {
      return ARGB.colorFromFloat(clamp(a), clamp(r), clamp(g), clamp(b));
   }

   private static float clamp(float v) {
      return Math.max(0.0F, Math.min(1.0F, v));
   }
}
