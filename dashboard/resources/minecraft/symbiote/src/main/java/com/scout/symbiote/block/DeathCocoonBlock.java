package com.scout.symbiote.block;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.util.RandomSource;
import net.minecraft.world.Containers;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.BlockBehaviour.Properties;
import net.minecraft.world.level.block.state.StateDefinition.Builder;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

public class DeathCocoonBlock extends Block implements EntityBlock {
   private static final int POLL_INTERVAL = 20;
   private static final double REBOND_RANGE = 3.0;

   public DeathCocoonBlock(Properties props) {
      super(props.noLootTable().strength(0.8F).noOcclusion().lightLevel(state -> 4));
      this.registerDefaultState((BlockState)((BlockState)this.stateDefinition.any()).setValue(DormantSampleBlock.STRAIN, SymbioteStrain.GUARDIAN));
   }

   protected void createBlockStateDefinition(Builder<Block, BlockState> builder) {
      builder.add(new Property[]{DormantSampleBlock.STRAIN});
   }

   public BlockEntity newBlockEntity(BlockPos pos, BlockState state) {
      return new DeathCocoonBlock.Entity(pos, state);
   }

   public void onPlace(BlockState state, Level level, BlockPos pos, BlockState oldState, boolean isMoving) {
      super.onPlace(state, level, pos, oldState, isMoving);
      if (level instanceof ServerLevel sl) {
         sl.scheduleTick(pos, this, 20);
      }
   }

   public void tick(BlockState state, ServerLevel level, BlockPos pos, RandomSource random) {
      super.tick(state, level, pos, random);
      if (level.getBlockEntity(pos) instanceof DeathCocoonBlock.Entity ent) {
         if (ent.isRebondMass()) {
            DormantSampleBlock.ensurePermanentLoops(level, pos, state);
         }

         if (ent.isRebondMass() && ent.owner != null && !TendrilSceneController.isSampleClaimed(pos)) {
            ServerPlayer host = level.getServer().getPlayerList().getPlayer(ent.owner);
            if (host != null
               && host.isAlive()
               && host.level() == level
               && !TendrilSceneController.isInScene(host.getUUID())
               && host.distanceToSqr(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5) <= 9.0
               && DormantSampleBlock.canSeeSample(level, host, pos, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5)) {
               startClaim(host, level, pos, ent);
            }
         }

         level.scheduleTick(pos, this, 20);
      }
   }

   public void onRemove(BlockState state, Level level, BlockPos pos, BlockState newState, boolean isMoving) {
      if (!level.isClientSide && !state.is(newState.getBlock()) && level instanceof ServerLevel sl) {
         DormantSampleBlock.releasePermanentLoops(sl, pos);
         if (level.getBlockEntity(pos) instanceof DeathCocoonBlock.Entity ent && ent.isRebondMass() && !ent.slotItems.isEmpty()) {
            for (DeathCocoonBlock.Entity.SlotStack ss : ent.slotItems) {
               if (!ss.stack().isEmpty()) {
                  Containers.dropItemStack(level, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5, ss.stack());
               }
            }

            ent.slotItems.clear();
            ent.storedProfile = null;
            SymbioteLog.event("REBOND_MASS_DESTROYED pos={} (elder killed unfaced, items scattered)", pos);
         }
      }

      super.onRemove(state, level, pos, newState, isMoving);
   }

   @Override
   protected InteractionResult useWithoutItem(BlockState state, Level level, BlockPos pos, Player player, BlockHitResult hit) {
      if (level.isClientSide) {
         return InteractionResult.SUCCESS;
      }

      if (level.getBlockEntity(pos) instanceof DeathCocoonBlock.Entity ent) {
         if (level instanceof ServerLevel sl) {
            if (ent.isRebondMass()) {
               if (player instanceof ServerPlayer sp && sp.getUUID().equals(ent.owner)) {
                  if (!TendrilSceneController.isSampleClaimed(pos) && !TendrilSceneController.isInScene(sp.getUUID())) {
                     startClaim(sp, sl, pos, ent);
                  }

                  return InteractionResult.CONSUME;
               } else {
                  level.playSound(null, pos, SoundEvents.SLIME_BLOCK_HIT, SoundSource.BLOCKS, 0.8F, 0.5F);
                  SymbioteLog.event("REBOND_MASS_REFUSED player={} owner={} pos={}", player.getUUID(), ent.owner, pos);
                  return InteractionResult.CONSUME;
               }
            } else {
               for (ItemStack s : ent.stored) {
                  if (!s.isEmpty() && !player.getInventory().add(s)) {
                     Containers.dropItemStack(level, pos.getX(), pos.getY() + 0.5, pos.getZ(), s);
                  }
               }

               ent.stored.clear();
               SymbioteLog.event("COCOON_OPENED player={} pos={}", player.getUUID(), pos);
               level.removeBlock(pos, false);
               return InteractionResult.CONSUME;
            }
         } else {
            return InteractionResult.PASS;
         }
      } else {
         return InteractionResult.PASS;
      }
   }

