package com.scout.symbiote.client;

final class ReachMiningHold {
   private final int minimumTicks;
   private int heldTicks;
   private boolean consumed;

   ReachMiningHold(int minimumTicks) {
      this.minimumTicks = minimumTicks;
   }

   boolean canAttempt(boolean attackDown, boolean armed, boolean vanillaTarget) {
      if (!attackDown || !armed) {
         this.heldTicks = 0;
         this.consumed = false;
         return false;
      }

      if (vanillaTarget) {
         this.heldTicks = 0;
         this.consumed = true;
         return false;
      }

      if (this.consumed) {
         return false;
      }

      this.heldTicks++;
      return this.heldTicks >= this.minimumTicks;
   }

   void markSent() {
      this.consumed = true;
   }
}
