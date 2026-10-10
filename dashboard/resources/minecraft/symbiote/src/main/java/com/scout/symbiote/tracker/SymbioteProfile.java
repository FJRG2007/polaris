package com.scout.symbiote.tracker;

import com.scout.symbiote.config.SymbioteConfig;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;
import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.world.item.ItemStack;

public final class SymbioteProfile {
   public int bond = 0;
   public int trust = 50;
   public int stress = 0;
   public int hunger = 70;
   public int livingArmorStamina = 100;
   public int stamina = 60;
   public BondStage stage = BondStage.UNBONDED;
   public SymbioteStrain strain = SymbioteStrain.GUARDIAN;
   public long dormantUntilTick = 0L;
   public long instabilityUntilTick = 0L;
   public long lastOverrideTick = -1000L;
   public long lastBondTick = 0L;
   public long lastBondGainTick = 0L;
   public long lastTrustGainTick = 0L;
   public boolean livingArmorActive = false;
   public BondStage announcedStage = BondStage.UNBONDED;
   public long lastDefianceActionTick = 0L;
   public long frenzyUntilTick = 0L;
   public long apexUntilTick = 0L;
   public long carapaceUntilTick = 0L;
   public long lastTendrilLashTick = -1000L;
   public long lastCarapaceTick = -1000L;
   public long lastFrenzyTick = -1000L;
   public long lastApexTick = -1000L;
   public long lastConsumeTick = -1000L;
   public long lastYankTick = -1000L;
   public long lastStrainAbilityTick = -1000L;
   public long aegisUntilTick = 0L;
   public long onslaughtUntilTick = 0L;
   public long lastArmorToggleTick = -1000L;
   public long lastMantleFurlTick = -1000L;
   public long lastArmorSkinTick = -1000L;
   public long lastFeedTick = -1000L;
   public int desireType = -1;
   public long desireDeadline = 0L;
   public int desireProgress = 0;
   public long lastDesireTick = 0L;
   public long resentfulNightUntil = 0L;
   public final Set<String> seenSpecies = new HashSet<>();
   public final Set<String> tastedSpecies = new HashSet<>();
   public final Set<String> encounters = new HashSet<>();
   public long lastCuriosityTick = 0L;
   public static final int MAX_ARM_SLOTS = 5;
   public ItemStack[] armSlots = newEmptyArmSlots();
   public boolean mantleFurled = false;
   public boolean armorCoversGear = false;
   public int stolenArmSlot = -1;
   public String stolenArmItem = "";
   public boolean revivalAdrenaline = false;
   public final ArrayList<SymbioteProfile.Beat> beats = new ArrayList<>();
   private static final int MAX_BEATS = 32;
   public int moodOrdinal = 1;
   public long grievingUntil = 0L;
   public long moodDebugUntil = 0L;
   public boolean firstCrossingDone = false;
   public long reunionUntil = 0L;
   public final LinkedHashSet<String> fearedSpecies = new LinkedHashSet<>();
   public int temperamentOrdinal = 0;
   public boolean wasStarving = false;
   public int contrabandSlot = -1;
   public long contrabandTakenTick = 0L;
   public long nextMoltTick = 0L;
   public long moltingUntil = 0L;
   public long bloomOpenTick = 0L;
   public long bloomUntilTick = 0L;
   public GraftState graft = null;
   public final long[] lastArmActionTick = newCooldownStamps();

   public boolean isBlooming(long now) {
      return this.bloomUntilTick > now;
   }

   public void addBeat(MoodEngine.BeatType type, long tick, String detail) {
      this.addBeat(type, type.weight, tick, detail);
   }

   public void addBeat(MoodEngine.BeatType type, int weight, long tick, String detail) {
      this.beats.add(new SymbioteProfile.Beat(type.ordinal(), weight, tick, detail == null ? "" : detail));

      while (this.beats.size() > 32) {
         this.beats.remove(0);
      }
   }

   public void addFearedSpecies(String speciesId) {
      this.fearedSpecies.add(speciesId);

      while (this.fearedSpecies.size() > 8) {
         Iterator<String> it = this.fearedSpecies.iterator();
         it.next();
         it.remove();
      }
   }

   private static ItemStack[] newEmptyArmSlots() {
      ItemStack[] a = new ItemStack[5];
      Arrays.fill(a, ItemStack.EMPTY);
      return a;
   }

