package com.scout.symbiote.client;

import java.util.function.Consumer;
import java.util.function.Supplier;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

public class MorphTuneScreen extends Screen {
   private final MorphTuneScreen.Param[] params = new MorphTuneScreen.Param[]{
      new MorphTuneScreen.Param("x (right)", () -> HandMorphRenderer.tipX, v -> HandMorphRenderer.tipX = v, 0.01F, 0.05F, "%.3f"),
      new MorphTuneScreen.Param("y (up)", () -> HandMorphRenderer.tipY, v -> HandMorphRenderer.tipY = v, 0.01F, 0.05F, "%.3f"),
      new MorphTuneScreen.Param("z (fwd -)", () -> HandMorphRenderer.tipZ, v -> HandMorphRenderer.tipZ = v, 0.01F, 0.05F, "%.3f"),
      new MorphTuneScreen.Param("scale", () -> HandMorphRenderer.scale, v -> HandMorphRenderer.scale = Math.max(0.05F, v), 0.05F, 0.25F, "%.2f"),
      new MorphTuneScreen.Param("pitch", () -> HandMorphRenderer.pitch, v -> HandMorphRenderer.pitch = v, 2.0F, 10.0F, "%.0f"),
      new MorphTuneScreen.Param("yaw", () -> HandMorphRenderer.yaw, v -> HandMorphRenderer.yaw = v, 2.0F, 10.0F, "%.0f"),
      new MorphTuneScreen.Param("roll", () -> HandMorphRenderer.roll, v -> HandMorphRenderer.roll = v, 2.0F, 10.0F, "%.0f")
   };
   private static final int PANEL_X = 8;
   private static final int PANEL_Y = 24;
   private static final int ROW_H = 20;
   private static final int LABEL_W = 76;
   private static final int BTN_W = 24;

   public MorphTuneScreen() {
      super(Component.literal("Morph Tuning"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   protected void init() {
      int x = 8;

      for (HandMorphRenderer.Form f : HandMorphRenderer.Form.values()) {
         String label = f.name().charAt(0) + f.name().substring(1).toLowerCase();
         this.addRenderableWidget(Button.builder(Component.literal(label), b -> HandMorphRenderer.previewForm = f).bounds(x, 24, 46, 18).build());
         x += 48;
      }

      int y = 48;

      for (MorphTuneScreen.Param p : this.params) {
         int bx = 84;
         this.addRenderableWidget(Button.builder(Component.literal("--"), b -> p.set().accept(p.get().get() - p.coarse())).bounds(bx, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("-"), b -> p.set().accept(p.get().get() - p.fine())).bounds(bx + 24 + 2, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("+"), b -> p.set().accept(p.get().get() + p.fine())).bounds(bx + 52, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("++"), b -> p.set().accept(p.get().get() + p.coarse())).bounds(bx + 78, y, 24, 18).build());
         y += 20;
      }

      this.addRenderableWidget(Button.builder(Component.literal("Print values"), b -> this.print()).bounds(8, y + 4, 100, 18).build());
      this.addRenderableWidget(Button.builder(Component.literal("Hide morph"), b -> HandMorphRenderer.previewForm = null).bounds(112, y + 4, 80, 18).build());
   }

   private void print() {
      if (this.minecraft != null && this.minecraft.player != null) {
         String msg = String.format(
            "tipX=%.3ff tipY=%.3ff tipZ=%.3ff scale=%.2ff pitch=%.0ff yaw=%.0ff roll=%.0ff",
            HandMorphRenderer.tipX,
            HandMorphRenderer.tipY,
            HandMorphRenderer.tipZ,
            HandMorphRenderer.scale,
            HandMorphRenderer.pitch,
            HandMorphRenderer.yaw,
            HandMorphRenderer.roll
         );
         this.minecraft.player.displayClientMessage(Component.literal("§e[morph] " + msg), false);
         this.minecraft.keyboardHandler.setClipboard(msg);
      }
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      int h = 48 + this.params.length * 20 + 30;
      g.fill(4, 4, 194, h, -1072693224);
      g.drawString(this.font, "MORPH TUNING (dev)", 8, 10, -2576129, true);
      int y = 48;

      for (MorphTuneScreen.Param p : this.params) {
         String val = String.format(p.fmt(), p.get().get());
         g.drawString(this.font, p.name(), 8, y + 5, -4675384, false);
         g.drawString(this.font, val, 52, y + 5, -1516304, false);
         y += 20;
      }

      super.render(g, mouseX, mouseY, partialTick);
   }

   public void onClose() {
      super.onClose();
   }

   private record Param(String name, Supplier<Float> get, Consumer<Float> set, float fine, float coarse, String fmt) {
   }
}
