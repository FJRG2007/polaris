package com.scout.symbiote.client;

import com.scout.symbiote.client.entity.TendrilFxRenderer;
import com.scout.symbiote.client.render.VanillaSheen;
import com.scout.symbiote.network.ModNetwork;
import java.util.function.Consumer;
import java.util.function.Supplier;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

public class MantleTuneScreen extends Screen {
   public static boolean physicsPage = false;
   private final MantleTuneScreen.Param[] physicsParams = new MantleTuneScreen.Param[]{
      new MantleTuneScreen.Param(
         "LAND", "muscle (shape)", () -> TendrilFxRenderer.MANTLE_CHAIN_SHAPE, v -> TendrilFxRenderer.MANTLE_CHAIN_SHAPE = Math.max(0.5F, v), 2.0F
      ),
      new MantleTuneScreen.Param(
         "LAND",
         "glide (keep)",
         () -> TendrilFxRenderer.MANTLE_CHAIN_KEEP,
         v -> TendrilFxRenderer.MANTLE_CHAIN_KEEP = Math.min(0.98F, Math.max(0.05F, v)),
         0.03F
      ),
      new MantleTuneScreen.Param(
         "LAND", "brace", () -> TendrilFxRenderer.MANTLE_CHAIN_BRACE, v -> TendrilFxRenderer.MANTLE_CHAIN_BRACE = Math.min(1.0F, Math.max(0.0F, v)), 0.02F
      ),
      new MantleTuneScreen.Param(
         "LAND", "bend hold", () -> TendrilFxRenderer.MANTLE_CHAIN_BEND, v -> TendrilFxRenderer.MANTLE_CHAIN_BEND = Math.min(1.0F, Math.max(0.0F, v)), 0.05F
      ),
      new MantleTuneScreen.Param(
         "LAND", "wave", () -> TendrilFxRenderer.MANTLE_CHAIN_WAVE, v -> TendrilFxRenderer.MANTLE_CHAIN_WAVE = Math.min(0.9F, Math.max(0.0F, v)), 0.03F
      ),
      new MantleTuneScreen.Param(
         "LAND",
         "latch kick",
         () -> TendrilFxRenderer.MANTLE_CHAIN_LATCH_KICK,
         v -> TendrilFxRenderer.MANTLE_CHAIN_LATCH_KICK = Math.min(2.0F, Math.max(0.0F, v)),
         0.05F
      ),
      new MantleTuneScreen.Param(
         "LAND",
         "wrap wind s",
         () -> TendrilFxRenderer.MANTLE_CHAIN_WRAP_WIND,
         v -> TendrilFxRenderer.MANTLE_CHAIN_WRAP_WIND = Math.min(2.0F, Math.max(0.05F, v)),
         0.05F
      ),
      new MantleTuneScreen.Param(
         "WATER", "muscle (shape)", () -> TendrilFxRenderer.MANTLE_CHAIN_SHAPE_WATER, v -> TendrilFxRenderer.MANTLE_CHAIN_SHAPE_WATER = Math.max(0.2F, v), 0.5F
      ),
      new MantleTuneScreen.Param(
         "WATER",
         "glide (keep)",
         () -> TendrilFxRenderer.MANTLE_CHAIN_KEEP_WATER,
         v -> TendrilFxRenderer.MANTLE_CHAIN_KEEP_WATER = Math.min(0.98F, Math.max(0.05F, v)),
         0.02F
      ),
      new MantleTuneScreen.Param(
         "WATER",
         "brace",
         () -> TendrilFxRenderer.MANTLE_CHAIN_BRACE_WATER,
         v -> TendrilFxRenderer.MANTLE_CHAIN_BRACE_WATER = Math.min(1.0F, Math.max(0.0F, v)),
         0.03F
      ),
      new MantleTuneScreen.Param(
         "WATER",
         "bend hold",
         () -> TendrilFxRenderer.MANTLE_CHAIN_BEND_WATER,
         v -> TendrilFxRenderer.MANTLE_CHAIN_BEND_WATER = Math.min(1.0F, Math.max(0.0F, v)),
         0.03F
      ),
      new MantleTuneScreen.Param(
         "WATER",
         "wave",
         () -> TendrilFxRenderer.MANTLE_CHAIN_WAVE_WATER,
         v -> TendrilFxRenderer.MANTLE_CHAIN_WAVE_WATER = Math.min(0.9F, Math.max(0.0F, v)),
         0.03F
      ),
      new MantleTuneScreen.Param(
         "WATER", "stream pull", () -> TendrilFxRenderer.MANTLE_STREAM, v -> TendrilFxRenderer.MANTLE_STREAM = Math.min(1.0F, Math.max(0.0F, v)), 0.05F
      ),
      new MantleTuneScreen.Param(
         "WATER", "drag (resist)", () -> TendrilFxRenderer.MANTLE_WATER_RESIST, v -> TendrilFxRenderer.MANTLE_WATER_RESIST = Math.max(0.5F, v), 0.15F
      ),
      new MantleTuneScreen.Param(
         "EXERT", "muscle at max", () -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_SHAPE, v -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_SHAPE = Math.max(0.5F, v), 1.0F
      ),
      new MantleTuneScreen.Param(
         "EXERT",
         "brace at max",
         () -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_BRACE,
         v -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_BRACE = Math.min(1.0F, Math.max(0.0F, v)),
         0.02F
      ),
      new MantleTuneScreen.Param(
         "EXERT", "starts at spd", () -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_MIN, v -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_MIN = Math.max(0.0F, v), 0.2F
      ),
      new MantleTuneScreen.Param(
         "EXERT", "full at +spd", () -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_SPAN, v -> TendrilFxRenderer.MANTLE_CHAIN_EXERT_SPAN = Math.max(0.5F, v), 0.3F
      ),
      new MantleTuneScreen.Param(
         "REACH", "base claim", () -> TendrilFxRenderer.MANTLE_REACH_BASE, v -> TendrilFxRenderer.MANTLE_REACH_BASE = Math.min(1.0F, Math.max(0.0F, v)), 0.04F
      ),
      new MantleTuneScreen.Param(
         "REACH", "mid claim", () -> TendrilFxRenderer.MANTLE_REACH_MID, v -> TendrilFxRenderer.MANTLE_REACH_MID = Math.min(1.0F, Math.max(0.0F, v)), 0.04F
      ),
      new MantleTuneScreen.Param(
         "GLINT", "glint power", () -> VanillaSheen.GLINT_STRENGTH, v -> VanillaSheen.GLINT_STRENGTH = Math.min(2.0F, Math.max(0.0F, v)), 0.05F
      ),
      new MantleTuneScreen.Param("GLINT", "glint focus", () -> VanillaSheen.GLINT_EXP, v -> VanillaSheen.GLINT_EXP = Math.max(4.0F, v), 2.0F),
      new MantleTuneScreen.Param(
         "GLINT", "glint chaos", () -> VanillaSheen.GLINT_CHAOS, v -> VanillaSheen.GLINT_CHAOS = Math.min(1.0F, Math.max(0.0F, v)), 0.05F
      )
   };
   private final MantleTuneScreen.Param[] params = new MantleTuneScreen.Param[]{
      new MantleTuneScreen.Param("ROOT", "back", () -> TendrilFxRenderer.MANTLE_ROOT_BACK, v -> TendrilFxRenderer.MANTLE_ROOT_BACK = v, 0.04F),
      new MantleTuneScreen.Param(
         "ROOT", "back spread", () -> TendrilFxRenderer.MANTLE_ROOT_BACK_SPREAD, v -> TendrilFxRenderer.MANTLE_ROOT_BACK_SPREAD = v, 0.03F
      ),
      new MantleTuneScreen.Param("ROOT", "side", () -> TendrilFxRenderer.MANTLE_ROOT_SIDE, v -> TendrilFxRenderer.MANTLE_ROOT_SIDE = v, 0.04F),
      new MantleTuneScreen.Param("ROOT", "height", () -> TendrilFxRenderer.MANTLE_ROOT_HEIGHT, v -> TendrilFxRenderer.MANTLE_ROOT_HEIGHT = v, 0.05F),
      new MantleTuneScreen.Param(
         "ROOT", "centre lift", () -> TendrilFxRenderer.MANTLE_ROOT_HEIGHT_CENTER, v -> TendrilFxRenderer.MANTLE_ROOT_HEIGHT_CENTER = v, 0.04F
      ),
      new MantleTuneScreen.Param("ARC", "bow back", () -> TendrilFxRenderer.MANTLE_ARC_BACK, v -> TendrilFxRenderer.MANTLE_ARC_BACK = v, 0.05F),
      new MantleTuneScreen.Param("ARC", "bow spread", () -> TendrilFxRenderer.MANTLE_ARC_BACK_SPREAD, v -> TendrilFxRenderer.MANTLE_ARC_BACK_SPREAD = v, 0.04F),
      new MantleTuneScreen.Param("ARC", "bow lift", () -> TendrilFxRenderer.MANTLE_ARC_LIFT, v -> TendrilFxRenderer.MANTLE_ARC_LIFT = v, 0.05F),
      new MantleTuneScreen.Param("ARC", "lift centre", () -> TendrilFxRenderer.MANTLE_ARC_LIFT_CENTER, v -> TendrilFxRenderer.MANTLE_ARC_LIFT_CENTER = v, 0.04F),
      new MantleTuneScreen.Param("ARC", "ease back", () -> TendrilFxRenderer.MANTLE_ARC2_BACK, v -> TendrilFxRenderer.MANTLE_ARC2_BACK = v, 0.04F),
      new MantleTuneScreen.Param("ARC", "ease lift", () -> TendrilFxRenderer.MANTLE_ARC2_LIFT, v -> TendrilFxRenderer.MANTLE_ARC2_LIFT = v, 0.04F),
      new MantleTuneScreen.Param("TIP", "side", () -> TendrilFxRenderer.MANTLE_SIDE, v -> TendrilFxRenderer.MANTLE_SIDE = v, 0.05F),
      new MantleTuneScreen.Param("TIP", "back", () -> TendrilFxRenderer.MANTLE_BACK, v -> TendrilFxRenderer.MANTLE_BACK = v, 0.05F),
      new MantleTuneScreen.Param("TIP", "back spread", () -> TendrilFxRenderer.MANTLE_BACK_SPREAD, v -> TendrilFxRenderer.MANTLE_BACK_SPREAD = v, 0.04F),
      new MantleTuneScreen.Param("TIP", "height", () -> TendrilFxRenderer.MANTLE_HEIGHT, v -> TendrilFxRenderer.MANTLE_HEIGHT = v, 0.06F),
      new MantleTuneScreen.Param("TIP", "centre lift", () -> TendrilFxRenderer.MANTLE_HEIGHT_CENTER, v -> TendrilFxRenderer.MANTLE_HEIGHT_CENTER = v, 0.06F),
      new MantleTuneScreen.Param("MOTION", "sway", () -> TendrilFxRenderer.MANTLE_SWAY, v -> TendrilFxRenderer.MANTLE_SWAY = Math.max(0.0F, v), 0.2F),
      new MantleTuneScreen.Param("MOTION", "bounce", () -> TendrilFxRenderer.MANTLE_BOUNCE, v -> TendrilFxRenderer.MANTLE_BOUNCE = Math.max(0.0F, v), 0.2F),
      new MantleTuneScreen.Param(
         "MOTION", "damping", () -> TendrilFxRenderer.MANTLE_DAMP, v -> TendrilFxRenderer.MANTLE_DAMP = Math.min(1.0F, Math.max(0.02F, v)), 0.02F
      )
   };
   private static final int PANEL_X = 6;
   private static final int PANEL_Y = 22;
   private static final int ROW_H = 15;
   private static final int LABEL_W = 92;
   private static final int BTN_W = 20;

