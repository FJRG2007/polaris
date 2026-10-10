package com.scout.symbiote.ability;

import net.minecraft.core.registries.BuiltInRegistries;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModItems;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashSet;
import java.util.Set;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.TagKey;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

public final class Feeding {
   private static final Set<Item> ACCEPTED_MEATS = Set.of(
      Items.BEEF,
      Items.CHICKEN,
      Items.PORKCHOP,
      Items.MUTTON,
      Items.RABBIT,
      Items.COD,
      Items.SALMON,
      Items.ROTTEN_FLESH,
      Items.SPIDER_EYE,
      Items.COOKED_BEEF,
      Items.COOKED_CHICKEN,
      Items.COOKED_PORKCHOP,
      Items.COOKED_MUTTON,
      Items.COOKED_RABBIT,
      Items.COOKED_COD,
      Items.COOKED_SALMON
   );
   private static final TagKey<Item> FOOD_TAG = TagKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath("symbiote", "food"));
   private static final TagKey<Item> NOT_FOOD_TAG = TagKey.create(Registries.ITEM, ResourceLocation.fromNamespaceAndPath("symbiote", "not_food"));
   private static final String[] BIO_WORDS = new String[]{
      "cerebrum",
      "cerebellum",
      "cortex",
      "brain",
      "viscera",
      "sinew",
      "marrow",
      "gristle",
      "organ",
      "heart",
      "flesh",
      "spine",
      "tissue",
      "tendon",
      "liver",
      "lung",
      "carcass",
      "innard",
      "entrail",
      "gland",
      "membrane",
      "muscle",
      "eyeball",
      "larva",
      "grub",
      "maggot",
      "pustule",
      "cyst",
      "tumor",
      "meat",
      "fiber",
      "fibre"
   };
   private static final Set<String> BIO_LOGGED = new HashSet<>();
   private static final int FEED_COOLDOWN_TICKS = 30;

   private static boolean isFood(ItemStack s) {
      return s.is(NOT_FOOD_TAG)
         ? false
         : ACCEPTED_MEATS.contains(s.getItem()) || s.is((Item)ModItems.BIOMASS.get()) || s.is(FOOD_TAG) || isMeatFood(s) || isModdedBio(s);
   }

   private static boolean isMeatFood(ItemStack s) {
      FoodProperties fp = com.scout.symbiote.util.ItemCompat.food(s);
      if (fp != null && s.is(net.minecraft.tags.ItemTags.MEAT)) {
         ResourceLocation key = BuiltInRegistries.ITEM.getKey(s.getItem());
         if (key != null && BIO_LOGGED.add(key.toString())) {
            SymbioteLog.notice("FEED_MEAT_ACCEPTED item={}", key);
         }

         return true;
      } else {
         return false;
      }
   }

   private static boolean isModdedBio(ItemStack s) {
      ResourceLocation key = BuiltInRegistries.ITEM.getKey(s.getItem());
      if (key != null && !"minecraft".equals(key.getNamespace())) {
         String path = key.getPath();

         for (String w : BIO_WORDS) {
            if (path.contains(w)) {
               if (BIO_LOGGED.add(key.toString())) {
                  SymbioteLog.notice("FEED_BIO_ACCEPTED item={} matched={}", key, w);
               }

               return true;
            }
         }

         return false;
      } else {
         return false;
      }
   }

   public static boolean isSymbioteFood(ItemStack s) {
      return isFood(s);
   }

   private static boolean mendDormancy(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      ItemStack main = player.getItemInHand(InteractionHand.MAIN_HAND);
      ItemStack off = player.getItemInHand(InteractionHand.OFF_HAND);
      ItemStack stack;
      InteractionHand hand;
      if (main.is((Item)ModItems.BIOMASS.get())) {
         stack = main;
         hand = InteractionHand.MAIN_HAND;
      } else {
         if (!off.is((Item)ModItems.BIOMASS.get())) {
            return false;
         }

         stack = off;
         hand = InteractionHand.OFF_HAND;
      }

      if (now - p.lastFeedTick < 30L) {
         return true;
      }

      int cut = SymbioteConfig.BIOMASS_DORMANCY_CUT.get();
      long remaining = p.dormantUntilTick - now;
      long newRemaining = Math.max(40L, remaining - cut);
      p.dormantUntilTick = now + newRemaining;
      p.lastFeedTick = now;
      stack.shrink(1);
      player.setItemInHand(hand, stack);
      SymbioteTracker.adjustHunger(level, player, 6, "hunger_biomass_mend");
      SymbioteTracker.adjustTrust(level, player, 3, "trust_biomass_mend");
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      level.playSound(null, player.getX(), player.getY(), player.getZ(), (SoundEvent)ModSounds.TENDRIL_GRIP.get(), SoundSource.PLAYERS, 0.7F, 0.85F);
      VoiceLines.send(player, newRemaining <= 60L ? "symbiote.voice.mend_nearly" : "symbiote.voice.mend", 1);
      SymbioteLog.event("BIOMASS_MEND player={} cut={} remaining={}", player.getUUID(), cut, newRemaining);
      return true;
   }

   public static void feedFromHeldItem(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      long now = level.getGameTime();
      if (!p.isDormant(now) || !mendDormancy(player, level, p, now)) {
         if (p.hunger >= 100) {
            VoiceLines.send(player, "symbiote.voice.feed_full", 0);
            SymbioteLog.event("FEED_REFUSED player={} reason=hunger_full", player.getUUID());
         } else if (now - p.lastFeedTick >= 30L) {
            ItemStack main = player.getItemInHand(InteractionHand.MAIN_HAND);
            ItemStack off = player.getItemInHand(InteractionHand.OFF_HAND);
            ItemStack stack;
            InteractionHand hand;
            if (isFood(main)) {
               stack = main;
               hand = InteractionHand.MAIN_HAND;
            } else {
               if (!isFood(off)) {
                  VoiceLines.send(player, "symbiote.voice.feed_refused", 2);
                  SymbioteLog.event("FEED_REFUSED player={} reason=no_valid_item main={} off={}", player.getUUID(), main.getItem(), off.getItem());
                  return;
               }

               stack = off;
               hand = InteractionHand.OFF_HAND;
            }

            if (p.strain != SymbioteStrain.ROYAL || stack.getItem() != Items.ROTTEN_FLESH && stack.getItem() != Items.SPIDER_EYE) {
               p.lastFeedTick = now;
               int gained = SymbioteConfig.HUNGER_PER_RAW_MEAT.get();
               SymbioteTracker.adjustHunger(level, player, gained, "hunger_feed");
               SymbioteTracker.adjustBond(level, player, SymbioteConfig.BOND_FEED.get(), "bond_feed");
               SymbioteTracker.adjustTrust(level, player, SymbioteConfig.TRUST_FEED.get(), "trust_feed");
               p.addBeat(MoodEngine.BeatType.FED, now, null);
               stack.shrink(1);
               player.setItemInHand(hand, stack);
               SymbioteDesires.notifyFed(player, level, p, now);
               GraftTicker.onHostFed(player, level, p);
               VoiceLines.send(player, "symbiote.voice.feed_accepted", 1);
               SymbioteLog.event("FEED_ACCEPTED player={} item={} hunger_gained={}", player.getUUID(), stack.getItem(), gained);
            } else {
               p.lastFeedTick = now;
               SymbioteTracker.adjustStress(level, player, 3, "stress_royal_carrion");
               VoiceLines.send(player, "symbiote.voice.royal_carrion", 3);
               SymbioteLog.event("FEED_REFUSED player={} reason=royal_carrion item={}", player.getUUID(), stack.getItem());
            }
         }
      }
   }

   private Feeding() {
   }
}