   private static long[] newCooldownStamps() {
      long[] a = new long[5];
      Arrays.fill(a, -1000L);
      return a;
   }

   public int armSlotCount() {
      int base;
      if (this.stage == BondStage.DOMINANT) {
         base = 5;
      } else if (this.stage == BondStage.COOPERATIVE) {
         base = 3;
      } else {
         base = 0;
      }

      if (this.graft != null && base > 0) {
         base = Math.min(5, base + 2);
      }

      return base;
   }

   public double stageIntensity() {
      double base = 1.0;
      if (this.stage == BondStage.DOMINANT) {
         base = SymbioteConfig.DOMINANT_OVERRIDE_INTENSITY.get();
      } else if (this.stage == BondStage.COOPERATIVE) {
         base = SymbioteConfig.COOPERATIVE_OVERRIDE_INTENSITY.get();
      }

      return base + StrainTraits.intensityBonus(this.strain);
   }

   public boolean isFrenzied(long now) {
      return this.frenzyUntilTick > now;
   }

   public boolean isApex(long now) {
      return this.apexUntilTick > now;
   }

   public boolean hasCarapace(long now) {
      return this.carapaceUntilTick > now;
   }

   public boolean isAegis(long now) {
      return this.aegisUntilTick > now;
   }

   public int staminaMax() {
      return switch (this.stage) {
         case DOMINANT -> SymbioteConfig.STAMINA_MAX_DOMINANT.get();
         case COOPERATIVE -> SymbioteConfig.STAMINA_MAX_COOPERATIVE.get();
         case INTEGRATED -> SymbioteConfig.STAMINA_MAX_INTEGRATED.get();
         default -> SymbioteConfig.STAMINA_MAX_ATTACHED.get();
      };
   }

   public boolean trySpendStamina(int cost) {
      if (this.stamina < cost) {
         return false;
      }

      this.stamina = Math.max(0, this.stamina - cost);
      return true;
   }

   public void regenStamina(int amount) {
      this.stamina = Math.min(this.staminaMax(), this.stamina + amount);
   }

   public void addBond(int delta) {
      this.bond = this.clampBond(this.bond + delta);
      this.stage = BondStage.forBond(this.bond, this.stage);
   }

   public void setBond(int value) {
      this.bond = this.clampBond(value);
      this.stage = BondStage.forBond(this.bond, this.stage);
   }

   public void addTrust(int delta) {
      this.trust = clamp01(this.trust + delta);
   }

   public void setTrust(int value) {
      this.trust = clamp01(value);
   }

   public void addStress(int delta) {
      this.stress = clamp01(this.stress + delta);
   }

   public void setStress(int value) {
      this.stress = clamp01(value);
   }

   public void addHunger(int delta) {
      this.hunger = clamp01(this.hunger + delta);
   }

   public void setHunger(int value) {
      this.hunger = clamp01(value);
   }

   public void sanitizeForRestore(long currentTick) {
      this.instabilityUntilTick = 0L;
      if (this.reunionUntil <= currentTick) {
         this.dormantUntilTick = 0L;
      }

      this.apexUntilTick = 0L;
      this.onslaughtUntilTick = 0L;
      this.frenzyUntilTick = 0L;
      this.carapaceUntilTick = 0L;
      this.livingArmorActive = false;
      this.mantleFurled = false;
      this.revivalAdrenaline = false;
      this.desireType = -1;
      this.desireDeadline = 0L;
   }

   public boolean isDormant(long currentTick) {
      return this.dormantUntilTick > currentTick;
   }

   public boolean isUnstable(long currentTick) {
      return this.instabilityUntilTick > currentTick;
   }

   public boolean isStarving() {
      int threshold = SymbioteConfig.HUNGER_STARVE_THRESHOLD.get() + StrainTraits.starveThresholdBonus(this.strain);
      threshold = (int)Math.round(threshold * this.stageIntensity());
      return this.hunger <= threshold;
   }

   public boolean isHighStress() {
      return this.stress >= SymbioteConfig.STRESS_HIGH_THRESHOLD.get();
   }

   public boolean isActive(long currentTick) {
      return this.stage.isBonded() && !this.isDormant(currentTick);
   }

