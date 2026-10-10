package com.scout.symbiote.override;

import com.scout.symbiote.util.ItemCompat;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.Vindication;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

public final class LowHealthOverride {
   private static final Map<UUID, Boolean> NO_FOOD_EPISODE = new HashMap<>();
   private static final Map<UUID, Long> LAST_HOST_FEED = new HashMap<>();
   private static final int HOST_FEED_COOLDOWN = 2400;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (OverrideGate.check(player, level, p, "low_health_override")) {
         if (PlayerCommandDispatcher.getMode(player.getUUID()) == PlayerCommandDispatcher.CommandMode.HIDE) {
            SymbioteLog.overrideSkipped(player.getUUID(), "low_health_override", "command_hide");
         } else {
            float hpFrac = player.getHealth() / player.getMaxHealth();
            double threshold = Math.min(0.6, SymbioteConfig.LOW_HEALTH_OVERRIDE_HP_FRAC.get() * p.stageIntensity());
            if (hpFrac > threshold) {
               NO_FOOD_EPISODE.remove(player.getUUID());
            }

            if (hpFrac <= threshold) {
               if (!NO_FOOD_EPISODE.containsKey(player.getUUID()) || findFoodSlot(player) != -1) {
                  execute(player, level, p);
               }
            } else {
               tickHostFeed(player, level, p);
            }
         }
      }
   }

   private static void tickHostFeed(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      int threshold = SymbioteConfig.HOST_FEED_HUNGER_THRESHOLD.get();
      if (threshold > 0 && player.getFoodData().getFoodLevel() <= threshold) {
         long now = level.getGameTime();
         if (now - LAST_HOST_FEED.getOrDefault(player.getUUID(), 0L) >= 2400L) {
            int foodSlot = findFoodSlot(player);
            if (foodSlot == -1) {
               LAST_HOST_FEED.put(player.getUUID(), now);
               SymbioteLog.overrideSkipped(player.getUUID(), "host_feed", "no_food");
            } else {
               LAST_HOST_FEED.put(player.getUUID(), now);
               ItemStack stack = player.getInventory().getItem(foodSlot);
               FoodProperties props = ItemCompat.food(stack);
               if (props != null) {
                  player.getFoodData().eat(props);
               }

               stack.shrink(1);
               player.getInventory().setItem(foodSlot, stack);
               ModNetwork.sendOverrideFx(player, "vignette_red", 20);
               VoiceLines.send(player, "symbiote.voice.host_feed", 4);
               OverrideGate.seize(player, level, p, "host_feed");
               SymbioteLog.overrideFired(player.getUUID(), "host_feed", "food_bar_empty", "food_level", player.getFoodData().getFoodLevel(), "slot", foodSlot);
            }
         }
      }
   }

   public static boolean forceTrigger(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (!p.stage.isBonded()) {
         return false;
      }

      execute(player, level, p);
      return true;
   }

   private static void execute(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      int foodSlot = findFoodSlot(player);
      if (foodSlot == -1) {
         NO_FOOD_EPISODE.put(player.getUUID(), Boolean.TRUE);
         SymbioteLog.overrideSkipped(player.getUUID(), "low_health_override", "no_food");
         VoiceLines.send(player, "symbiote.voice.low_health", 3);
         OverrideGate.seize(player, level, p, "low_health_override");
         ModNetwork.sendOverrideFx(player, "vignette_red", 25);
      } else {
         ItemStack stack = player.getInventory().getItem(foodSlot);
         Item consumed = stack.getItem();
         FoodProperties props = ItemCompat.food(stack);
         if (props != null) {
            player.getFoodData().eat(props);
            player.heal(props.nutrition() * 0.5F);
         }

         stack.shrink(1);
         player.getInventory().setItem(foodSlot, stack);
         ModNetwork.sendOverrideFx(player, "vignette_red", 30);
         VoiceLines.send(player, "symbiote.voice.low_health", 3);
         Vindication.consider(player, level.getGameTime());
         OverrideGate.seize(player, level, p, "low_health_override");
         SymbioteLog.overrideFired(player.getUUID(), "low_health_override", "hp_threshold", "hp", player.getHealth(), "consumed", consumed, "slot", foodSlot);
      }
   }

   private static int findFoodSlot(ServerPlayer player) {
      int best = -1;
      int bestNutrition = -1;

      for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
         ItemStack s = player.getInventory().getItem(i);
         if (!s.isEmpty()) {
            Item item = s.getItem();
            FoodProperties props = ItemCompat.food(s);
            if (props != null
               && !isReservedRawMeat(item)
               && !ItemCompat.hasConsumeEffects(s)
               && item != Items.CHORUS_FRUIT
               && item != Items.SUSPICIOUS_STEW
               && props.nutrition() > bestNutrition) {
               bestNutrition = props.nutrition();
               best = i;
            }
         }
      }

      return best;
   }

   private static boolean isReservedRawMeat(Item item) {
      return item == Items.BEEF
         || item == Items.CHICKEN
         || item == Items.PORKCHOP
         || item == Items.MUTTON
         || item == Items.RABBIT
         || item == Items.COD
         || item == Items.SALMON
         || item == Items.ROTTEN_FLESH
         || item == Items.SPIDER_EYE;
   }

   public static void onLogout(UUID player) {
      LAST_HOST_FEED.remove(player);
      NO_FOOD_EPISODE.remove(player);
   }

   public static void clearEmergency(UUID player) {
      NO_FOOD_EPISODE.remove(player);
      LAST_HOST_FEED.remove(player);
   }

   private LowHealthOverride() {
   }
}
