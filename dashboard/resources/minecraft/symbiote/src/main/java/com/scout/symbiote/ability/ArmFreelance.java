package com.scout.symbiote.ability;

import com.scout.symbiote.util.ItemCompat;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.override.DrowningSave;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.HostileTargets;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeModifier.Operation;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.common.Tags.Blocks;

public final class ArmFreelance {
   private static final int ACT_GAP_TICKS = 400;
   private static final double BASE_CHANCE = 0.12;
   private static final Map<UUID, Long> NEXT_ALLOWED = new HashMap<>();
   private static final Map<UUID, Long> STARVE_SINCE = new HashMap<>();
   private static final int BAG_PATIENCE_TICKS = 1200;
   public static final boolean CONTRABAND_VAULTED = true;
   private static final int CONTRABAND_TAKE_STRESS = 70;
   private static final int CONTRABAND_RELEASE_STRESS = 35;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (SymbioteConfig.ARMS_ENABLED.get()) {
         if (p.stage.isAtLeast(BondStage.COOPERATIVE)) {
            if (p.isStarving()) {
               STARVE_SINCE.putIfAbsent(player.getUUID(), now);
            } else {
               STARVE_SINCE.remove(player.getUUID());
            }

            tickContrabandReturn(player, level, p, now);
            if (!SymbioteMolt.isMolting(p, now)) {
               MoodEngine.Mood mood = MoodEngine.current(p);
               if (mood != MoodEngine.Mood.GRIEVING) {
                  if (now >= NEXT_ALLOWED.getOrDefault(player.getUUID(), 0L)) {
                     if (!bodyBusy(player)) {
                        double chance = 0.12 * StrainTraits.freelanceMult(p.strain, level.isNight());
                        if (p.stage == BondStage.DOMINANT) {
                           chance *= 1.5;
                        }

                        if (!(Math.random() > chance)) {
                           boolean tier2 = p.stage == BondStage.DOMINANT && (mood == MoodEngine.Mood.COILED || p.isStarving());
                           LivingEntity threat = nearestThreat(player, level, p);
                           if (threat != null) {
                              int slot = SymbioteArmsController.pickWeaponSlot(p);
                              if (slot >= 0 && SymbioteArmsController.beginMelee(player, p, slot, threat)) {
                                 stamp(player, now);
                                 SymbioteLog.event("ARM_FREELANCE player={} act=swat target={} tier2={}", player.getUUID(), threat.getType(), tier2);
                              }
                           } else {
                              boolean bagAllowed = !p.isStarving() || now - STARVE_SINCE.getOrDefault(player.getUUID(), now) >= 1200L;
                              if (tier2 && p.hunger < 40 && bagAllowed && stealFood(player, level, p)) {
                                 stamp(player, now);
                              } else if (tier2 && takeContraband(player, level, p, now)) {
                                 stamp(player, now);
                              } else {
                                 if (!p.isStarving() && !CombatSense.inCombat(player) && mineWalkedPastOre(player, level, p)) {
                                    stamp(player, now);
                                 }
                              }
                           }
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static boolean takeContraband(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      return false;
   }

   public static void tickContrabandReturn(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.contrabandSlot >= 0) {
         int slot = p.contrabandSlot;
         ItemStack held = slot < p.armSlots.length ? p.armSlots[slot] : ItemStack.EMPTY;
         boolean gone = held.isEmpty();
         boolean heldLongEnough = now - p.contrabandTakenTick >= 6000L;
         boolean release = gone || heldLongEnough && (p.stress <= 35 || now - p.contrabandTakenTick > 48000L);
         if (release) {
            p.contrabandSlot = -1;
            p.contrabandTakenTick = 0L;
            if (!gone) {
               p.armSlots[slot] = ItemStack.EMPTY;
               if (!player.getInventory().add(held)) {
                  player.drop(held, false);
               }

               VoiceLines.send(player, "symbiote.voice.arm_contraband_return", 0);
            }

            SymbioteTracker.get(level).setDirty();
            ModNetwork.syncToPlayer(level, player);
            SymbioteLog.event("ARM_CONTRABAND_RELEASED player={} returned={}", player.getUUID(), !gone);
         }
      }
   }

   private static double toolValue(ItemStack s) {
      if (s.isEmpty()) {
         return 0.0;
      }

      double v = 0.0;

      v += ItemCompat.flatAttackDamage(s);

      v += ItemCompat.tierSpeed(s) * 0.5;

      return v + s.getEnchantments().size() * 2.0;
   }

   private static void stamp(ServerPlayer player, long now) {
      NEXT_ALLOWED.put(player.getUUID(), now + 400L);
   }

   private static boolean bodyBusy(ServerPlayer player) {
      UUID id = player.getUUID();
      return WalkSeizure.isActive(id)
         || DeepSeizure.isActive(id)
         || TendrilSceneController.isInScene(id)
         || SymbioteFeedingHunt.isHunting(id)
         || FirePanicEscape.isActive(id)
         || SymbioteCuriosity.isStaring(id)
         || DrowningSave.isActive(id);
   }

   private static LivingEntity nearestThreat(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      double range = switch (p.strain) {
         case PREDATOR -> 7.0;
         default -> 5.0;
      };
      LivingEntity best = null;
      double bestSq = Double.MAX_VALUE;

      for (LivingEntity e : level.getEntitiesOfClass(
         LivingEntity.class,
         player.getBoundingBox().inflate(range),
         en -> en != player && en.isAlive() && en instanceof Enemy && HostileTargets.mayOpenOn(en, player) && player.hasLineOfSight(en)
      )) {
         boolean comingForHost = e instanceof Mob m && m.getTarget() == player;

         boolean eligible = switch (p.strain) {
            case PREDATOR -> true;
            case GUARDIAN -> comingForHost;
            default -> comingForHost || e.distanceToSqr(player) < 12.25;
         };
         if (eligible) {
            double d = e.distanceToSqr(player);
            if (d < bestSq) {
               bestSq = d;
               best = e;
            }
         }
      }

      return best;
   }

   private static boolean stealFood(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      Inventory inv = player.getInventory();
      int foodStacks = 0;
      int target = -1;

      for (int i = 0; i < inv.getContainerSize(); i++) {
         ItemStack s = inv.getItem(i);
         if (!s.isEmpty()) {
            if (ItemCompat.isEdible(s)) {
               foodStacks++;
            }

            if (target < 0 && Feeding.isSymbioteFood(s)) {
               target = i;
            }
         }
      }

      if (target < 0) {
         return false;
      }

      ItemStack stack = inv.getItem(target);
      if (foodStacks <= 1 && stack.getCount() <= 1 && ItemCompat.isEdible(stack)) {
         return false;
      }

      stack.shrink(1);
      int gained = SymbioteConfig.HUNGER_PER_RAW_MEAT.get();
      SymbioteTracker.adjustHunger(level, player, gained, "hunger_arm_steal");
      level.playSound(null, player.getX(), player.getY() + 1.0, player.getZ(), SoundEvents.GENERIC_EAT, SoundSource.PLAYERS, 0.9F, 0.8F);
      VoiceLines.send(player, "symbiote.voice.arm_food_steal", 3);
      SymbioteLog.event("ARM_FREELANCE player={} act=food_steal item={} hunger+={}", player.getUUID(), stack.getItem(), gained);
      return true;
   }

   private static boolean mineWalkedPastOre(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      int r = p.strain == SymbioteStrain.SCULK ? 5 : 3;
      BlockPos center = player.blockPosition();

      for (BlockPos pos : BlockPos.betweenClosed(center.offset(-r, -1, -r), center.offset(r, 2, r))) {
         BlockState state = level.getBlockState(pos);
         if (state.is(Blocks.ORES)) {
            for (int slot = 0; slot < p.armSlotCount(); slot++) {
               ItemStack tool = p.armSlots[slot];
               if (!tool.isEmpty() && tool.isCorrectToolForDrops(state) && SymbioteArmsController.beginMining(player, p, slot, pos.immutable())) {
                  SymbioteLog.event("ARM_FREELANCE player={} act=ore pos={}", player.getUUID(), pos);
                  return true;
               }
            }
         }
      }

      return false;
   }

   public static void onLogout(UUID player) {
      NEXT_ALLOWED.remove(player);
      STARVE_SINCE.remove(player);
   }

   private ArmFreelance() {
   }
}