   public void onBond(long currentTick, SymbioteStrain newStrain) {
      this.stage = BondStage.ATTACHED;
      this.announcedStage = BondStage.ATTACHED;
      this.strain = newStrain;
      this.bond = 10;
      this.trust = 50;
      this.stress = 30;
      this.hunger = 60;
      this.stamina = SymbioteConfig.STAMINA_MAX_ATTACHED.get();
      this.instabilityUntilTick = currentTick + SymbioteConfig.INSTABILITY_DURATION_TICKS.get().intValue();
      this.dormantUntilTick = 0L;
      this.revivalAdrenaline = false;
   }

   public void onBond(long currentTick) {
      this.onBond(currentTick, SymbioteStrain.GUARDIAN);
   }

   public void onUnbond() {
      this.bond = 0;
      this.trust = 50;
      this.stress = 0;
      this.hunger = 70;
      this.livingArmorStamina = SymbioteConfig.LIVING_ARMOR_STAMINA_MAX.get();
      this.stamina = 60;
      this.stage = BondStage.UNBONDED;
      this.announcedStage = BondStage.UNBONDED;
      this.strain = SymbioteStrain.GUARDIAN;
      this.dormantUntilTick = 0L;
      this.instabilityUntilTick = 0L;
      this.livingArmorActive = false;
      this.frenzyUntilTick = 0L;
      this.apexUntilTick = 0L;
      this.carapaceUntilTick = 0L;
      this.aegisUntilTick = 0L;
      this.onslaughtUntilTick = 0L;
      this.desireType = -1;
      this.desireDeadline = 0L;
      this.desireProgress = 0;
      this.lastDesireTick = 0L;
      this.resentfulNightUntil = 0L;
      this.armSlots = newEmptyArmSlots();
      this.mantleFurled = false;
      this.beats.clear();
      this.moodOrdinal = 1;
      this.grievingUntil = 0L;
      this.reunionUntil = 0L;
      this.temperamentOrdinal = 0;
      this.fearedSpecies.clear();
      this.contrabandSlot = -1;
      this.contrabandTakenTick = 0L;
      this.nextMoltTick = 0L;
      this.moltingUntil = 0L;
   }

   public void enterDormancy(long currentTick, long ticks) {
      this.dormantUntilTick = currentTick + ticks;
      this.livingArmorActive = false;
   }

   private static int clamp01(int v) {
      return Math.max(0, Math.min(100, v));
   }

   private int clampBond(int v) {
      int max = SymbioteConfig.BOND_MAX.get();
      return Math.max(0, Math.min(max, v));
   }

   private static int remapBond(int bond, int[] from, int[] to) {
      if (bond <= 0) {
         return 0;
      }

      int b = Math.min(bond, from[3]);
      int[] lo = new int[]{0, from[0], from[1], from[2]};
      int[] hi = new int[]{from[0], from[1], from[2], from[3]};
      int[] nlo = new int[]{0, to[0], to[1], to[2]};
      int[] nhi = new int[]{to[0], to[1], to[2], to[3]};

      for (int band = 0; band < 4; band++) {
         if (b < hi[band] || band == 3) {
            float span = Math.max(1, hi[band] - lo[band]);
            int v = nlo[band] + Math.round((b - lo[band]) * ((nhi[band] - nlo[band]) / span));
            if (band < 3 && b < hi[band]) {
               v = Math.max(nlo[band], Math.min(v, nhi[band] - 1));
            }

            return v;
         }
      }

      return b;
   }

   private static int[] currentBondCurve() {
      return new int[]{
         (Integer)SymbioteConfig.STAGE_INTEGRATED_BOND.get(),
         (Integer)SymbioteConfig.STAGE_COOPERATIVE_BOND.get(),
         (Integer)SymbioteConfig.STAGE_DOMINANT_BOND.get(),
         SymbioteConfig.BOND_MAX.get()
      };
   }

