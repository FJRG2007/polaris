package com.scout.symbiote.client;

import com.mojang.blaze3d.platform.InputConstants.Type;
import net.minecraft.client.KeyMapping;
import net.neoforged.neoforge.client.settings.KeyConflictContext;

public final class SymbioteKeybinds {
   public static final String CATEGORY = "key.categories.symbiote";
   public static final KeyMapping TENDRIL_YANK = make("key.symbiote.tendril_yank", 82);
   public static final KeyMapping WALL_CLING = make("key.symbiote.wall_cling", 67);
   public static final KeyMapping LIVING_ARMOR_TOGGLE = make("key.symbiote.living_armor_toggle", 71);
   public static final KeyMapping RADIAL_MENU = make("key.symbiote.radial_menu", 88);
   public static final KeyMapping FEED = make("key.symbiote.feed", 66);
   public static final KeyMapping TENDRIL_LASH = make("key.symbiote.tendril_lash", 90);
   public static final KeyMapping CARAPACE = make("key.symbiote.carapace", 72);
   public static final KeyMapping FRENZY = make("key.symbiote.frenzy", 74);
   public static final KeyMapping APEX = make("key.symbiote.apex", 75);
   public static final KeyMapping CONSUME = make("key.symbiote.consume", 85);
   public static final KeyMapping STRAIN_POWER = make("key.symbiote.strain_power", 84);
   public static final KeyMapping ARM_ASSIGN = make("key.symbiote.arm_assign", 79);
   public static final KeyMapping ARM_TOGGLE = make("key.symbiote.arm_toggle", 76);
   public static final KeyMapping ARM_WALL = make("key.symbiote.arm_wall", 78);
   public static final KeyMapping GRAFT_ASK = make("key.symbiote.graft_ask", 86);
   public static final KeyMapping[] ALL = new KeyMapping[]{
      TENDRIL_YANK, WALL_CLING, LIVING_ARMOR_TOGGLE, RADIAL_MENU, FEED, APEX, CONSUME, ARM_ASSIGN, ARM_TOGGLE, ARM_WALL
   };

   private static KeyMapping make(String name, int defaultKey) {
      return new KeyMapping(name, KeyConflictContext.IN_GAME, Type.KEYSYM, defaultKey, "key.categories.symbiote");
   }

   private SymbioteKeybinds() {
   }
}
