package com.scout.symbiote.client;

import com.scout.symbiote.client.screen.ArmorSkinButton;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteStrain;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;

public class SymbioteStatusScreen extends Screen {
   private static final int PANEL_W = 240;
   private static final int ROW_H = 15;
   private static final int[] STRAIN_COLORS = new int[]{-2078648, -11552600, -6530856, -13122376, -2580424};

   public SymbioteStatusScreen() {
      super(Component.translatable("screen.symbiote.status"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   protected void init() {
      super.init();
      if (SymbioteClientState.getStage().isAtLeast(BondStage.INTEGRATED) || SymbioteClientState.isLivingArmorActive()) {
         int left = (this.width - 240) / 2;
         int top = (this.height - this.panelHeight()) / 2;
         this.addRenderableWidget(new ArmorSkinButton(left + 240 - 26, top + 6));
      }
   }

   private int panelHeight() {
      List<FormattedCharSequence> blurb = this.font
         .split(Component.translatable("symbiote.status.blurb." + SymbioteClientState.getStrain().name().toLowerCase()), 220);
      int h = 142 + blurb.size() * 10 + 12 + 24;
      if (SymbioteClientState.isGrafted()) {
         h += 27;
      }

      return h;
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(0, 0, this.width, this.height, -2013265920);
      SymbioteStrain strain = SymbioteClientState.getStrain();
      BondStage stage = SymbioteClientState.getStage();
      int si = Math.min(strain.ordinal(), STRAIN_COLORS.length - 1);
      int accent = STRAIN_COLORS[si];
      List<FormattedCharSequence> blurb = this.font.split(Component.translatable("symbiote.status.blurb." + strain.name().toLowerCase()), 220);
      int panelH = this.panelHeight();
      int left = (this.width - 240) / 2;
      int top = (this.height - panelH) / 2;
      g.fill(left - 2, top - 2, left + 240 + 2, top + panelH + 2, -535557608);
      g.fill(left - 2, top - 2, left + 240 + 2, top - 1, accent);
      g.fill(left - 2, top + panelH + 1, left + 240 + 2, top + panelH + 2, accent);
      int y = top + 8;
      String title = Component.translatable("screen.symbiote.status").getString() + ": " + pretty(strain.name());
      g.drawString(this.font, title, left + 10, y, accent, true);
      y += 14;
      int bond = SymbioteClientState.getBond();
      String stageLine;
      float stageFrac;
      switch (stage) {
         case ATTACHED:
            int next = (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get();
            stageFrac = frac(bond, 0, next);
            stageLine = pretty(stage.name()) + "  →  " + pretty(BondStage.INTEGRATED.name());
            break;
         case INTEGRATED:
            stageFrac = frac(bond, (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get(), (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get());
            stageLine = pretty(stage.name()) + "  →  " + pretty(BondStage.COOPERATIVE.name());
            break;
         case COOPERATIVE:
            stageFrac = frac(bond, (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get(), (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get());
            stageLine = pretty(stage.name()) + "  →  " + pretty(BondStage.DOMINANT.name());
            break;
         default:
            stageFrac = 1.0F;
            stageLine = pretty(stage.name());
      }

      String curName = pretty(stage.name());
      int curW = this.font.width(curName);
      g.renderOutline(left + 10, y - 3, curW + 7, 14, accent);
      g.drawString(this.font, curName, left + 13, y, -1, true);
      if (stageLine.length() > curName.length()) {
         g.drawString(this.font, stageLine.substring(curName.length()), left + 13 + curW, y, -6516820, true);
      }

      y += 11;
      drawBar(g, left + 10, y, 220, 4, stageFrac, accent);
      y += 10;
      int rapport = SymbioteClientState.getTrust() - SymbioteClientState.getStress();
      String rapportWord = rapport >= 20 ? "Warm" : (rapport <= -10 ? "Sour" : "Wary");
      int rapportColor = rapport >= 20 ? -8664709 : (rapport <= -10 ? -3454390 : -3622800);
      MoodEngine.Mood mood = SymbioteClientState.getMood();

      String moodWord = switch (mood) {
         case CONTENT -> "Content";
         case ANXIOUS -> "Anxious";
         case COILED -> "Coiled";
         case GRIEVING -> "Grieving";
      };

      int moodColor = switch (mood) {
         case CONTENT -> -8664709;
         case ANXIOUS -> -3622800;
         case COILED -> -2074536;
         case GRIEVING -> -7827288;
      };
      g.drawString(this.font, "Rapport " + rapport + " (" + rapportWord + ")", left + 10, y, rapportColor, false);
      String moodLabel = "Mood: " + moodWord;
      g.drawString(this.font, moodLabel, left + 240 - 10 - this.font.width(moodLabel), y, moodColor, false);
      y += 12;
      MoodEngine.Temperament temperament = SymbioteClientState.getTemperament();
      String verdict = stage == BondStage.DOMINANT && temperament != MoodEngine.Temperament.NONE ? "The " + pretty(temperament.name()) : "Depth only deepens";
      g.drawString(this.font, verdict, left + 10, y, -6516568, false);
      y += 12;
      y = this.meter(g, left, y, "symbiote.status.bond", bond, SymbioteConfig.BOND_MAX.get(), accent);
      y = this.meter(g, left, y, "symbiote.status.trust", SymbioteClientState.getTrust(), 100, -8664709);
      y = this.meter(g, left, y, "symbiote.status.stress", SymbioteClientState.getStress(), 100, -3454390);
      y = this.meter(g, left, y, "symbiote.status.hunger", SymbioteClientState.getHunger(), 100, -3241412);
      y = this.meter(g, left, y, "symbiote.status.stamina", SymbioteClientState.getStamina(), Math.max(1, SymbioteClientState.getStaminaMax()), -7686952);
      y = this.meter(g, left, y, "symbiote.status.armor", SymbioteClientState.getLivingArmorStamina(), SymbioteConfig.LIVING_ARMOR_STAMINA_MAX.get(), -4671288);
      if (SymbioteClientState.isGrafted()) {
         int tension = SymbioteClientState.getGraftTension();
         y = this.meter(g, left, y, "symbiote.status.tension", tension, 100, tension >= 70 ? -2074536 : (tension >= 40 ? -3622800 : -8664709));
         g.drawString(this.font, "Something else is living in your hand.", left + 10, y, -3628840, false);
         y += 12;
      }

      long gameTime = Minecraft.getInstance().level != null ? Minecraft.getInstance().level.getGameTime() : 0L;
      StringBuilder states = new StringBuilder();
      if (SymbioteClientState.getDormantUntilTick() > gameTime) {
         states.append("DORMANT ").append(mmss(SymbioteClientState.getDormantUntilTick() - gameTime)).append("  ");
      }

      if (SymbioteClientState.getInstabilityUntilTick() > gameTime) {
         states.append("INTEGRATING ").append(mmss(SymbioteClientState.getInstabilityUntilTick() - gameTime)).append("  ");
      }

      if (SymbioteClientState.isLivingArmorActive()) {
         states.append("ARMOR ON");
      }

      if (states.length() > 0) {
         g.drawString(this.font, states.toString().trim(), left + 10, y + 2, -3628840, true);
      }

      y += 16;

      for (FormattedCharSequence line : blurb) {
         g.drawString(this.font, line, left + 10, y, -6516568, false);
         y += 10;
      }

      super.render(g, mouseX, mouseY, partialTick);
   }

   private int meter(GuiGraphics g, int left, int y, String key, int value, int max, int color) {
      String label = Component.translatable(key).getString();
      g.drawString(this.font, label, left + 10, y, -4675384, false);
      String num = value + " / " + max;
      int numX = left + 240 - 10 - this.font.width(num);
      g.drawString(this.font, num, numX, y, -1516304, false);
      drawBar(g, left + 78, y + 2, numX - 4 - (left + 78), 5, frac(value, 0, max), color);
      return y + 15;
   }

   private static void drawBar(GuiGraphics g, int x, int y, int w, int h, float frac, int color) {
      g.fill(x, y, x + w, y + h, -14016461);
      int fw = Math.round(w * Math.max(0.0F, Math.min(1.0F, frac)));
      if (fw > 0) {
         g.fill(x, y, x + fw, y + h, color);
      }
   }

   private static float frac(int v, int lo, int hi) {
      return hi <= lo ? 1.0F : (float)(v - lo) / (hi - lo);
   }

   private static String pretty(String enumName) {
      return enumName.charAt(0) + enumName.substring(1).toLowerCase();
   }

   private static String mmss(long ticks) {
      long totalSec = Math.max(0L, ticks) / 20L;
      return totalSec / 60L + ":" + String.format("%02d", totalSec % 60L);
   }
}
