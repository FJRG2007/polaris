package com.scout.symbiote.ability;

import net.minecraft.world.damagesource.DamageSource;
import com.scout.symbiote.util.ItemCompat;
import net.minecraft.core.registries.BuiltInRegistries;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Map.Entry;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeModifier.Operation;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;

public final class SymbioteArmsController {
   public static final double TENDRIL_RANGE = 7.0;
   private static final int MELEE_HIT_TICK = 7;
   private static final int MELEE_DONE_TICK = 12;
   private static final int MINING_TICKS_MIN = 11;
   private static final int MINING_TICKS_MAX = 120;
   public static final int ARM_COOLDOWN_TICKS = 6;
   private static final int VEIN_SPAWN_STAGGER = 2;
   private static final int VEIN_STAGGER = 7;
   private static final int PLACE_REACH_TICK = 6;
   private static final int PLACE_DONE_TICK = 9;
   private static final int WALL_JOB_TTL = 60;
   private static final Map<UUID, SymbioteArmsController.PlayerArms> PLAYERS = new HashMap<>();
   private static final int VEIN_ALL_BUSY = -2;

   private static SymbioteArmsController.PlayerArms arms(UUID id) {
      return PLAYERS.computeIfAbsent(id, k -> new SymbioteArmsController.PlayerArms());
   }

   public static boolean isBusy(UUID player) {
      SymbioteArmsController.PlayerArms pa = PLAYERS.get(player);
      return pa != null && !pa.actions.isEmpty();
   }

   private static int activeCount(UUID player) {
      SymbioteArmsController.PlayerArms pa = PLAYERS.get(player);
      return pa == null ? 0 : pa.actions.size();
   }

   private static int maxTendrils(SymbioteProfile p) {
      int base = p.stage == BondStage.DOMINANT ? 5 : 3;
      return p.strain == SymbioteStrain.ROYAL ? base + 1 : base;
   }

   public static boolean beginMelee(ServerPlayer player, SymbioteProfile p, int slot, LivingEntity target) {
      if (SymbioteFeedingHunt.isHunting(player.getUUID())) {
         return false;
      }

      if (!validate(player, p, slot, target.position())) {
         return false;
      }

      ItemStack weapon = p.armSlots[slot];
      if (!isWeapon(weapon)) {
         return false;
      }

      long now = player.serverLevel().getGameTime();
      Vec3 aim = target.position().add(0.0, target.getBbHeight() * 0.5, 0.0);
      TendrilFxEntity fx = TendrilMantle.timedJob(player, player.serverLevel(), aim, 7, 5, 2, weapon.copy());
      if (fx == null) {
         float spread = player.getRandom().nextFloat() * (float) (Math.PI * 2);
         fx = TendrilFxEntity.spawnArm(player.serverLevel(), player, aim, 22, p.strain, 2, 7, spread, weapon.copy());
      }

      arms(player.getUUID())
         .actions
         .add(new SymbioteArmsController.ArmAction(player.getUUID(), slot, now, fx.getId(), false, target.getId(), null, 0, false, false, null));
      p.lastArmActionTick[slot] = now;
      SymbioteLog.event("ARMS_MELEE player={} slot={} target={}", player.getUUID(), slot, target.getType());
      return true;
   }

   public static boolean beginMining(ServerPlayer player, SymbioteProfile p, int slot, BlockPos pos) {
      if (CombatSense.inCombat(player)) {
         SymbioteLog.event("ARMS_MINE_SKIPPED player={} reason=in_combat", player.getUUID());
         return false;
      }

      if (!validate(player, p, slot, Vec3.atCenterOf(pos))) {
         return false;
      }

      if (!canReachBlock(player.serverLevel(), player, pos)) {
         SymbioteLog.event("ARMS_MINE_SKIPPED player={} reason=blocked", player.getUUID());
         return false;
      }

      if (!startMiningAction(player, p, slot, pos, false)) {
         return false;
      }

      p.lastArmActionTick[slot] = player.serverLevel().getGameTime();
      return true;
   }

