package com.scout.symbiote.client;

import com.scout.symbiote.config.SymbioteConfig;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.CommonComponents;
import net.minecraft.network.chat.Component;

public final class SymbioteConfigScreen extends Screen {
   private final Screen parent;

   public SymbioteConfigScreen(Screen parent) {
      super(Component.literal("Symbiote"));
      this.parent = parent;
   }

   protected void init() {
      Button blips = Button.builder(blipLabel(), b -> {
         SymbioteConfig.SCULK_ECHO_BLIPS.set(!(Boolean)SymbioteConfig.SCULK_ECHO_BLIPS.get());
         SymbioteConfig.CLIENT_SPEC.save();
         b.setMessage(blipLabel());
      }).bounds(this.width / 2 - 100, this.height / 2 - 12, 200, 20).build();
      blips.setTooltip(Tooltip.create(Component.literal("The sonar diamonds drawn when a shaderpack is active. Turn OFF for clean recordings.")));
      this.addRenderableWidget(blips);
      this.addRenderableWidget(
         Button.builder(CommonComponents.GUI_DONE, b -> this.onClose()).bounds(this.width / 2 - 100, this.height / 2 + 16, 200, 20).build()
      );
   }

   private static Component blipLabel() {
      return Component.literal("Sculk echo blips: " + (SymbioteConfig.SCULK_ECHO_BLIPS.get() ? "ON" : "OFF"));
   }

   public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
      super.render(g, mouseX, mouseY, partialTick);
      g.drawCenteredString(this.font, this.title, this.width / 2, this.height / 2 - 40, -1652481);
   }

   public void onClose() {
      this.minecraft.setScreen(this.parent);
   }
}