   private static void startClaim(ServerPlayer host, ServerLevel level, BlockPos pos, DeathCocoonBlock.Entity ent) {
      SymbioteProfile current = SymbioteTracker.get(level).peek(host.getUUID());
      boolean hostTaken = current != null && current.stage.isBonded();
      Vec3 center = new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
      if (ent.storedProfile == null) {
         returnItems(host, level, pos, ent);
         level.removeBlock(pos, false);
      } else {
         SymbioteStrain elder = SymbioteProfile.fromNbt(ent.storedProfile, level.registryAccess()).strain;
         if (!hostTaken) {
            TendrilSceneController.startRebond(host, level, center, elder);
         } else {
            TendrilSceneController.startReclaim(host, level, center, elder, current.strain);
         }
      }
   }

   public static void finishClaim(ServerPlayer host, ServerLevel level, BlockPos pos) {
      if (level.getBlockEntity(pos) instanceof DeathCocoonBlock.Entity ent && ent.isRebondMass()) {
         SymbioteProfile current = SymbioteTracker.get(level).peek(host.getUUID());
         boolean hostTaken = current != null && current.stage.isBonded();
         if (!hostTaken && ent.storedProfile != null) {
            SymbioteProfile restored = SymbioteProfile.fromNbt(ent.storedProfile, level.registryAccess());
            restored.sanitizeForRestore(level.getGameTime());
            restored.addBeat(MoodEngine.BeatType.NEAR_DEATH, level.getGameTime(), "host_death");
            restored.stress = Math.min(100, restored.stress + 8);
            SymbioteTracker.get(level).restoreProfile(host.getUUID(), restored);
            host.refreshDimensions();
            TendrilFxEntity.spawnBurst(level, host, 30, restored.strain, true);
            level.playSound(null, host.getX(), host.getY(), host.getZ(), (SoundEvent)ModSounds.BOND_ATTACH.get(), SoundSource.PLAYERS, 1.0F, 0.9F);
            VoiceLines.send(host, "symbiote.voice.rebond_mass", 1);
            SymbioteLog.event("REBOND_MASS_CLAIMED player={} strain={} bond={} pos={}", host.getUUID(), restored.strain, restored.bond, pos);
         } else {
            VoiceLines.send(host, "symbiote.voice.rebond_taken", 2);
            SymbioteLog.event("REBOND_MASS_RELINQUISHED player={} hostTaken={} pos={}", host.getUUID(), hostTaken, pos);
         }

         returnItems(host, level, pos, ent);
         ModNetwork.syncToPlayer(level, host);
         level.levelEvent(2001, pos, Block.getId(level.getBlockState(pos)));
         level.removeBlock(pos, false);
      }
   }

   public static void finishReclaim(ServerPlayer host, ServerLevel level, BlockPos pos) {
      if (level.getBlockEntity(pos) instanceof DeathCocoonBlock.Entity ent && ent.storedProfile != null) {
         SymbioteProfile young = SymbioteTracker.get(level).peek(host.getUUID());
         if (young != null) {
            for (int i = 0; i < young.armSlots.length; i++) {
               ItemStack s = young.armSlots[i];
               if (s != null && !s.isEmpty() && !host.getInventory().add(s)) {
                  host.drop(s, false);
               }

               young.armSlots[i] = ItemStack.EMPTY;
            }
         }

         SymbioteProfile elder = SymbioteProfile.fromNbt(ent.storedProfile, level.registryAccess());
         elder.sanitizeForRestore(level.getGameTime());
         elder.addBeat(MoodEngine.BeatType.NEAR_DEATH, level.getGameTime(), "reclaim");
         elder.stress = Math.min(100, elder.stress + 15);
         SymbioteTracker.get(level).restoreProfile(host.getUUID(), elder);
         host.refreshDimensions();
         TendrilFxEntity.spawnBurst(level, host, 30, elder.strain, true);
         level.playSound(null, host.getX(), host.getY(), host.getZ(), (SoundEvent)ModSounds.BOND_ATTACH.get(), SoundSource.PLAYERS, 1.0F, 0.8F);
         VoiceLines.send(host, "symbiote.voice.reclaim_won", 3);
         SymbioteLog.event("RECLAIM_DONE player={} elder={} youngDiscarded={} pos={}", host.getUUID(), elder.strain, young != null ? young.strain : null, pos);
         returnItems(host, level, pos, ent);
         ModNetwork.syncToPlayer(level, host);
         level.levelEvent(2001, pos, Block.getId(level.getBlockState(pos)));
         level.removeBlock(pos, false);
      }
   }