   public static void enqueueVein(ServerPlayer player, SymbioteProfile p, int slot, List<BlockPos> blocks) {
      if (!blocks.isEmpty()) {
         SymbioteArmsController.PlayerArms pa = arms(player.getUUID());
         pa.veinSlot = slot;
         pa.veinBlockedSince = -1L;

         for (BlockPos b : blocks) {
            pa.veinQueue.add(b.immutable());
         }

         SymbioteLog.event("ARMS_VEIN player={} slot={} blocks={}", player.getUUID(), slot, blocks.size());
      }
   }

   private static int freeVeinSlotFor(BlockState state, SymbioteProfile p, SymbioteArmsController.PlayerArms pa) {
      boolean anySuitable = false;

      for (int i = 0; i < p.armSlotCount(); i++) {
         if (i != p.contrabandSlot) {
            ItemStack tool = p.armSlots[i];
            if (!tool.isEmpty() && tool.isCorrectToolForDrops(state)) {
               anySuitable = true;
               int slot = i;
               if (pa.actions.stream().noneMatch(a -> a.vein && a.slot == slot)) {
                  return i;
               }
            }
         }
      }

      return anySuitable ? -2 : -1;
   }

   private static boolean startMiningAction(ServerPlayer player, SymbioteProfile p, int slot, BlockPos pos, boolean vein) {
      ServerLevel level = player.serverLevel();
      BlockState state = level.getBlockState(pos);
      if (state.isAir()) {
         return false;
      }

      ItemStack tool = slot >= 0 && slot < p.armSlots.length ? p.armSlots[slot] : ItemStack.EMPTY;
      if (tool.isEmpty()) {
         return false;
      }

      int ticks = miningTicks(tool, state, level, pos);
      if (ticks <= 0) {
         return false;
      }

      long now = level.getGameTime();
      int reach = Math.min(14, Math.max(7, ticks * 2 / 3));
      TendrilFxEntity fx = TendrilMantle.timedJob(player, level, Vec3.atCenterOf(pos), reach, Math.max(0, ticks - reach), 1, tool.copy());
      if (fx == null) {
         float spread = player.getRandom().nextFloat() * (float) (Math.PI * 2);
         fx = TendrilFxEntity.spawnArm(level, player, Vec3.atCenterOf(pos), ticks + 12, p.strain, 1, reach, spread, tool.copy());
      }

      arms(player.getUUID())
         .actions
         .add(new SymbioteArmsController.ArmAction(player.getUUID(), slot, now, fx.getId(), true, 0, pos.immutable(), ticks, vein, false, null));
      SymbioteLog.event("ARMS_MINE player={} slot={} pos={} ticks={} vein={}", player.getUUID(), slot, pos, ticks, vein);
      return true;
   }

   public static void enqueueWall(ServerPlayer player, List<BlockPos> positions, Item blockItem) {
      enqueueWall(player, positions, blockItem, false);
   }

   public static void enqueueWall(ServerPlayer player, List<BlockPos> positions, Item blockItem, boolean fast) {
      if (!positions.isEmpty() && blockItem != null) {
         SymbioteArmsController.PlayerArms pa = arms(player.getUUID());
         if (!pa.wallQueue.isEmpty() && pa.wallItem != null && pa.wallItem != blockItem) {
            if (!fast) {
               SymbioteLog.event(
                  "ARMS_WALL_YIELD player={} kept={} refused={}",
                  player.getUUID(),
                  BuiltInRegistries.ITEM.getKey(pa.wallItem),
                  BuiltInRegistries.ITEM.getKey(blockItem)
               );
               return;
            }

            SymbioteLog.event(
               "ARMS_WALL_FLUSH player={} dropped={} for={}",
               player.getUUID(),
               BuiltInRegistries.ITEM.getKey(pa.wallItem),
               BuiltInRegistries.ITEM.getKey(blockItem)
            );
            pa.wallQueue.clear();
         }

         pa.wallItem = blockItem;
         pa.wallFast = fast;
         pa.wallQueuedAt = player.level().getGameTime();

         for (BlockPos b : positions) {
            pa.wallQueue.add(b.immutable());
         }

         SymbioteLog.event("ARMS_WALL player={} block={} count={} fast={}", player.getUUID(), BuiltInRegistries.ITEM.getKey(blockItem), positions.size(), fast);
      }
   }