   public CompoundTag toNbt(HolderLookup.Provider registries) {
      CompoundTag tag = new CompoundTag();
      tag.putInt("bond", this.bond);
      tag.putInt("bondScale", 2);
      tag.putIntArray("bondCurve", currentBondCurve());
      tag.putInt("trust", this.trust);
      tag.putInt("stress", this.stress);
      tag.putInt("hunger", this.hunger);
      tag.putInt("livingArmorStamina", this.livingArmorStamina);
      tag.putInt("stamina", this.stamina);
      tag.putString("stage", this.stage.name());
      tag.putString("announcedStage", this.announcedStage.name());
      tag.putString("strain", this.strain.name());
      tag.putLong("dormantUntilTick", this.dormantUntilTick);
      tag.putLong("instabilityUntilTick", this.instabilityUntilTick);
      tag.putLong("lastOverrideTick", this.lastOverrideTick);
      tag.putLong("lastBondTick", this.lastBondTick);
      tag.putLong("lastBondGainTick", this.lastBondGainTick);
      tag.putLong("lastTrustGainTick", this.lastTrustGainTick);
      tag.putBoolean("livingArmorActive", this.livingArmorActive);
      tag.putInt("desireType", this.desireType);
      tag.putLong("desireDeadline", this.desireDeadline);
      tag.putInt("desireProgress", this.desireProgress);
      tag.putLong("lastDesireTick", this.lastDesireTick);
      tag.putLong("resentfulNightUntil", this.resentfulNightUntil);
      CompoundTag slots = new CompoundTag();

      for (int i = 0; i < this.armSlots.length; i++) {
         if (this.armSlots[i] != null && !this.armSlots[i].isEmpty()) {
            slots.put(String.valueOf(i), this.armSlots[i].save(registries));
         }
      }

      tag.put("armSlots", slots);
      tag.putBoolean("mantleFurled", this.mantleFurled);
      tag.putBoolean("armorCoversGear", this.armorCoversGear);
      tag.put("seenSpecies", stringSetToNbt(this.seenSpecies));
      tag.put("tastedSpecies", stringSetToNbt(this.tastedSpecies));
      tag.put("encounters", stringSetToNbt(this.encounters));
      tag.putLong("lastCuriosityTick", this.lastCuriosityTick);
      tag.putInt("stolenArmSlot", this.stolenArmSlot);
      tag.putString("stolenArmItem", this.stolenArmItem);
      tag.putBoolean("revivalAdrenaline", this.revivalAdrenaline);
      ListTag beatList = new ListTag();

      for (SymbioteProfile.Beat b : this.beats) {
         CompoundTag bt = new CompoundTag();
         bt.putInt("t", b.type);
         bt.putInt("w", b.weight);
         bt.putLong("k", b.tick);
         if (!b.detail.isEmpty()) {
            bt.putString("d", b.detail);
         }

         beatList.add(bt);
      }

      tag.put("beats", beatList);
      tag.putInt("mood", this.moodOrdinal);
      tag.putLong("grievingUntil", this.grievingUntil);
      tag.putBoolean("firstCrossingDone", this.firstCrossingDone);
      tag.putLong("reunionUntil", this.reunionUntil);
      tag.put("fearedSpecies", stringSetToNbt(this.fearedSpecies));
      tag.putInt("temperament", this.temperamentOrdinal);
      tag.putInt("contrabandSlot", this.contrabandSlot);
      tag.putLong("contrabandTakenTick", this.contrabandTakenTick);
      tag.putLong("nextMoltTick", this.nextMoltTick);
      tag.putLong("moltingUntil", this.moltingUntil);
      if (this.graft != null) {
         tag.put("graft", this.graft.toNbt());
      }

      return tag;
   }

   private static ListTag stringSetToNbt(Set<String> set) {
      ListTag list = new ListTag();

      for (String s : set) {
         list.add(StringTag.valueOf(s));
      }

      return list;
   }

   private static void stringSetFromNbt(CompoundTag tag, String key, Set<String> into) {
      ListTag list = tag.getList(key, 8);

      for (int i = 0; i < list.size(); i++) {
         into.add(list.getString(i));
      }
   }

