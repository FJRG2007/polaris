package com.scout.symbiote.ability;

import com.scout.symbiote.util.ItemCompat;
import net.minecraft.core.registries.BuiltInRegistries;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Rarity;
import net.minecraft.world.item.TridentItem;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.entity.RandomizableContainerBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.neoforged.neoforge.common.Tags.Items;

public final class ChestCuriosity {
   private static final double CHEST_RANGE = 4.0;
   private static final int RAID_COOLDOWN = 4800;
   private static final double PLAYER_CHEST_CHANCE = 0.3;
   private static final double SORT_CHANCE = 0.4;
   private static final double STEAL_CHANCE = 0.35;
   private static final int MAX_LOOT_TAKEN = 3;
   private static final Map<UUID, ChestCuriosity.Raid> ACTIVE = new HashMap<>();
   private static final Map<UUID, Long> LAST_RAID = new HashMap<>();

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      ChestCuriosity.Raid raid = ACTIVE.get(player.getUUID());
      if (raid != null) {
         tickRaid(player, level, p, now, raid);
      } else {
         maybeStart(player, level, p, now);
      }
   }

   private static void maybeStart(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (p.instabilityUntilTick <= now) {
         if (now - LAST_RAID.getOrDefault(player.getUUID(), 0L) >= 4800L) {
            if (!CombatSense.inCombat(player)) {
               if (!WalkSeizure.isActive(player.getUUID())
                  && !DeepSeizure.isActive(player.getUUID())
                  && !SymbioteCuriosity.isStaring(player.getUUID())
                  && !TendrilSceneController.isInScene(player.getUUID())) {
                  List<BlockPos> lootChests = new ArrayList<>();
                  List<BlockPos> playerChests = new ArrayList<>();
                  int r = (int)Math.ceil(4.0);

                  for (BlockPos pos : BlockPos.betweenClosed(player.blockPosition().offset(-r, -1, -r), player.blockPosition().offset(r, 2, r))) {
                     if (level.getBlockEntity(pos) instanceof ChestBlockEntity chest
                        && !(pos.distToCenterSqr(player.getX(), player.getY(), player.getZ()) > 16.0)
                        && canActuallySee(player, level, pos)) {
                        if (!chest.saveWithoutMetadata(level.registryAccess()).contains("LootTable") && !chest.getPersistentData().getBoolean("symbiote_natural")) {
                           playerChests.add(pos.immutable());
                        } else {
                           lootChests.add(pos.immutable());
                        }
                     }
                  }

                  Comparator<BlockPos> byDist = Comparator.comparingDouble(pos -> pos.distToCenterSqr(player.getX(), player.getY(), player.getZ()));
                  if (!lootChests.isEmpty()) {
                     lootChests.sort(byDist);
                     startRaid(player, level, p, now, lootChests.get(0), true);
                  } else if (now - p.lastCuriosityTick >= SymbioteConfig.CURIOSITY_MIN_GAP_TICKS.get().intValue()) {
                     List<BlockPos> filled = new ArrayList<>();

                     for (BlockPos pos : playerChests) {
                        if (level.getBlockEntity(pos) instanceof ChestBlockEntity c && !c.isEmpty()) {
                           filled.add(pos);
                        }
                     }

                     if (!filled.isEmpty()) {
                        filled.sort(byDist);
                        if (playerChests.size() >= 2 && level.random.nextDouble() < 0.4) {
                           BlockPos a = filled.get(0);
                           playerChests.sort(byDist);
                           BlockPos b = null;

                           for (BlockPos cand : playerChests) {
                              if (!cand.equals(a) && cand.distManhattan(a) >= 2) {
                                 b = cand;
                                 break;
                              }
                           }

                           if (b != null) {
                              p.lastCuriosityTick = now;
                              SymbioteTracker.get(level).setDirty();
                              startSort(player, level, p, now, a, b);
                              return;
                           }
                        }

                        if (!(level.random.nextDouble() > 0.3)) {
                           p.lastCuriosityTick = now;
                           SymbioteTracker.get(level).setDirty();
                           startRaid(player, level, p, now, filled.get(0), false);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void startRaid(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, BlockPos chest, boolean loot) {
      ChestCuriosity.Raid raid = new ChestCuriosity.Raid();
      raid.chest = chest;
      raid.endTick = now + 60L + level.random.nextInt(41);
      raid.loot = loot;
      ACTIVE.put(player.getUUID(), raid);
      LAST_RAID.put(player.getUUID(), now);
      openWithTendril(player, level, p, chest, (int)(raid.endTick - now) + 16);
      if (!loot) {
         VoiceLines.send(player, "symbiote.voice.chest_curious", 0);
      }

      SymbioteLog.event("CHEST_RAID_START player={} chest={} loot={}", player.getUUID(), chest, loot);
   }

   private static void startSort(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, BlockPos a, BlockPos b) {
      ChestCuriosity.Raid raid = new ChestCuriosity.Raid();
      raid.chest = a;
      raid.chestB = b;
      raid.openBTick = now + 30L;
      raid.endTick = now + 90L + level.random.nextInt(31);
      ACTIVE.put(player.getUUID(), raid);
      LAST_RAID.put(player.getUUID(), now);
      openWithTendril(player, level, p, a, (int)(raid.endTick - now) + 16);
      SymbioteLog.event("CHEST_SORT_START player={} a={} b={}", player.getUUID(), a, b);
   }

   private static void openWithTendril(ServerPlayer player, ServerLevel level, SymbioteProfile p, BlockPos chest, int tendrilLife) {
      if (TendrilMantle.timedJob(player, level, Vec3.atCenterOf(chest).add(0.0, 0.45, 0.0), 8, Math.max(20, tendrilLife - 26), 2, ItemStack.EMPTY)
         == null) {
         TendrilFxEntity.spawnGrabAtPoint(level, player, Vec3.atCenterOf(chest).add(0.0, 0.45, 0.0), tendrilLife, p.strain);
      }

      level.blockEvent(chest, level.getBlockState(chest).getBlock(), 1, 1);
      level.playSound(null, chest, SoundEvents.CHEST_OPEN, SoundSource.BLOCKS, 0.7F, 0.9F);
   }

   private static void tickRaid(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now, ChestCuriosity.Raid raid) {
      boolean broken = !(level.getBlockEntity(raid.chest) instanceof ChestBlockEntity)
         || raid.chestB != null && !(level.getBlockEntity(raid.chestB) instanceof ChestBlockEntity);
      if (!broken && !(player.distanceToSqr(Vec3.atCenterOf(raid.chest)) > 64.0)) {
         if (raid.chestB != null && !raid.openedB && now >= raid.openBTick) {
            raid.openedB = true;
            openWithTendril(player, level, p, raid.chestB, (int)(raid.endTick - now) + 16);
         }

         if (now >= raid.endTick) {
            ACTIVE.remove(player.getUUID());
            if (raid.chestB != null) {
               finishSort(player, level, p, raid);
            } else {
               ChestBlockEntity chest = (ChestBlockEntity)level.getBlockEntity(raid.chest);
               List<ItemStack> taken = new ArrayList<>();
               if (raid.loot) {
                  chest.getPersistentData().putBoolean("symbiote_natural", true);
                  chest.unpackLootTable(player);
                  taken.addAll(takeLoot(chest, level, p));
               } else {
                  if (maybeStealTool(player, level, p, chest)) {
                     closeLid(level, raid.chest);
                     SymbioteLog.event("CHEST_RAID_DONE player={} chest={} loot=false stolen_tool=true", player.getUUID(), raid.chest);
                     return;
                  }

                  ItemStack one = takeOneCurio(chest, level, p);
                  if (!one.isEmpty()) {
                     taken.add(one);
                  }
               }

               for (ItemStack s : taken) {
                  if (!player.getInventory().add(s)) {
                     player.drop(s, false);
                  }
               }

               closeLid(level, raid.chest);
               if (!taken.isEmpty()) {
                  level.playSound(null, player.getX(), player.getY(), player.getZ(), SoundEvents.ITEM_PICKUP, SoundSource.PLAYERS, 0.7F, 0.9F);
                  VoiceLines.send(player, raid.loot ? "symbiote.voice.chest_loot" : "symbiote.voice.chest_take", 0);
               }

               SymbioteLog.event("CHEST_RAID_DONE player={} chest={} loot={} taken={}", player.getUUID(), raid.chest, raid.loot, taken.size());
            }
         }
      } else {
         closeLid(level, raid.chest);
         if (raid.chestB != null && raid.openedB) {
            closeLid(level, raid.chestB);
         }

         ACTIVE.remove(player.getUUID());
         SymbioteLog.event("CHEST_RAID_ABORT player={} chest={}", player.getUUID(), raid.chest);
      }
   }

   private static void finishSort(ServerPlayer player, ServerLevel level, SymbioteProfile p, ChestCuriosity.Raid raid) {
      ChestBlockEntity a = (ChestBlockEntity)level.getBlockEntity(raid.chest);
      ChestBlockEntity b = (ChestBlockEntity)level.getBlockEntity(raid.chestB);
      int moved = 0;
      if (moveOneStack(a, b, level)) {
         moved++;
      }

      if (level.random.nextBoolean() && moveOneStack(b, a, level)) {
         moved++;
      }

      boolean stole = maybeStealTool(player, level, p, a) || maybeStealTool(player, level, p, b);
      closeLid(level, raid.chestB);
      closeLid(level, raid.chest);
      if (moved > 0 && !stole) {
         level.playSound(null, player.getX(), player.getY(), player.getZ(), SoundEvents.ITEM_PICKUP, SoundSource.PLAYERS, 0.6F, 0.8F);
         VoiceLines.send(player, "symbiote.voice.chest_sort", 0);
      }

      SymbioteLog.event("CHEST_SORT_DONE player={} a={} b={} moved={} stole={}", player.getUUID(), raid.chest, raid.chestB, moved, stole);
   }

   private static boolean maybeStealTool(ServerPlayer player, ServerLevel level, SymbioteProfile p, RandomizableContainerBlockEntity chest) {
      if (p.stolenArmSlot >= 0) {
         return false;
      }

      int usable = p.armSlotCount();
      if (usable <= 0) {
         return false;
      }

      int free = -1;

      for (int i = 0; i < usable; i++) {
         if (p.armSlots[i].isEmpty()) {
            free = i;
            break;
         }
      }

      if (free < 0) {
         return false;
      }

      List<Integer> tools = new ArrayList<>();

      for (int i = 0; i < chest.getContainerSize(); i++) {
         Item it = chest.getItem(i).getItem();
         if (ItemCompat.isTiered(chest.getItem(i)) || it instanceof TridentItem) {
            tools.add(i);
         }
      }

      if (!tools.isEmpty() && !(level.random.nextDouble() > 0.35)) {
         ItemStack tool = chest.removeItemNoUpdate(tools.get(level.random.nextInt(tools.size())));
         chest.setChanged();
         p.armSlots[free] = tool;
         p.stolenArmSlot = free;
         p.stolenArmItem = BuiltInRegistries.ITEM.getKey(tool.getItem()).toString();
         SymbioteTracker.get(level).setDirty();
         ModNetwork.syncToPlayer(level, player);
         VoiceLines.send(player, "symbiote.voice.chest_steal", 3);
         SymbioteLog.event("CHEST_STEAL player={} item={} slot={}", player.getUUID(), p.stolenArmItem, free);
         return true;
      } else {
         return false;
      }
   }

   private static boolean moveOneStack(RandomizableContainerBlockEntity from, RandomizableContainerBlockEntity to, ServerLevel level) {
      List<Integer> filled = new ArrayList<>();

      for (int i = 0; i < from.getContainerSize(); i++) {
         if (!from.getItem(i).isEmpty()) {
            filled.add(i);
         }
      }

      if (filled.isEmpty()) {
         return false;
      }

      int empty = -1;

      for (int i = 0; i < to.getContainerSize(); i++) {
         if (to.getItem(i).isEmpty()) {
            empty = i;
            break;
         }
      }

      if (empty < 0) {
         return false;
      }

      to.setItem(empty, from.removeItemNoUpdate(filled.get(level.random.nextInt(filled.size()))));
      from.setChanged();
      to.setChanged();
      return true;
   }

   private static List<ItemStack> takeLoot(RandomizableContainerBlockEntity chest, ServerLevel level, SymbioteProfile p) {
      List<Integer> slots = new ArrayList<>();

      for (int i = 0; i < chest.getContainerSize(); i++) {
         if (!chest.getItem(i).isEmpty()) {
            slots.add(i);
         }
      }

      slots.sort((a, b) -> Integer.compare(score(chest.getItem(b), p), score(chest.getItem(a), p)));
      List<ItemStack> taken = new ArrayList<>();

      while (taken.size() < 2 && !slots.isEmpty()) {
         taken.add(chest.removeItemNoUpdate(slots.remove(0)));
      }

      if (!slots.isEmpty() && taken.size() < 3) {
         taken.add(chest.removeItemNoUpdate(slots.get(level.random.nextInt(slots.size()))));
      }

      chest.setChanged();
      return taken;
   }

   private static ItemStack takeOneCurio(RandomizableContainerBlockEntity chest, ServerLevel level, SymbioteProfile p) {
      List<Integer> slots = new ArrayList<>();

      for (int i = 0; i < chest.getContainerSize(); i++) {
         if (!chest.getItem(i).isEmpty()) {
            slots.add(i);
         }
      }

      if (slots.isEmpty()) {
         return ItemStack.EMPTY;
      }

      int bestScore = -1;
      List<Integer> best = new ArrayList<>();

      for (int i : slots) {
         int sc = score(chest.getItem(i), p);
         if (sc > bestScore) {
            bestScore = sc;
            best.clear();
            best.add(i);
         } else if (sc == bestScore) {
            best.add(i);
         }
      }

      int slot = best.get(level.random.nextInt(best.size()));
      ItemStack one = chest.removeItem(slot, 1);
      chest.setChanged();
      return one;
   }

   private static int score(ItemStack s, SymbioteProfile p) {
      if (p != null && p.hunger < 50 && ItemCompat.isEdible(s)) {
         return 4;
      } else if (s.isEnchanted() || s.getRarity() != Rarity.COMMON) {
         return 3;
      } else {
         return !s.is(Items.GEMS)
               && !s.is(Items.INGOTS)
               && !s.is(Items.STORAGE_BLOCKS)
               && !s.is(Items.ORES)
               && !s.is(net.minecraft.world.item.Items.NETHERITE_SCRAP)
               && !s.is(net.minecraft.world.item.Items.GOLDEN_APPLE)
               && !s.is(net.minecraft.world.item.Items.DIAMOND)
               && !s.is(net.minecraft.world.item.Items.EMERALD)
            ? 1
            : 2;
      }
   }

   private static boolean canActuallySee(ServerPlayer player, ServerLevel level, BlockPos pos) {
      BlockHitResult hit = level.clip(new ClipContext(player.getEyePosition(), Vec3.atCenterOf(pos), Block.COLLIDER, Fluid.NONE, player));
      return hit.getType() == Type.MISS || hit.getBlockPos().equals(pos);
   }

   private static void closeLid(ServerLevel level, BlockPos pos) {
      BlockState state = level.getBlockState(pos);
      if (level.getBlockEntity(pos) instanceof ChestBlockEntity) {
         level.blockEvent(pos, state.getBlock(), 1, 0);
         level.playSound(null, pos, SoundEvents.CHEST_CLOSE, SoundSource.BLOCKS, 0.7F, 0.9F);
      }
   }

   public static void abortForEmergency(ServerPlayer player, ServerLevel level, long now, String reason) {
      ChestCuriosity.Raid raid = ACTIVE.remove(player.getUUID());
      if (raid != null) {
         closeLid(level, raid.chest);
         if (raid.chestB != null && raid.openedB) {
            closeLid(level, raid.chestB);
         }

         LAST_RAID.put(player.getUUID(), now);
         SymbioteLog.event("CHEST_RAID_ABORT player={} reason={}", player.getUUID(), reason);
      }
   }

   public static void onLogout(ServerPlayer player, ServerLevel level) {
      ChestCuriosity.Raid raid = ACTIVE.remove(player.getUUID());
      if (raid != null) {
         closeLid(level, raid.chest);
         if (raid.chestB != null && raid.openedB) {
            closeLid(level, raid.chestB);
         }
      }

      LAST_RAID.remove(player.getUUID());
   }

   private ChestCuriosity() {
   }

   private static final class Raid {
      BlockPos chest;
      long endTick;
      boolean loot;
      BlockPos chestB;
      long openBTick;
      boolean openedB;
   }
}