   private static boolean startPlaceAction(ServerPlayer player, SymbioteProfile p, BlockPos pos, Item blockItem, boolean fast) {
      ServerLevel level = player.serverLevel();
      if (!level.getBlockState(pos).canBeReplaced()) {
         return false;
      }

      long now = level.getGameTime();
      int reach = fast ? 2 : 6;
      int done = fast ? 4 : 9;
      TendrilFxEntity fx = TendrilMantle.timedJob(player, level, Vec3.atCenterOf(pos), reach, Math.max(0, done - reach), 3, new ItemStack(blockItem));
      if (fx == null) {
         float spread = player.getRandom().nextFloat() * (float) (Math.PI * 2);
         fx = TendrilFxEntity.spawnArm(level, player, Vec3.atCenterOf(pos), done + 10, p.strain, 3, reach, spread, new ItemStack(blockItem));
      }

      arms(player.getUUID())
         .actions
         .add(new SymbioteArmsController.ArmAction(player.getUUID(), -1, now, fx.getId(), false, 0, pos.immutable(), fast ? done : 0, false, true, blockItem));
      return true;
   }

   public static boolean maybeRetaliate(ServerPlayer player, SymbioteProfile p, LivingEntity attacker) {
      if (!SymbioteConfig.ARMS_ENABLED.get()) {
         return false;
      }

      if (player != null && p != null && attacker != null && attacker != player) {
         if (!(Boolean)SymbioteConfig.PROTECT_ALLIES.get()
            || !(attacker instanceof Player) && !(attacker instanceof TamableAnimal t && t.isTame()) && !attacker.hasCustomName()) {
            if (!p.stage.isBonded()) {
               return false;
            }

            if (isBusy(player.getUUID())) {
               return false;
            }

            if (!attacker.isAlive()) {
               return false;
            }

            double base = SymbioteConfig.ARMS_RETALIATE_CHANCE.get();
            if (base <= 0.0) {
               return false;
            }

            double chance = base * retaliateAggression(p.strain);
            if (player.getRandom().nextDouble() >= chance) {
               return false;
            }

            int slot = pickWeaponSlot(p);
            if (slot < 0) {
               return false;
            }

            double d = player.getEyePosition().distanceTo(attacker.position().add(0.0, attacker.getBbHeight() * 0.5, 0.0));
            if (d > 8.0) {
               return false;
            }

            if (!player.hasLineOfSight(attacker)) {
               return false;
            }

            boolean fired = beginMelee(player, p, slot, attacker);
            if (fired) {
               VoiceLines.send(player, "symbiote.voice.retaliate", 3);
            }

            return fired;
         } else {
            return false;
         }
      } else {
         return false;
      }
   }

   public static double retaliateAggression(SymbioteStrain s) {
      return switch (s) {
         case ROYAL -> 1.4;
         case PREDATOR -> 1.35;
         case GUARDIAN -> 1.2;
         case SHADOW -> 1.0;
         case SCULK -> 0.9;
      };
   }

   private static boolean validate(ServerPlayer player, SymbioteProfile p, int slot, Vec3 targetPos) {
      if (!SymbioteConfig.ARMS_ENABLED.get()) {
         return false;
      }

      if (player == null || p == null || !p.stage.isBonded()) {
         return false;
      }

      if (player.isCreative() || player.isSpectator()) {
         return false;
      }

      if (slot < 0 || slot >= p.armSlotCount()) {
         return false;
      }

      if (p.armSlots[slot].isEmpty()) {
         return false;
      }

      if (activeCount(player.getUUID()) >= maxTendrils(p)) {
         return false;
      }

      long now = player.serverLevel().getGameTime();
      if (now - p.lastArmActionTick[slot] < 6L) {
         return false;
      }

      double d = player.getEyePosition().distanceTo(targetPos);
      return d <= 8.0;
   }

