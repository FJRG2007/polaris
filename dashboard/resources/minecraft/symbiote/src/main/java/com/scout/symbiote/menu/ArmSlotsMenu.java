package com.scout.symbiote.menu;

import com.scout.symbiote.registry.ModMenus;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.world.Container;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

public class ArmSlotsMenu extends AbstractContainerMenu {
   public static final int ARM_COUNT = 5;
   private final Container arms;
   private final int unlockedSlots;
   private final int contrabandSlot;

   public ArmSlotsMenu(int id, Inventory playerInv, FriendlyByteBuf buf) {
      this(id, playerInv, new SimpleContainer(5), buf.readByte(), buf.readByte());
   }

   public ArmSlotsMenu(int id, Inventory playerInv, Container arms, int unlockedSlots, int contrabandSlot) {
      super((MenuType)ModMenus.ARM_SLOTS.get(), id);
      checkContainerSize(arms, 5);
      this.arms = arms;
      this.unlockedSlots = unlockedSlots;
      this.contrabandSlot = contrabandSlot;
      arms.startOpen(playerInv.player);
      int rowW = 90;
      int x0 = (176 - rowW) / 2 + 1;

      for (int i = 0; i < 5; i++) {
         this.addSlot(new ArmSlotsMenu.ArmSlot(arms, i, x0 + i * 18, 20, i < unlockedSlots, i == contrabandSlot));
      }

      for (int row = 0; row < 3; row++) {
         for (int col = 0; col < 9; col++) {
            this.addSlot(new Slot(playerInv, col + row * 9 + 9, 8 + col * 18, 51 + row * 18));
         }
      }

      for (int col = 0; col < 9; col++) {
         this.addSlot(new Slot(playerInv, col, 8 + col * 18, 109));
      }
   }

   public boolean slotUnlocked(int i) {
      return i < this.unlockedSlots;
   }

   public ItemStack quickMoveStack(Player player, int index) {
      ItemStack result = ItemStack.EMPTY;
      Slot slot = (Slot)this.slots.get(index);
      if (slot != null && slot.hasItem()) {
         ItemStack stack = slot.getItem();
         result = stack.copy();
         int invStart = 5;
         int invEnd = this.slots.size();
         if (index < 5) {
            if (index == this.contrabandSlot) {
               return ItemStack.EMPTY;
            }

            if (!this.moveItemStackTo(stack, invStart, invEnd, true)) {
               return ItemStack.EMPTY;
            }
         } else if (!this.moveItemStackTo(stack, 0, 5, false)) {
            return ItemStack.EMPTY;
         }

         if (stack.isEmpty()) {
            slot.set(ItemStack.EMPTY);
         } else {
            slot.setChanged();
         }

         if (stack.getCount() == result.getCount()) {
            return ItemStack.EMPTY;
         }

         slot.onTake(player, stack);
      }

      return result;
   }

   public boolean stillValid(Player player) {
      return this.arms.stillValid(player);
   }

   public void removed(Player player) {
      super.removed(player);
      this.arms.stopOpen(player);
   }

   private static final class ArmSlot extends Slot {
      private final boolean unlocked;
      private final boolean contraband;

      ArmSlot(Container container, int index, int x, int y, boolean unlocked, boolean contraband) {
         super(container, index, x, y);
         this.unlocked = unlocked;
         this.contraband = contraband;
      }

      public boolean mayPlace(ItemStack stack) {
         return this.unlocked && !this.contraband;
      }

      public boolean mayPickup(Player player) {
         return !this.contraband;
      }
   }
}