   public static SymbioteProfile fromNbt(CompoundTag tag, HolderLookup.Provider registries) {
      SymbioteProfile p = new SymbioteProfile();
      p.bond = tag.getInt("bond");
      int[] cur = currentBondCurve();
      if (tag.contains("bondCurve")) {
         int[] saved = tag.getIntArray("bondCurve");
         if (saved.length == 4 && !Arrays.equals(saved, cur)) {
            p.bond = remapBond(p.bond, saved, cur);
         }
      } else if (!tag.contains("bondScale")) {
         p.bond = remapBond(p.bond, new int[]{40, 65, 88, 100}, cur);
      }

      p.mantleFurled = tag.getBoolean("mantleFurled");
      p.armorCoversGear = tag.getBoolean("armorCoversGear");
      p.trust = tag.contains("trust") ? tag.getInt("trust") : 50;
      p.stress = tag.getInt("stress");
      p.hunger = tag.contains("hunger") ? tag.getInt("hunger") : 70;
      p.livingArmorStamina = tag.contains("livingArmorStamina") ? tag.getInt("livingArmorStamina") : 100;
      p.stamina = tag.contains("stamina") ? tag.getInt("stamina") : 60;

      try {
         p.stage = BondStage.valueOf(tag.getString("stage"));
      } catch (IllegalArgumentException e) {
         p.stage = BondStage.UNBONDED;
      }

      if (tag.contains("announcedStage")) {
         try {
            p.announcedStage = BondStage.valueOf(tag.getString("announcedStage"));
         } catch (IllegalArgumentException e) {
            p.announcedStage = p.stage;
         }
      } else {
         p.announcedStage = p.stage;
      }

      if (tag.contains("strain")) {
         try {
            p.strain = SymbioteStrain.valueOf(tag.getString("strain"));
         } catch (IllegalArgumentException e) {
            p.strain = SymbioteStrain.GUARDIAN;
         }
      }

      p.desireType = tag.contains("desireType") ? tag.getInt("desireType") : -1;
      p.desireDeadline = tag.getLong("desireDeadline");
      p.desireProgress = tag.getInt("desireProgress");
      p.lastDesireTick = tag.getLong("lastDesireTick");
      p.resentfulNightUntil = tag.getLong("resentfulNightUntil");
      p.dormantUntilTick = tag.getLong("dormantUntilTick");
      p.instabilityUntilTick = tag.getLong("instabilityUntilTick");
      p.lastOverrideTick = tag.getLong("lastOverrideTick");
      p.lastBondTick = tag.getLong("lastBondTick");
      p.lastBondGainTick = tag.getLong("lastBondGainTick");
      p.lastTrustGainTick = tag.getLong("lastTrustGainTick");
      p.livingArmorActive = tag.getBoolean("livingArmorActive");
      if (tag.contains("armSlots")) {
         CompoundTag slots = tag.getCompound("armSlots");

         for (int i = 0; i < p.armSlots.length; i++) {
            if (slots.contains(String.valueOf(i))) {
               p.armSlots[i] = ItemStack.parseOptional(registries, slots.getCompound(String.valueOf(i)));
            }
         }
      }

      stringSetFromNbt(tag, "seenSpecies", p.seenSpecies);
      stringSetFromNbt(tag, "tastedSpecies", p.tastedSpecies);
      stringSetFromNbt(tag, "encounters", p.encounters);
      p.lastCuriosityTick = tag.getLong("lastCuriosityTick");
      p.stolenArmSlot = tag.contains("stolenArmSlot") ? tag.getInt("stolenArmSlot") : -1;
      p.stolenArmItem = tag.getString("stolenArmItem");
      p.revivalAdrenaline = tag.getBoolean("revivalAdrenaline");
      ListTag beatList = tag.getList("beats", 10);

      for (int i = 0; i < beatList.size(); i++) {
         CompoundTag bt = beatList.getCompound(i);
         p.beats.add(new SymbioteProfile.Beat(bt.getInt("t"), bt.getInt("w"), bt.getLong("k"), bt.getString("d")));
      }

      p.moodOrdinal = tag.contains("mood") ? tag.getInt("mood") : 1;
      p.grievingUntil = tag.getLong("grievingUntil");
      p.firstCrossingDone = tag.getBoolean("firstCrossingDone");
      p.reunionUntil = tag.getLong("reunionUntil");
      stringSetFromNbt(tag, "fearedSpecies", p.fearedSpecies);
      p.temperamentOrdinal = tag.getInt("temperament");
      p.contrabandSlot = tag.contains("contrabandSlot") ? tag.getInt("contrabandSlot") : -1;
      p.contrabandTakenTick = tag.getLong("contrabandTakenTick");
      p.nextMoltTick = tag.getLong("nextMoltTick");
      p.moltingUntil = tag.getLong("moltingUntil");
      p.graft = tag.contains("graft") ? GraftState.fromNbt(tag.getCompound("graft")) : null;
      if (p.stage == BondStage.DOMINANT && p.temperamentOrdinal == 0) {
         p.temperamentOrdinal = MoodEngine.stampTemperament(p).ordinal();
      }

      return p;
   }

   public static final class Beat {
      public final int type;
      public final int weight;
      public final long tick;
      public final String detail;

      public Beat(int type, int weight, long tick, String detail) {
         this.type = type;
         this.weight = weight;
         this.tick = tick;
         this.detail = detail;
      }
   }
}