   public static void tickAll(ServerLevel level) {
      long now = level.getGameTime();
      Iterator<Entry<UUID, SymbioteArmsController.PlayerArms>> pit = PLAYERS.entrySet().iterator();

      while (pit.hasNext()) {
         Entry<UUID, SymbioteArmsController.PlayerArms> e = pit.next();
         SymbioteArmsController.PlayerArms pa = e.getValue();
         ServerPlayer player = level.getServer().getPlayerList().getPlayer(e.getKey());
         if (player == null || !player.isAlive()) {
            cleanupAll(level, pa);
            pit.remove();
         } else if (player.serverLevel() == level) {
            SymbioteProfile p = SymbioteTracker.get(level).peek(e.getKey());
            if (p != null && p.stage.isBonded()) {
               Iterator<SymbioteArmsController.ArmAction> ait = pa.actions.iterator();

               while (ait.hasNext()) {
                  if (tickAction(level, player, p, ait.next(), now)) {
                     ait.remove();
                  }
               }

               if (!pa.veinQueue.isEmpty() && !CombatSense.inCombat(player)) {
                  if (pa.veinSlot < 0) {
                     pa.veinQueue.clear();
                     pa.veinSlot = -1;
                  } else if (now >= pa.nextSpawnTick && pa.actions.size() < maxTendrils(p)) {
                     BlockPos pos = pollReachable(level, player, pa.veinQueue);
                     if (pos != null) {
                        pa.veinBlockedSince = -1L;
                        int slot = freeVeinSlotFor(level.getBlockState(pos), p, pa);
                        if (slot >= 0) {
                           if (startMiningAction(player, p, slot, pos, true)) {
                              pa.nextSpawnTick = now + 7L;
                           }
                        } else if (slot == -2) {
                           pa.veinQueue.addFirst(pos);
                        } else {
                           SymbioteLog.event("ARMS_VEIN_NO_TOOL player={} dropped={}", player.getUUID(), pa.veinQueue.size() + 1);
                           pa.veinQueue.clear();
                        }
                     } else if (!pa.veinQueue.isEmpty() && pa.actions.isEmpty()) {
                        if (pa.veinBlockedSince < 0L) {
                           pa.veinBlockedSince = now;
                        } else if (now - pa.veinBlockedSince >= 40L) {
                           SymbioteLog.event("ARMS_VEIN_BLOCKED player={} dropped={}", player.getUUID(), pa.veinQueue.size());
                           pa.veinQueue.clear();
                        }
                     }

                     if (pa.veinQueue.isEmpty()) {
                        pa.veinSlot = -1;
                        pa.veinBlockedSince = -1L;
                     }
                  }
               }

               if (!pa.wallQueue.isEmpty()) {
                  if (now - pa.wallQueuedAt > 60L) {
                     SymbioteLog.event("ARMS_WALL_EXPIRED player={} dropped={}", player.getUUID(), pa.wallQueue.size());
                     pa.wallQueue.clear();
                     pa.wallItem = null;
                     pa.wallFast = false;
                  } else if (pa.wallItem == null || !armSlotsHaveBlock(p, pa.wallItem)) {
                     pa.wallQueue.clear();
                     pa.wallItem = null;
                     pa.wallFast = false;
                  } else if (now >= pa.nextSpawnTick && pa.actions.size() < maxTendrils(p)) {
                     BlockPos pos = pollPlaceable(level, player, pa.wallQueue);
                     if (pos != null && startPlaceAction(player, p, pos, pa.wallItem, pa.wallFast)) {
                        pa.nextSpawnTick = now + (pa.wallFast ? 1 : 2);
                     }

                     if (pa.wallQueue.isEmpty()) {
                        pa.wallItem = null;
                        pa.wallFast = false;
                     }
                  }
               }

               if (pa.actions.isEmpty() && pa.veinQueue.isEmpty() && pa.wallQueue.isEmpty()) {
                  pit.remove();
               }
            } else {
               cleanupAll(level, pa);
               pit.remove();
            }
         }
      }
   }

