package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

public final class ArmInstincts {
   private static final int USE_COOLDOWN_TICKS = 1200;
   private static final Map<UUID, Long> NEXT_ALLOWED = new HashMap<>();

   public static boolean tryTotem(ServerPlayer player, ServerLevel level, SymbioteProfile p, float incomingDamage) {
      if (!SymbioteConfig.ARMS_ENABLED.get()) {
         return false;
      }

      if (player.getHealth() - incomingDamage > 0.0F) {
         return false;
      }

      int slot = findSlot(p, Items.TOTEM_OF_UNDYING);
      if (slot < 0) {
         return false;
      }

      p.armSlots[slot].shrink(1);
      if (p.armSlots[slot].isEmpty()) {
         p.armSlots[slot] = ItemStack.EMPTY;
      }

      player.setHealth(1.0F);
      player.removeAllEffects();
      player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, 900, 1));
      player.addEffect(new MobEffectInstance(MobEffects.ABSORPTION, 100, 1));
      player.addEffect(new MobEffectInstance(MobEffects.FIRE_RESISTANCE, 800, 0));
      level.broadcastEntityEvent(player, (byte)35);
      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
      VoiceLines.send(player, "symbiote.voice.arm_instinct", 4);
      SymbioteLog.event("ARM_INSTINCT player={} used=totem dmg={}", player.getUUID(), incomingDamage);
      return true;
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (SymbioteConfig.ARMS_ENABLED.get()) {
         if (now >= NEXT_ALLOWED.getOrDefault(player.getUUID(), 0L)) {
            float hpFrac = player.getHealth() / player.getMaxHealth();
            if (hpFrac <= 0.2F) {
               int slot = findSlot(p, Items.GOLDEN_APPLE);
               if (slot < 0) {
                  slot = findSlot(p, Items.ENCHANTED_GOLDEN_APPLE);
               }

               if (slot >= 0) {
                  boolean enchanted = p.armSlots[slot].is(Items.ENCHANTED_GOLDEN_APPLE);
                  consume(player, level, p, slot);
                  player.addEffect(new MobEffectInstance(MobEffects.REGENERATION, enchanted ? 400 : 100, 1));
                  player.addEffect(new MobEffectInstance(MobEffects.ABSORPTION, 2400, enchanted ? 3 : 0));
                  if (enchanted) {
                     player.addEffect(new MobEffectInstance(MobEffects.DAMAGE_RESISTANCE, 6000, 0));
                     player.addEffect(new MobEffectInstance(MobEffects.FIRE_RESISTANCE, 6000, 0));
                  }

                  level.playSound(null, player.getX(), player.getY() + 1.0, player.getZ(), SoundEvents.GENERIC_EAT, SoundSource.PLAYERS, 1.0F, 0.9F);
                  VoiceLines.send(player, "symbiote.voice.arm_instinct", 4);
                  SymbioteLog.event("ARM_INSTINCT player={} used=gapple enchanted={}", player.getUUID(), enchanted);
                  NEXT_ALLOWED.put(player.getUUID(), now + 1200L);
                  return;
               }
            }

            if (player.hasEffect(MobEffects.POISON) || player.hasEffect(MobEffects.WITHER)) {
               int slot = findSlot(p, Items.MILK_BUCKET);
               if (slot >= 0) {
                  player.removeAllEffects();
                  p.armSlots[slot] = new ItemStack(Items.BUCKET);
                  SymbioteTracker.get(level).setDirty();
                  ModNetwork.syncToPlayer(level, player);
                  level.playSound(null, player.getX(), player.getY() + 1.0, player.getZ(), SoundEvents.GENERIC_DRINK, SoundSource.PLAYERS, 1.0F, 0.9F);
                  VoiceLines.send(player, "symbiote.voice.arm_instinct", 4);
                  SymbioteLog.event("ARM_INSTINCT player={} used=milk", player.getUUID());
                  NEXT_ALLOWED.put(player.getUUID(), now + 1200L);
               }
            }
         }
      }
   }

   private static void consume(ServerPlayer player, ServerLevel level, SymbioteProfile p, int slot) {
      p.armSlots[slot].shrink(1);
      if (p.armSlots[slot].isEmpty()) {
         p.armSlots[slot] = ItemStack.EMPTY;
      }

      SymbioteTracker.get(level).setDirty();
      ModNetwork.syncToPlayer(level, player);
   }

   private static int findSlot(SymbioteProfile p, Item item) {
      for (int i = 0; i < p.armSlotCount(); i++) {
         if (!p.armSlots[i].isEmpty() && p.armSlots[i].is(item)) {
            return i;
         }
      }

      return -1;
   }

   public static void onLogout(UUID player) {
      NEXT_ALLOWED.remove(player);
   }

   private ArmInstincts() {
   }
}
