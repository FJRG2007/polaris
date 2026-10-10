package com.scout.symbiote.client.screen;

import com.scout.symbiote.menu.ArmSlotsMenu;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.Slot;

public class ArmSlotsScreen extends AbstractContainerScreen<ArmSlotsMenu> {
   private static final int PANEL_BG = -267124712;
   private static final int PANEL_RIM = -12972470;
   private static final int WELL = -14413776;
   private static final int ARM_RIM_OPEN = -8768592;
   private static final int ARM_RIM_LOCK = -10870238;
   private static final int ARM_WELL_OPEN = -15005144;
   private static final int ARM_WELL_LOCK = -14677494;

   public ArmSlotsScreen(ArmSlotsMenu menu, Inventory inv, Component title) {
      super(menu, inv, title);
      this.imageWidth = 176;
      this.imageHeight = 133;
      this.inventoryLabelY = this.imageHeight - 94;
      this.titleLabelY = 7;
   }

   protected void renderBg(GuiGraphics g, float partialTick, int mouseX, int mouseY) {
      int x = this.leftPos;
      int y = this.topPos;
      g.fill(x, y, x + this.imageWidth, y + this.imageHeight, -267124712);
      g.fill(x, y, x + this.imageWidth, y + 1, -12972470);
      g.fill(x, y + this.imageHeight - 1, x + this.imageWidth, y + this.imageHeight, -12972470);
      g.fill(x, y, x + 1, y + this.imageHeight, -12972470);
      g.fill(x + this.imageWidth - 1, y, x + this.imageWidth, y + this.imageHeight, -12972470);

      for (Slot s : ((ArmSlotsMenu)this.menu).slots) {
         int sx = x + s.x;
         int sy = y + s.y;
         g.fill(sx - 1, sy - 1, sx + 17, sy + 17, -14413776);
      }

      for (int i = 0; i < 5; i++) {
         Slot s = (Slot)((ArmSlotsMenu)this.menu).slots.get(i);
         int sx = x + s.x;
         int sy = y + s.y;
         boolean open = ((ArmSlotsMenu)this.menu).slotUnlocked(i);
         g.fill(sx - 2, sy - 2, sx + 18, sy + 18, open ? -8768592 : -10870238);
         g.fill(sx - 1, sy - 1, sx + 17, sy + 17, open ? -15005144 : -14677494);
      }
   }

   protected void renderLabels(GuiGraphics g, int mouseX, int mouseY) {
      g.drawString(this.font, this.title, this.titleLabelX, this.titleLabelY, -1652481, false);
      g.drawString(this.font, this.playerInventoryTitle, this.inventoryLabelX, this.inventoryLabelY, -4741436, false);
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      this.renderTooltip(g, mouseX, mouseY);
   }
}