   private static BlockPos pollReachable(ServerLevel level, ServerPlayer player, Deque<BlockPos> queue) {
      Vec3 eye = player.getEyePosition();
      double maxSq = 72.25;
      int checks = queue.size();

      for (int i = 0; i < checks; i++) {
         BlockPos pos = queue.poll();
         if (!level.getBlockState(pos).isAir() && !(eye.distanceToSqr(Vec3.atCenterOf(pos)) > maxSq)) {
            if (canReachBlock(level, player, pos)) {
               return pos;
            }

            queue.addLast(pos);
         }
      }

      return null;
   }

   private static boolean canReachBlock(ServerLevel level, ServerPlayer player, BlockPos pos) {
      Vec3 eye = player.getEyePosition();
      Vec3 center = Vec3.atCenterOf(pos);
      if (rayHits(level, player, eye, center, pos)) {
         return true;
      }

      for (Direction direction : Direction.values()) {
         Vec3 face = center.add(direction.getStepX() * 0.501, direction.getStepY() * 0.501, direction.getStepZ() * 0.501);
         if (rayHits(level, player, eye, face, pos)) {
            return true;
         }
      }

      return false;
   }

   private static boolean rayHits(ServerLevel level, ServerPlayer player, Vec3 eye, Vec3 target, BlockPos pos) {
      BlockHitResult hit = level.clip(new ClipContext(eye, target, Block.COLLIDER, Fluid.NONE, player));
      return hit.getType() == Type.BLOCK && hit.getBlockPos().equals(pos);
   }

   private static BlockPos pollPlaceable(ServerLevel level, ServerPlayer player, Deque<BlockPos> queue) {
      Vec3 eye = player.getEyePosition();
      double maxSq = 72.25;

      while (!queue.isEmpty()) {
         BlockPos pos = queue.poll();
         if (level.getBlockState(pos).canBeReplaced() && !(eye.distanceToSqr(Vec3.atCenterOf(pos)) > maxSq)) {
            return pos;
         }
      }

      return null;
   }

   private static boolean armSlotsHaveBlock(SymbioteProfile p, Item item) {
      for (ItemStack s : p.armSlots) {
         if (s != null && !s.isEmpty() && s.getItem() == item) {
            return true;
         }
      }

      return false;
   }

   private static void placeWallBlock(ServerPlayer player, ServerLevel level, BlockPos pos, Item item, SymbioteProfile p) {
      if (item != null && level.getBlockState(pos).canBeReplaced()) {
         if (item instanceof BlockItem bi) {
            int slot = -1;

            for (int place = 0; place < p.armSlots.length; place++) {
               ItemStack s = p.armSlots[place];
               if (s != null && !s.isEmpty() && s.getItem() == item) {
                  slot = place;
                  break;
               }
            }

            if (slot >= 0) {
               BlockState place = bi.getBlock().defaultBlockState();
               if (level.setBlockAndUpdate(pos, place)) {
                  p.armSlots[slot].shrink(1);
                  if (p.armSlots[slot].isEmpty()) {
                     p.armSlots[slot] = ItemStack.EMPTY;
                  }

                  SymbioteTracker.get(level).setDirty();
                  ModNetwork.syncToPlayer(level, player);
                  SoundType st = place.getSoundType();
                  level.playSound(null, pos, st.getPlaceSound(), SoundSource.BLOCKS, (st.getVolume() + 1.0F) / 2.0F, st.getPitch() * 0.85F);
                  SymbioteLog.event("ARMS_WALL_PLACE player={} pos={}", player.getUUID(), pos);
               }
            }
         }
      }
   }

