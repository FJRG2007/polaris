package com.scout.symbiote.client.armor;

import java.util.function.Consumer;
import java.util.function.Supplier;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

public class FormTuneScreen extends Screen {
   private final FormTuneScreen.Param[] params = new FormTuneScreen.Param[]{
      new FormTuneScreen.Param("arm drop", () -> LivingArmorModel.ARM_DROP, v -> LivingArmorModel.ARM_DROP = Math.max(0.0F, v), 0.25F, 1.0F),
      new FormTuneScreen.Param("claw len", () -> LivingArmorModel.CLAW_LEN, v -> LivingArmorModel.CLAW_LEN = Math.max(0.0F, v), 0.25F, 1.0F),
      new FormTuneScreen.Param("head sink", () -> LivingArmorModel.HEAD_SINK, v -> LivingArmorModel.HEAD_SINK = v, 0.2F, 0.6F),
      new FormTuneScreen.Param("leg len", () -> LivingArmorModel.LEG_LEN, v -> LivingArmorModel.LEG_LEN = Math.max(6.0F, v), 0.5F, 2.0F)
   };
   private static final int PANEL_X = 8;
   private static final int PANEL_Y = 24;
   private static final int ROW_H = 19;
   private static final int LABEL_W = 76;
   private static final int BTN_W = 24;

   public FormTuneScreen() {
      super(Component.literal("Horror Form Tuning"));
   }

   public boolean isPauseScreen() {
      return false;
   }

   protected void init() {
      int y = 24;

      for (FormTuneScreen.Param p : this.params) {
         int bx = 84;
         this.addRenderableWidget(Button.builder(Component.literal("--"), b -> this.bump(p, -p.coarse())).bounds(bx, y, 24, 17).build());
         this.addRenderableWidget(Button.builder(Component.literal("-"), b -> this.bump(p, -p.fine())).bounds(bx + 24 + 2, y, 24, 17).build());
         this.addRenderableWidget(Button.builder(Component.literal("+"), b -> this.bump(p, p.fine())).bounds(bx + 52, y, 24, 17).build());
         this.addRenderableWidget(Button.builder(Component.literal("++"), b -> this.bump(p, p.coarse())).bounds(bx + 78, y, 24, 17).build());
         y += 19;
      }

      this.addRenderableWidget(Button.builder(Component.literal("Print values"), b -> this.print()).bounds(8, y + 4, 100, 18).build());
      this.addRenderableWidget(Button.builder(Component.literal("Classic"), b -> LivingArmorModel.horrorForm = false).bounds(112, y + 4, 60, 18).build());
      this.addRenderableWidget(Button.builder(Component.literal("Horror"), b -> LivingArmorModel.horrorForm = true).bounds(176, y + 4, 60, 18).build());
   }

   private void bump(FormTuneScreen.Param p, float delta) {
      p.set().accept(p.get().get() + delta);
      HorrorFormModels.rebake();
   }

   private void print() {
      if (this.minecraft != null && this.minecraft.player != null) {
         String msg = String.format(
            "ARM_DROP=%.2ff CLAW_LEN=%.2ff HEAD_SINK=%.2ff LEG_LEN=%.1ff",
            LivingArmorModel.ARM_DROP,
            LivingArmorModel.CLAW_LEN,
            LivingArmorModel.HEAD_SINK,
            LivingArmorModel.LEG_LEN
         );
         this.minecraft.player.displayClientMessage(Component.literal("§e[form] " + msg), false);
         this.minecraft.keyboardHandler.setClipboard(msg);
      }
   }

   /** A live tuning panel: the player model behind it has to stay sharp, so no menu blur and no dim, only the panel. */
   public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      g.fill(4, 4, 194, 24 + this.params.length * 19 + 30, -1072693224);
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      g.drawString(this.font, "HORROR FORM (dev): F5", 8, 10, -2576129, true);
      int y = 24;

      for (FormTuneScreen.Param p : this.params) {
         float v = p.get().get();
         int col = v < 0.0F ? -8664577 : -1516304;
         g.drawString(this.font, p.name(), 8, y + 5, -4675384, false);
         g.drawString(this.font, String.format("%.2f", v), 56, y + 5, col, false);
         y += 19;
      }
   }

   private record Param(String name, Supplier<Float> get, Consumer<Float> set, float fine, float coarse) {
   }
}
