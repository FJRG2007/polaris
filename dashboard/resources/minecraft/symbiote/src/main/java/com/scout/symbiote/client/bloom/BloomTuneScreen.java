package com.scout.symbiote.client.bloom;

import java.util.function.Consumer;
import java.util.function.Supplier;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

public class BloomTuneScreen extends Screen {
   private final BloomTuneScreen.Param[] params = new BloomTuneScreen.Param[]{
      new BloomTuneScreen.Param(
         "outer petals", () -> (float)BloomRenderLayer.OUTER_PETALS, v -> BloomRenderLayer.OUTER_PETALS = Math.max(0, Math.round(v)), 1.0F, 2.0F, "%.0f"
      ),
      new BloomTuneScreen.Param(
         "inner petals", () -> (float)BloomRenderLayer.INNER_PETALS, v -> BloomRenderLayer.INNER_PETALS = Math.max(0, Math.round(v)), 1.0F, 2.0F, "%.0f"
      ),
      new BloomTuneScreen.Param("root y (up-)", () -> BloomRenderLayer.ROOT_Y, v -> BloomRenderLayer.ROOT_Y = v, 0.25F, 1.0F, "%.2f"),
      new BloomTuneScreen.Param("root radius", () -> BloomRenderLayer.ROOT_RADIUS, v -> BloomRenderLayer.ROOT_RADIUS = Math.max(0.0F, v), 0.2F, 1.0F, "%.2f"),
      new BloomTuneScreen.Param("outer len", () -> BloomRenderLayer.OUTER_LEN, v -> BloomRenderLayer.OUTER_LEN = Math.max(0.0F, v), 1.0F, 4.0F, "%.1f"),
      new BloomTuneScreen.Param("inner len", () -> BloomRenderLayer.INNER_LEN, v -> BloomRenderLayer.INNER_LEN = Math.max(0.0F, v), 1.0F, 4.0F, "%.1f"),
      new BloomTuneScreen.Param(
         "splay open", () -> BloomRenderLayer.SPLAY_OPEN, v -> BloomRenderLayer.SPLAY_OPEN = Math.max(0.0F, Math.min(1.0F, v)), 0.05F, 0.15F, "%.2f"
      ),
      new BloomTuneScreen.Param("r root", () -> BloomRenderLayer.R_ROOT, v -> BloomRenderLayer.R_ROOT = Math.max(0.05F, v), 0.1F, 0.5F, "%.2f"),
      new BloomTuneScreen.Param("r tip", () -> BloomRenderLayer.R_TIP, v -> BloomRenderLayer.R_TIP = Math.max(0.02F, v), 0.05F, 0.2F, "%.2f"),
      new BloomTuneScreen.Param("writhe", () -> BloomRenderLayer.WRITHE, v -> BloomRenderLayer.WRITHE = Math.max(0.0F, v), 0.1F, 0.5F, "%.2f"),
      new BloomTuneScreen.Param(
         "head core", () -> BloomRenderLayer.HEAD_CORE, v -> BloomRenderLayer.HEAD_CORE = Math.max(0.0F, Math.min(1.0F, v)), 0.05F, 0.15F, "%.2f"
      )
   };
   private static final int PANEL_X = 8;
   private static final int PANEL_Y = 24;
   private static final int ROW_H = 20;
   private static final int LABEL_W = 92;
   private static final int BTN_W = 24;

   public BloomTuneScreen() {
      super(Component.literal("Bloom Tuning"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   protected void init() {
      int y = 24;

      for (BloomTuneScreen.Param p : this.params) {
         int bx = 100;
         this.addRenderableWidget(Button.builder(Component.literal("--"), b -> p.set().accept(p.get().get() - p.coarse())).bounds(bx, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("-"), b -> p.set().accept(p.get().get() - p.fine())).bounds(bx + 24 + 2, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("+"), b -> p.set().accept(p.get().get() + p.fine())).bounds(bx + 52, y, 24, 18).build());
         this.addRenderableWidget(Button.builder(Component.literal("++"), b -> p.set().accept(p.get().get() + p.coarse())).bounds(bx + 78, y, 24, 18).build());
         y += 20;
      }

      this.addRenderableWidget(Button.builder(Component.literal("Print values"), b -> this.print()).bounds(8, y + 4, 100, 18).build());
      this.addRenderableWidget(Button.builder(Component.literal("Hide crown"), b -> BloomRenderLayer.preview = false).bounds(112, y + 4, 80, 18).build());
   }

   private void print() {
      if (this.minecraft != null && this.minecraft.player != null) {
         String msg = String.format(
            "OUTER_PETALS=%d INNER_PETALS=%d ROOT_Y=%.2ff ROOT_RADIUS=%.2ff OUTER_LEN=%.1ff INNER_LEN=%.1ff SPLAY_OPEN=%.2ff R_ROOT=%.2ff R_TIP=%.2ff WRITHE=%.2ff HEAD_CORE=%.2ff",
            BloomRenderLayer.OUTER_PETALS,
            BloomRenderLayer.INNER_PETALS,
            BloomRenderLayer.ROOT_Y,
            BloomRenderLayer.ROOT_RADIUS,
            BloomRenderLayer.OUTER_LEN,
            BloomRenderLayer.INNER_LEN,
            BloomRenderLayer.SPLAY_OPEN,
            BloomRenderLayer.R_ROOT,
            BloomRenderLayer.R_TIP,
            BloomRenderLayer.WRITHE,
            BloomRenderLayer.HEAD_CORE
         );
         this.minecraft.player.displayClientMessage(Component.literal("§e[bloom] " + msg), false);
         this.minecraft.keyboardHandler.setClipboard(msg);
      }
   }

   /** A live tuning panel: the player model behind it has to stay sharp, so no menu blur and no dim, only the panel. */
   public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(4, 4, 210, 24 + this.params.length * 20 + 30, -1072693224);
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      g.drawString(this.font, "BLOOM TUNING (dev): F5", 8, 10, -2576129, true);
      int y = 24;

      for (BloomTuneScreen.Param p : this.params) {
         g.drawString(this.font, p.name(), 8, y + 5, -4675384, false);
         g.drawString(this.font, String.format(p.fmt(), p.get().get()), 70, y + 5, -1516304, false);
         y += 20;
      }
   }

   private record Param(String name, Supplier<Float> get, Consumer<Float> set, float fine, float coarse, String fmt) {
   }
}