   private static boolean tickAction(ServerLevel level, ServerPlayer player, SymbioteProfile p, SymbioteArmsController.ArmAction a, long now) {
      long age = now - a.startTick;
      if (a.placing) {
         if (!level.getBlockState(a.block).canBeReplaced()) {
            retractFx(level, a);
            return true;
         } else {
            int doneTick = a.miningTicks > 0 ? a.miningTicks : 9;
            if (age >= doneTick && !a.executed) {
               a.executed = true;
               placeWallBlock(player, level, a.block, a.placeItem, p);
               retractFx(level, a);
               return true;
            } else {
               return false;
            }
         }
      } else {
         ItemStack item = a.slot >= 0 && a.slot < p.armSlots.length ? p.armSlots[a.slot] : ItemStack.EMPTY;
         if (item.isEmpty()) {
            cleanup(level, a);
            return true;
         }

         if (a.mining) {
            BlockState state = level.getBlockState(a.block);
            if (state.isAir()) {
               level.destroyBlockProgress(a.fxId, a.block, -1);
               retractFx(level, a);
               return true;
            }

            int stage = (int)Math.min(9L, age * 10L / Math.max(1, a.miningTicks));
            if (stage != a.lastStage) {
               level.destroyBlockProgress(a.fxId, a.block, stage);
               a.lastStage = stage;
               BlockState chip = level.getBlockState(a.block);
               level.playSound(null, a.block, chip.getSoundType().getHitSound(), SoundSource.BLOCKS, 0.5F, chip.getSoundType().getPitch() * 0.9F);
            }

            if (age >= a.miningTicks && !a.executed) {
               a.executed = true;
               breakBlock(player, level, a.block, item, p, a.vein);
               level.destroyBlockProgress(a.fxId, a.block, -1);
               retractFx(level, a);
               return true;
            } else {
               return false;
            }
         } else {
            LivingEntity target = level.getEntity(a.targetEntityId) instanceof LivingEntity le ? le : null;
            if (target != null && target.isAlive()) {
               if (age >= 7L && !a.executed) {
                  a.executed = true;
                  meleeStrike(player, target, item, p);
               }

               if (age >= 12L) {
                  retractFx(level, a);
                  return true;
               } else {
                  return false;
               }
            } else if (age >= 12L) {
               retractFx(level, a);
               return true;
            } else {
               return false;
            }
         }
      }
   }

   private static void meleeStrike(ServerPlayer player, LivingEntity target, ItemStack weapon, SymbioteProfile p) {
      ServerLevel level = player.serverLevel();
      double dmg = 1.0;

      dmg += ItemCompat.flatAttackDamage(weapon);

      DamageSource source = level.damageSources().playerAttack(player);
      dmg = EnchantmentHelper.modifyDamage(level, weapon, target, source, (float)dmg);
      target.invulnerableTime = 0;
      target.hurt(source, (float)dmg);
      int fire = ItemCompat.enchantmentLevel(level, Enchantments.FIRE_ASPECT, weapon);
      if (fire > 0) {
         target.igniteForSeconds(fire * 4);
      }

      int kb = ItemCompat.enchantmentLevel(level, Enchantments.KNOCKBACK, weapon);
      if (kb > 0) {
         Vec3 dir = target.position().subtract(player.position());
         target.knockback(kb * 0.5, -dir.x, -dir.z);
      }

      weapon.hurtAndBreak(1, level, player, item -> {});
      SymbioteTracker.get(level).setDirty();
   }

