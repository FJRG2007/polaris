package com.scout.symbiote.client.screen;

import net.minecraft.client.renderer.RenderType;
import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.network.ModNetwork;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

public final class ArmorSkinButton extends AbstractButton {
   private static final int PANEL_RIM = -12972470;
   private static final int WELL = -14413776;
   private static final int RIM_HOVER = -8768592;
   private boolean tooltipCovers = coversNow();

   public ArmorSkinButton(int x, int y) {
      super(x, y, 17, 17, Component.empty());
      this.refreshTooltip();
   }

   private static boolean coversNow() {
      Minecraft mc = Minecraft.getInstance();
      return mc.player != null && ArmorStateClientCache.coversGear(mc.player.getUUID());
   }

   public void onPress() {
      ModNetwork.sendArmorSkinToggle();
   }

   private void refreshTooltip() {
      this.setTooltip(Tooltip.create(Component.literal(coversNow() ? "Shell covers gear" : "Gear over shell")));
   }

   protected void updateWidgetNarration(NarrationElementOutput out) {
      this.defaultButtonNarrationText(out);
   }

   protected void renderWidget(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      if (this.tooltipCovers != coversNow()) {
         this.tooltipCovers = coversNow();
         this.refreshTooltip();
      }

      g.fill(this.getX() - 1, this.getY() - 1, this.getX() + 18, this.getY() + 18, this.isHoveredOrFocused() ? -8768592 : -12972470);
      g.fill(this.getX(), this.getY(), this.getX() + 17, this.getY() + 17, -14413776);
      ResourceLocation icon = ResourceLocation.withDefaultNamespace(coversNow() ? "hud/armor_empty" : "hud/armor_full");
      g.blitSprite(RenderType::guiTextured, icon, this.getX() + 4, this.getY() + 4, 9, 9);
   }
}
