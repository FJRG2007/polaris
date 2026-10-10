package com.scout.symbiote.client;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.network.ServerboundArmAssignPacket;
import com.scout.symbiote.tracker.BondStage;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.CreativeModeInventoryScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.gui.screens.recipebook.RecipeUpdateListener;
import net.minecraft.network.chat.Component;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.neoforge.client.event.ScreenEvent.Init.Post;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote", value = Dist.CLIENT)
public final class ArmInventoryButton {
   private static final int SIZE = 20;

   @SubscribeEvent(priority = EventPriority.LOW)
   public static void onScreenInit(Post event) {
      if (event.getScreen() instanceof InventoryScreen || event.getScreen() instanceof CreativeModeInventoryScreen) {
         AbstractContainerScreen<?> screen = (AbstractContainerScreen<?>)event.getScreen();
         if (SymbioteClientState.getStage().isAtLeast(BondStage.COOPERATIVE)) {
            int left = screen.getGuiLeft();
            int top = screen.getGuiTop();
            int right = left + screen.getXSize();
            boolean hasEffects = Minecraft.getInstance().player != null && !Minecraft.getInstance().player.getActiveEffects().isEmpty();
            // 1.21.4 keeps the recipe book private; an open book is visible as the container shifted off-centre.
            boolean recipeBookOpen = event.getScreen() instanceof net.minecraft.client.gui.screens.inventory.AbstractRecipeBookScreen<?>
               && screen.getGuiLeft() != (screen.width - screen.getXSize()) / 2;
            List<int[]> candidates = new ArrayList<>();
            if (!recipeBookOpen) {
               candidates.add(new int[]{left - 20 - 2, top + 4});
               candidates.add(new int[]{left - 20 - 2, top + 28});
               candidates.add(new int[]{left - 20 - 2, top + 52});
               candidates.add(new int[]{left - 20 - 2, top + 76});
            }

            if (!hasEffects || recipeBookOpen) {
               candidates.add(new int[]{right + 2, top + 4});
               candidates.add(new int[]{right + 2, top + 28});
               candidates.add(new int[]{right + 2, top + 52});
               candidates.add(new int[]{right + 2, top + 76});
            }

            if (candidates.isEmpty()) {
               candidates.add(new int[]{right + 2, top + 4});
            }

            int[] spot = candidates.get(0);

            for (int[] cand : candidates) {
               if (!collides(event.getListenersList(), cand[0], cand[1])) {
                  spot = cand;
                  break;
               }
            }

            Button button = Button.builder(Component.literal("✦"), b -> net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundArmAssignPacket(2)))
               .bounds(spot[0], spot[1], 20, 20)
               .tooltip(Tooltip.create(Component.translatable("container.symbiote.arms")))
               .build();
            event.addListener(button);
         }
      }
   }

   private static boolean collides(List<GuiEventListener> listeners, int x, int y) {
      for (GuiEventListener l : listeners) {
         if (l instanceof AbstractWidget w
            && x < w.getX() + w.getWidth()
            && x + 20 > w.getX()
            && y < w.getY() + w.getHeight()
            && y + 20 > w.getY()) {
            return true;
         }
      }

      return false;
   }

   private ArmInventoryButton() {
   }
}