   private static void breakBlock(ServerPlayer player, ServerLevel level, BlockPos pos, ItemStack tool, SymbioteProfile p, boolean vein) {
      breakOne(player, level, pos, tool);
      tool.hurtAndBreak(1, level, player, item -> {});
      SymbioteTracker.get(level).setDirty();
      if (!vein) {
         double grief = griefChance(p.strain) * SymbioteConfig.ARMS_GRIEF_MULT.get();
         if (grief > 0.0 && player.getRandom().nextDouble() < grief) {
            for (Direction d : Direction.values()) {
               BlockPos adj = pos.relative(d);
               BlockState as = level.getBlockState(adj);
               if (!as.isAir() && as.getDestroySpeed(level, adj) >= 0.0F && tool.isCorrectToolForDrops(as)) {
                  breakOne(player, level, adj, tool);
                  SymbioteLog.event("ARMS_GRIEF player={} strain={} pos={}", player.getUUID(), p.strain, adj);
                  break;
               }
            }
         }
      }
   }

   private static void breakOne(ServerPlayer player, ServerLevel level, BlockPos pos, ItemStack tool) {
      BlockState state = level.getBlockState(pos);
      if (!state.isAir()) {
         BlockEntity be = level.getBlockEntity(pos);

         for (ItemStack drop : net.minecraft.world.level.block.Block.getDrops(state, level, pos, be, player, tool)) {
            if (!player.getInventory().add(drop)) {
               net.minecraft.world.level.block.Block.popResource(level, pos, drop);
            }
         }

         level.levelEvent(2001, pos, net.minecraft.world.level.block.Block.getId(state));
         level.removeBlock(pos, false);
      }
   }

   private static double griefChance(SymbioteStrain s) {
      return switch (s) {
         case ROYAL -> 0.07;
         case PREDATOR -> 0.12;
         case GUARDIAN -> 0.0;
         case SHADOW -> 0.06;
         case SCULK -> 0.05;
      };
   }

   private static boolean isWeapon(ItemStack stack) {
      return stack.isEmpty() ? false : ItemCompat.hasAttackDamage(stack);
   }

   public static int pickWeaponSlot(SymbioteProfile p) {
      int best = -1;
      double bestDmg = 0.0;

      for (int i = 0; i < p.armSlotCount(); i++) {
         double dmg = weaponDamage(p.armSlots[i]);
         if (dmg > bestDmg) {
            bestDmg = dmg;
            best = i;
         }
      }

      return best;
   }

   private static double weaponDamage(ItemStack stack) {
      if (stack.isEmpty()) {
         return 0.0;
      }

      double dmg = 0.0;

      dmg += ItemCompat.flatAttackDamage(stack);

      return dmg;
   }

   public static int pickToolSlot(SymbioteProfile p, BlockState state) {
      int fallback = -1;

      for (int i = 0; i < p.armSlotCount(); i++) {
         ItemStack s = p.armSlots[i];
         if (!s.isEmpty()) {
            if (s.isCorrectToolForDrops(state) || s.getDestroySpeed(state) > 1.5F) {
               return i;
            }

            if (fallback < 0) {
               fallback = i;
            }
         }
      }

      return fallback;
   }

   private static int miningTicks(ItemStack tool, BlockState state, ServerLevel level, BlockPos pos) {
      float hardness = state.getDestroySpeed(level, pos);
      if (hardness < 0.0F) {
         return 0;
      }

      if (hardness == 0.0F) {
         return 11;
      }

      float speed = tool.getDestroySpeed(state);
      boolean correct = tool.isCorrectToolForDrops(state);
      int eff = ItemCompat.enchantmentLevel(level, Enchantments.EFFICIENCY, tool);
      if (correct && eff > 0 && speed > 1.0F) {
         speed += eff * eff + 1;
      }

      float damagePerTick = correct ? speed / hardness / 30.0F : speed / hardness / 100.0F;
      if (damagePerTick <= 0.0F) {
         return 120;
      }

      int ticks = (int)Math.ceil(1.0F / damagePerTick);
      return Math.max(11, Math.min(120, ticks));
   }

