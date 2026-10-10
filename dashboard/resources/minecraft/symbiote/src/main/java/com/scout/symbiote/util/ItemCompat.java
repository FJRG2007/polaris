package com.scout.symbiote.util;

import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.DiggerItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.level.Level;

/**
 * Item queries that Forge 1.20.1 answered from the Item class and 1.21.4 answers from data components and
 * data-driven enchantments. One place, so every caller keeps the old meaning.
 */
public final class ItemCompat {
   /** Forge 1.20.1 {@code Item#isEdible()}: the item carries food properties. */
   public static boolean isEdible(ItemStack stack) {
      return stack.has(DataComponents.FOOD);
   }

   /** Forge 1.20.1 {@code Item#isFireResistant()}: netherite-style items that survive fire and lava. */
   public static boolean isFireResistant(ItemStack stack) {
      net.minecraft.world.item.component.DamageResistant dr = stack.get(DataComponents.DAMAGE_RESISTANT);
      return dr != null && dr.types().equals(net.minecraft.tags.DamageTypeTags.IS_FIRE);
   }

   /** Forge 1.20.1 {@code !FoodProperties#getEffects().isEmpty()}: eating the item applies status effects. */
   public static boolean hasConsumeEffects(ItemStack stack) {
      net.minecraft.world.item.component.Consumable c = stack.get(DataComponents.CONSUMABLE);
      return c != null && c.onConsumeEffects().stream().anyMatch(e -> e instanceof net.minecraft.world.item.consume_effects.ApplyStatusEffectsConsumeEffect);
   }

   public static FoodProperties food(ItemStack stack) {
      return stack.get(DataComponents.FOOD);
   }

   /** Sum of the flat (ADD_VALUE) attack-damage modifiers the stack gives in the main hand. */
   public static double flatAttackDamage(ItemStack stack) {
      double[] sum = new double[1];
      stack.getAttributeModifiers().forEach(EquipmentSlot.MAINHAND, (attr, mod) -> {
         if (attr.is(Attributes.ATTACK_DAMAGE) && mod.operation() == AttributeModifier.Operation.ADD_VALUE) {
            sum[0] += mod.amount();
         }
      });
      return sum[0];
   }

   /** True when the stack has any attack-damage modifier in the main hand. */
   public static boolean hasAttackDamage(ItemStack stack) {
      boolean[] found = new boolean[1];
      stack.getAttributeModifiers().forEach(EquipmentSlot.MAINHAND, (attr, mod) -> {
         if (attr.is(Attributes.ATTACK_DAMAGE)) {
            found[0] = true;
         }
      });
      return found[0];
   }

   /** Forge 1.20.1 {@code instanceof TieredItem}: the tiered tools that remain as classes in 1.21.4. */
   public static boolean isTiered(ItemStack stack) {
      return stack.getItem() instanceof DiggerItem || stack.getItem() instanceof SwordItem;
   }

   /**
    * Stand-in for the removed {@code Tier#getSpeed()}: the material speed survives only as the mining-speed rule of
    * the tool component. Rules faster than any material (a sword's cobweb rule) are ignored.
    */
   public static float tierSpeed(ItemStack stack) {
      if (!isTiered(stack)) {
         return 0.0F;
      }

      Tool tool = stack.get(DataComponents.TOOL);
      if (tool == null) {
         return 0.0F;
      }

      float best = 0.0F;
      for (Tool.Rule rule : tool.rules()) {
         if (rule.speed().isPresent() && rule.speed().get() < 15.0F) {
            best = Math.max(best, rule.speed().get());
         }
      }

      return best;
   }

   public static Holder<Enchantment> enchantment(Level level, ResourceKey<Enchantment> key) {
      return level.registryAccess().lookupOrThrow(Registries.ENCHANTMENT).getOrThrow(key);
   }

   public static int enchantmentLevel(Level level, ResourceKey<Enchantment> key, ItemStack stack) {
      return EnchantmentHelper.getItemEnchantmentLevel(enchantment(level, key), stack);
   }

   private ItemCompat() {
   }
}
