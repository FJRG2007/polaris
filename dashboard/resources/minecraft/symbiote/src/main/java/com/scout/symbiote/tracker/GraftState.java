package com.scout.symbiote.tracker;

import net.minecraft.nbt.CompoundTag;

public final class GraftState {
   public SymbioteStrain strain;
   public int hunger = 60;
   public int tension = 0;
   public long attachedTick = 0L;
   public long lastActTick = 0L;

   public GraftState() {
   }

   public GraftState(SymbioteStrain strain, long now) {
      this.strain = strain;
      this.attachedTick = now;
   }

   public boolean isStarving() {
      return this.hunger <= 15;
   }

   public String displayName() {
      String s = this.strain == null ? "graft" : this.strain.name();
      return s.charAt(0) + s.substring(1).toLowerCase();
   }

   public void addHunger(int delta) {
      this.hunger = Math.max(0, Math.min(100, this.hunger + delta));
   }

   public void addTension(int delta) {
      this.tension = Math.max(0, Math.min(100, this.tension + delta));
   }

   public CompoundTag toNbt() {
      CompoundTag tag = new CompoundTag();
      tag.putInt("strain", this.strain == null ? SymbioteStrain.GUARDIAN.ordinal() : this.strain.ordinal());
      tag.putInt("hunger", this.hunger);
      tag.putInt("tension", this.tension);
      tag.putLong("attachedTick", this.attachedTick);
      tag.putLong("lastActTick", this.lastActTick);
      return tag;
   }

   public static GraftState fromNbt(CompoundTag tag) {
      GraftState g = new GraftState();
      g.strain = SymbioteStrain.fromOrdinalSafe(tag.getInt("strain"));
      g.hunger = tag.getInt("hunger");
      g.tension = tag.getInt("tension");
      g.attachedTick = tag.getLong("attachedTick");
      g.lastActTick = tag.getLong("lastActTick");
      return g;
   }
}