   private static void retractFx(ServerLevel level, SymbioteArmsController.ArmAction a) {
      if (level.getEntity(a.fxId) instanceof TendrilFxEntity fx) {
         if (TendrilMantle.handOff(level, fx)) {
            return;
         }

         Vec3 tip = fx.getTargetPos();
         fx.setTransitionFrom(tip.x, tip.y, tip.z, fx.tickCount);
         fx.setRetractStartTick(fx.tickCount);
         fx.setLifetime(fx.tickCount + 16);
      }
   }

   private static void cleanup(ServerLevel level, SymbioteArmsController.ArmAction a) {
      if (a.mining && a.block != null) {
         level.destroyBlockProgress(a.fxId, a.block, -1);
      }

      if (level.getEntity(a.fxId) instanceof TendrilFxEntity fx) {
         if (TendrilMantle.handOff(level, fx)) {
            return;
         }

         fx.discard();
      }
   }

   private static void cleanupAll(ServerLevel level, SymbioteArmsController.PlayerArms pa) {
      for (SymbioteArmsController.ArmAction a : pa.actions) {
         cleanup(level, a);
      }

      pa.actions.clear();
      pa.veinQueue.clear();
      pa.veinSlot = -1;
      pa.veinBlockedSince = -1L;
      pa.wallQueue.clear();
      pa.wallItem = null;
   }

   public static void forceClear(ServerLevel level, UUID player) {
      SymbioteArmsController.PlayerArms pa = PLAYERS.remove(player);
      if (pa != null) {
         cleanupAll(level, pa);
      }
   }

   public static void tickStolenWatch(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (p.stolenArmSlot >= 0) {
         ItemStack cur = p.stolenArmSlot < p.armSlots.length ? p.armSlots[p.stolenArmSlot] : ItemStack.EMPTY;
         Item item = (Item)BuiltInRegistries.ITEM.getValue(ResourceLocation.tryParse(p.stolenArmItem));
         if (item == null || cur.isEmpty() || !cur.is(item)) {
            boolean reclaimed = item != null && player.getInventory().hasAnyMatching(s -> s.is(item));
            String stolenId = p.stolenArmItem;
            p.stolenArmSlot = -1;
            p.stolenArmItem = "";
            SymbioteTracker.get(level).setDirty();
            if (reclaimed) {
               SymbioteTracker.adjustStress(level, player, 10, "stress_tool_reclaimed");
               p.addBeat(MoodEngine.BeatType.TOOL_RECLAIMED, level.getGameTime(), stolenId);
               VoiceLines.send(player, "symbiote.voice.arm_reclaim", 3);
               SymbioteLog.event("ARM_RECLAIM_ANGER player={} item={}", player.getUUID(), item);
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      PLAYERS.remove(player);
   }

   private SymbioteArmsController() {
   }

   static final class ArmAction {
      final UUID player;
      final int slot;
      final long startTick;
      final int fxId;
      final boolean mining;
      final boolean placing;
      final int targetEntityId;
      final BlockPos block;
      final int miningTicks;
      final boolean vein;
      final Item placeItem;
      int lastStage = -1;
      boolean executed = false;

      ArmAction(
         UUID player,
         int slot,
         long startTick,
         int fxId,
         boolean mining,
         int targetEntityId,
         BlockPos block,
         int miningTicks,
         boolean vein,
         boolean placing,
         Item placeItem
      ) {
         this.player = player;
         this.slot = slot;
         this.startTick = startTick;
         this.fxId = fxId;
         this.mining = mining;
         this.targetEntityId = targetEntityId;
         this.block = block;
         this.miningTicks = miningTicks;
         this.vein = vein;
         this.placing = placing;
         this.placeItem = placeItem;
      }
   }

   static final class PlayerArms {
      final List<SymbioteArmsController.ArmAction> actions = new ArrayList<>();
      final Deque<BlockPos> veinQueue = new ArrayDeque<>();
      int veinSlot = -1;
      long veinBlockedSince = -1L;
      final Deque<BlockPos> wallQueue = new ArrayDeque<>();
      Item wallItem = null;
      boolean wallFast = false;
      long wallQueuedAt = 0L;
      long nextSpawnTick = 0L;
   }
}
