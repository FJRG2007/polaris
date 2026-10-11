package com.scout.symbiote.client;

import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

public class GraftStatusScreen extends Screen {
   private static final int PANEL_W = 240;
   private static final int ROW_H = 15;
   private static final int PANEL_H = 92;
   private static final int[] STRAIN_COLORS = new int[]{-2078648, -11552600, -6530856, -13122376, -2580424};

   public GraftStatusScreen() {
      super(Component.literal("Graft"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   /** An overlay on the live game: its own dim and panel, drawn first and never blurred, so the text stays crisp. */
   public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(0, 0, this.width, this.height, -2013265920);
      if (SymbioteClientState.isGrafted()) {
         int accent = accent();
         int left = (this.width - 240) / 2;
         int top = this.panelTop();
         g.fill(left - 2, top - 2, left + 240 + 2, top + 92 + 2, -535557608);
         g.fill(left - 2, top - 2, left + 240 + 2, top - 1, accent);
         g.fill(left - 2, top + 92 + 1, left + 240 + 2, top + 92 + 2, accent);
      }
   }

   private int panelTop() {
      return Math.max(4, (this.height - 92) / 2);
   }

   private static int accent() {
      return STRAIN_COLORS[Math.min(SymbioteClientState.getGraftStrain().ordinal(), STRAIN_COLORS.length - 1)];
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      if (!SymbioteClientState.isGrafted()) {
         String none = "Nothing is riding along.";
         g.drawString(this.font, none, (this.width - this.font.width(none)) / 2, this.height / 2, -6516568, true);
      } else {
         SymbioteStrain strain = SymbioteClientState.getGraftStrain();
         int accent = accent();
         int tension = SymbioteClientState.getGraftTension();
         int left = (this.width - 240) / 2;
         int top = this.panelTop();
         int y = top + 8;
         String title = "The Graft  ·  " + pretty(strain.name());
         g.drawString(this.font, title, left + 10, y, accent, true);
         y += 12;
         g.drawString(this.font, "A fragment in your hand. Not a bond.", left + 10, y, -6516568, false);
         y += 14;
         y = this.meter(g, left, y, "Its hunger", SymbioteClientState.getGraftHunger(), 100, -3241412);
         y = this.meter(g, left, y, "Tension", tension, 100, tension >= 70 ? -2074536 : (tension >= 40 ? -3622800 : -8664709));
         y += 4;
         String verdict = tension >= 85
            ? "They are about to settle this."
            : (tension >= 60 ? "Your symbiote is done being patient." : (tension >= 30 ? "They tolerate each other. Barely." : "An uneasy quiet."));
         g.drawString(this.font, verdict, left + 10, y, -3628840, false);
      }
   }

   private int meter(GuiGraphics g, int left, int y, String label, int value, int max, int color) {
      g.drawString(this.font, label, left + 10, y, -4675384, false);
      String num = value + " / " + max;
      int numX = left + 240 - 10 - this.font.width(num);
      g.drawString(this.font, num, numX, y, -1516304, false);
      int barX = left + 78;
      int w = numX - 4 - barX;
      g.fill(barX, y + 2, barX + w, y + 7, -14016461);
      int fw = Math.round(w * Math.max(0.0F, Math.min(1.0F, (float)value / max)));
      if (fw > 0) {
         g.fill(barX, y + 2, barX + fw, y + 7, color);
      }

      return y + 15;
   }

   private static String pretty(String enumName) {
      return enumName.charAt(0) + enumName.substring(1).toLowerCase();
   }
}