   private MantleTuneScreen.Param[] activeParams() {
      return physicsPage ? this.physicsParams : this.params;
   }

   protected void init() {
      ModNetwork.sendGraft("mantle", "");
      this.buildWidgets();
   }

   public MantleTuneScreen() {
      super(Component.literal("Mantle Alignment"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   private void buildWidgets() {
      int y = 22;
      String group = null;

      for (MantleTuneScreen.Param p : this.activeParams()) {
         if (!p.group().equals(group)) {
            group = p.group();
            y += 10;
         }

         int bx = 98;
         this.addRenderableWidget(Button.builder(Component.literal("-"), b -> p.set().accept(p.get().get() - p.step() * 4.0F)).bounds(bx, y, 20, 13).build());
         this.addRenderableWidget(Button.builder(Component.literal("<"), b -> p.set().accept(p.get().get() - p.step())).bounds(bx + 20 + 1, y, 20, 13).build());
         this.addRenderableWidget(Button.builder(Component.literal(">"), b -> p.set().accept(p.get().get() + p.step())).bounds(bx + 42, y, 20, 13).build());
         this.addRenderableWidget(
            Button.builder(Component.literal("+"), b -> p.set().accept(p.get().get() + p.step() * 4.0F)).bounds(bx + 63, y, 20, 13).build()
         );
         y += 15;
      }

      this.addRenderableWidget(Button.builder(Component.literal(physicsPage ? "Page: PHYSICS" : "Page: POSE"), b -> {
         physicsPage = !physicsPage;
         this.clearWidgets();
         this.buildWidgets();
      }).bounds(6, y + 6, 184, 16).build());
      y += 20;
      this.addRenderableWidget(Button.builder(Component.literal("Print values"), b -> this.print()).bounds(6, y + 6, 100, 16).build());
      this.addRenderableWidget(Button.builder(Component.literal("Close (keep)"), b -> this.onClose()).bounds(110, y + 6, 80, 16).build());
      this.addRenderableWidget(Button.builder(Component.literal("Dismiss"), b -> ModNetwork.sendGraft("mantle_off", "")).bounds(6, y + 26, 100, 16).build());
   }

   private void print() {
      if (this.minecraft != null && this.minecraft.player != null) {
         String msg = String.format(
            "ROOT_BACK=%.2ff ROOT_BACK_SPREAD=%.2ff ROOT_SIDE=%.2ff ROOT_HEIGHT=%.2ff ROOT_HEIGHT_CENTER=%.2ff | ARC_BACK=%.2ff ARC_BACK_SPREAD=%.2ff ARC_LIFT=%.2ff ARC_LIFT_CENTER=%.2ff ARC2_BACK=%.2ff ARC2_LIFT=%.2ff | SIDE=%.2ff BACK=%.2ff BACK_SPREAD=%.2ff HEIGHT=%.2ff HEIGHT_CENTER=%.2ff | SWAY=%.2ff BOUNCE=%.2ff DAMP=%.2ff",
            TendrilFxRenderer.MANTLE_ROOT_BACK,
            TendrilFxRenderer.MANTLE_ROOT_BACK_SPREAD,
            TendrilFxRenderer.MANTLE_ROOT_SIDE,
            TendrilFxRenderer.MANTLE_ROOT_HEIGHT,
            TendrilFxRenderer.MANTLE_ROOT_HEIGHT_CENTER,
            TendrilFxRenderer.MANTLE_ARC_BACK,
            TendrilFxRenderer.MANTLE_ARC_BACK_SPREAD,
            TendrilFxRenderer.MANTLE_ARC_LIFT,
            TendrilFxRenderer.MANTLE_ARC_LIFT_CENTER,
            TendrilFxRenderer.MANTLE_ARC2_BACK,
            TendrilFxRenderer.MANTLE_ARC2_LIFT,
            TendrilFxRenderer.MANTLE_SIDE,
            TendrilFxRenderer.MANTLE_BACK,
            TendrilFxRenderer.MANTLE_BACK_SPREAD,
            TendrilFxRenderer.MANTLE_HEIGHT,
            TendrilFxRenderer.MANTLE_HEIGHT_CENTER,
            TendrilFxRenderer.MANTLE_SWAY,
            TendrilFxRenderer.MANTLE_BOUNCE,
            TendrilFxRenderer.MANTLE_DAMP
         );
         String phys = String.format(
            "PHYS land: SHAPE=%.1ff KEEP=%.2ff BRACE=%.2ff BEND=%.2ff WAVE=%.2ff KICK=%.2ff WIND=%.2ff | water: SHAPE=%.1ff KEEP=%.2ff BRACE=%.2ff BEND=%.2ff WAVE=%.2ff STREAM=%.2ff RESIST=%.2ff | exert: SHAPE=%.1ff BRACE=%.2ff MIN=%.1ff SPAN=%.1ff | reach: BASE=%.2ff MID=%.2ff | glint: POWER=%.2ff FOCUS=%.0ff CHAOS=%.2ff",
            TendrilFxRenderer.MANTLE_CHAIN_SHAPE,
            TendrilFxRenderer.MANTLE_CHAIN_KEEP,
            TendrilFxRenderer.MANTLE_CHAIN_BRACE,
            TendrilFxRenderer.MANTLE_CHAIN_BEND,
            TendrilFxRenderer.MANTLE_CHAIN_WAVE,
            TendrilFxRenderer.MANTLE_CHAIN_LATCH_KICK,
            TendrilFxRenderer.MANTLE_CHAIN_WRAP_WIND,
            TendrilFxRenderer.MANTLE_CHAIN_SHAPE_WATER,
            TendrilFxRenderer.MANTLE_CHAIN_KEEP_WATER,
            TendrilFxRenderer.MANTLE_CHAIN_BRACE_WATER,
            TendrilFxRenderer.MANTLE_CHAIN_BEND_WATER,
            TendrilFxRenderer.MANTLE_CHAIN_WAVE_WATER,
            TendrilFxRenderer.MANTLE_STREAM,
            TendrilFxRenderer.MANTLE_WATER_RESIST,
            TendrilFxRenderer.MANTLE_CHAIN_EXERT_SHAPE,
            TendrilFxRenderer.MANTLE_CHAIN_EXERT_BRACE,
            TendrilFxRenderer.MANTLE_CHAIN_EXERT_MIN,
            TendrilFxRenderer.MANTLE_CHAIN_EXERT_SPAN,
            TendrilFxRenderer.MANTLE_REACH_BASE,
            TendrilFxRenderer.MANTLE_REACH_MID,
            VanillaSheen.GLINT_STRENGTH,
            VanillaSheen.GLINT_EXP,
            VanillaSheen.GLINT_CHAOS
         );
         this.minecraft.player.displayClientMessage(Component.literal("§e[mantle] " + msg), false);
         this.minecraft.player.displayClientMessage(Component.literal("§e[mantle] " + phys), false);
         this.minecraft.keyboardHandler.setClipboard(msg + " || " + phys);
      }
   }

   /** A live tuning panel: the player model behind it has to stay sharp, so no menu blur and no dim, only the panel. */
   public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(2, 4, 188, 22 + this.activeParams().length * 15 + 116, -1072693224);
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      g.drawString(this.font, "MANTLE (dev): F5", 6, 9, -2576129, true);
      int y = 22;
      String group = null;

      for (MantleTuneScreen.Param p : this.activeParams()) {
         if (!p.group().equals(group)) {
            group = p.group();
            g.drawString(this.font, group, 6, y + 2, -25526, false);
            y += 10;
         }

         g.drawString(this.font, p.name(), 10, y + 3, -4675384, false);
         g.drawString(this.font, String.format("%.2f", p.get().get()), 70, y + 3, -1516304, false);
         y += 15;
      }
   }

   private record Param(String group, String name, Supplier<Float> get, Consumer<Float> set, float step) {
   }
}
