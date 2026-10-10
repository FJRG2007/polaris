package com.scout.symbiote.menu;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

public class ArmContainer implements Container {
   private final SymbioteProfile profile;
   private final ServerLevel level;
   private final ServerPlayer player;

   public ArmContainer(SymbioteProfile profile, ServerLevel level, ServerPlayer player) {
      this.profile = profile;
      this.level = level;
      this.player = player;
   }

   public int getContainerSize() {
      return this.profile.armSlots.length;
   }

   public boolean isEmpty() {
      for (ItemStack s : this.profile.armSlots) {
         if (!s.isEmpty()) {
            return false;
         }
      }

      return true;
   }

   public ItemStack getItem(int i) {
      return i >= 0 && i < this.profile.armSlots.length ? this.profile.armSlots[i] : ItemStack.EMPTY;
   }

   public ItemStack removeItem(int i, int count) {
      if (i >= 0 && i < this.profile.armSlots.length && !this.profile.armSlots[i].isEmpty() && count > 0) {
         ItemStack removed = this.profile.armSlots[i].split(count);
         if (this.profile.armSlots[i].isEmpty()) {
            this.profile.armSlots[i] = ItemStack.EMPTY;
         }

         if (!removed.isEmpty()) {
            this.setChanged();
         }

         return removed;
      } else {
         return ItemStack.EMPTY;
      }
   }

   public ItemStack removeItemNoUpdate(int i) {
      if (i >= 0 && i < this.profile.armSlots.length) {
         ItemStack r = this.profile.armSlots[i];
         this.profile.armSlots[i] = ItemStack.EMPTY;
         return r;
      } else {
         return ItemStack.EMPTY;
      }
   }

   public void setItem(int i, ItemStack stack) {
      if (i >= 0 && i < this.profile.armSlots.length) {
         this.profile.armSlots[i] = stack;
         if (!stack.isEmpty() && stack.getCount() > this.getMaxStackSize()) {
            stack.setCount(this.getMaxStackSize());
         }
      }
   }

   public void setChanged() {
      SymbioteTracker.get(this.level).setDirty();
      ModNetwork.syncToPlayer(this.level, this.player);
   }

   public boolean stillValid(Player p) {
      return p == this.player && !this.player.isRemoved();
   }

   public void clearContent() {
      for (int i = 0; i < this.profile.armSlots.length; i++) {
         this.profile.armSlots[i] = ItemStack.EMPTY;
      }
   }
}