   private static void returnItems(ServerPlayer host, ServerLevel level, BlockPos pos, DeathCocoonBlock.Entity ent) {
      for (int i = 0; i < ent.slotItems.size(); i++) {
         DeathCocoonBlock.Entity.SlotStack ss = ent.slotItems.get(i);
         if (!ss.stack().isEmpty()) {
            if (ss.slot() < host.getInventory().getContainerSize() && host.getInventory().getItem(ss.slot()).isEmpty()) {
               host.getInventory().setItem(ss.slot(), ss.stack());
            } else if (!host.getInventory().add(ss.stack())) {
               Containers.dropItemStack(level, pos.getX(), pos.getY() + 0.5, pos.getZ(), ss.stack());
            }
         }
      }

      ent.slotItems.clear();
      ent.storedProfile = null;
   }

   public static class Entity extends BlockEntity {
      public static BlockEntityType<DeathCocoonBlock.Entity> TYPE;
      public final List<ItemStack> stored = new ArrayList<>();
      public CompoundTag storedProfile = null;
      public UUID owner = null;
      public final List<DeathCocoonBlock.Entity.SlotStack> slotItems = new ArrayList<>();

      public Entity(BlockPos pos, BlockState state) {
         super(TYPE, pos, state);
      }

      public boolean isRebondMass() {
         return this.storedProfile != null || this.owner != null;
      }

      public void storeInventory(List<ItemStack> stacks) {
         this.stored.clear();
         this.stored.addAll(stacks);
         this.setChanged();
         SymbioteMod.LOGGER.debug("Cocoon stored {} stacks", stacks.size());
      }

      public void storeRebond(CompoundTag profileTag, UUID hostId, List<DeathCocoonBlock.Entity.SlotStack> slots) {
         this.storedProfile = profileTag;
         this.owner = hostId;
         this.slotItems.clear();
         this.slotItems.addAll(slots);
         this.setChanged();
      }

      @Override
      protected void saveAdditional(CompoundTag tag, HolderLookup.Provider registries) {
         super.saveAdditional(tag, registries);
         CompoundTag items = new CompoundTag();
         items.putInt("count", this.stored.size());

         for (int i = 0; i < this.stored.size(); i++) {
            if (!this.stored.get(i).isEmpty()) {
               items.put("i" + i, this.stored.get(i).save(registries));
            }
         }

         tag.put("items", items);
         if (this.storedProfile != null) {
            tag.put("profile", this.storedProfile);
         }

         if (this.owner != null) {
            tag.putUUID("owner", this.owner);
         }

         ListTag slots = new ListTag();

         for (DeathCocoonBlock.Entity.SlotStack ss : this.slotItems) {
            if (!ss.stack().isEmpty()) {
               CompoundTag st = new CompoundTag();
               st.putInt("Slot", ss.slot());
               st.put("Item", ss.stack().save(registries));
               slots.add(st);
            }
         }

         tag.put("slotItems", slots);
      }

      @Override
      protected void loadAdditional(CompoundTag tag, HolderLookup.Provider registries) {
         super.loadAdditional(tag, registries);
         this.stored.clear();
         CompoundTag items = tag.getCompound("items");
         int count = items.getInt("count");

         for (int i = 0; i < count; i++) {
            if (items.contains("i" + i)) {
               this.stored.add(ItemStack.parseOptional(registries, items.getCompound("i" + i)));
            }
         }

         this.storedProfile = tag.contains("profile") ? tag.getCompound("profile") : null;
         this.owner = tag.hasUUID("owner") ? tag.getUUID("owner") : null;
         this.slotItems.clear();
         ListTag slots = tag.getList("slotItems", 10);

         for (int i = 0; i < slots.size(); i++) {
            CompoundTag st = slots.getCompound(i);
            this.slotItems.add(new DeathCocoonBlock.Entity.SlotStack(st.getInt("Slot"), ItemStack.parseOptional(registries, st.getCompound("Item"))));
         }
      }

      public record SlotStack(int slot, ItemStack stack) {
      }
   }
}
