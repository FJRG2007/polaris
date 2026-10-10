package com.scout.symbiote.event;

import com.scout.symbiote.ability.EnemySlam;
import com.scout.symbiote.ability.FirePanicEscape;
import com.scout.symbiote.ability.GrabState;
import com.scout.symbiote.ability.RupturePounceScene;
import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.ability.SymbioteBloom;
import com.scout.symbiote.ability.SymbioteFeedingHunt;
import com.scout.symbiote.ability.SymbioteScavengeReflex;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.ability.TendrilSceneController;
import com.scout.symbiote.block.DeathCocoonBlock;
import com.scout.symbiote.block.DormantSampleBlock;
import com.scout.symbiote.compat.CuriosRebondCompat;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.failure.LastResortRevival;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModBlocks;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.Vindication;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.ClipContext.Block;
import net.minecraft.world.level.ClipContext.Fluid;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.HitResult.Type;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.Clone;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.ModList;

public class PlayerDeathListener {
   private static final int COCOON_MIN_BOND = 30;
   private static final int COCOON_MAX_BOND = 69;
   private static final Set<UUID> SYMBIOTE_KILLS = new HashSet<>();

   public static void markSymbioteKill(UUID player) {
      SYMBIOTE_KILLS.add(player);
   }

   @SubscribeEvent(priority = EventPriority.HIGH)
   public void onDeath(LivingDeathEvent event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         ServerLevel level = player.serverLevel();
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         if (p != null && p.stage.isBonded()) {
            SymbioteArmsController.forceClear(level, player.getUUID());
            handOffArmItems(player, p);
            p.revivalAdrenaline = false;
            LastResortRevival.onLogout(player.getUUID());
            ModNetwork.broadcastLivingArmorState(player, false);
            SymbioteBloom.clear(player, level, p);
            boolean symbioteKill = SYMBIOTE_KILLS.remove(player.getUUID());
            if (!symbioteKill && (Boolean)SymbioteConfig.DEATH_KEEPS_BOND.get()) {
               SymbioteLog.event("DEATH_BOND_KEPT player={} bond={}", player.getUUID(), p.bond);
               tearDownTendrilState(player, level);
            } else if (!symbioteKill && (Boolean)SymbioteConfig.DEATH_MASS_ENABLED.get() && placeRebondMass(player, level, p)) {
               SymbioteTracker.onUnbond(level, player, "host_death_mass");
               tearDownTendrilState(player, level);
            } else {
               if (!symbioteKill && p.bond >= 30 && p.bond <= 69) {
                  placeCocoon(player, level);
               }

               SymbioteTracker.onUnbond(level, player, symbioteKill ? "symbiote_kill" : "host_death");
               tearDownTendrilState(player, level);
            }
         }
      }
   }

   private static boolean placeRebondMass(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      BlockPos base = player.blockPosition();
      if (base.getY() < level.getMinY() + 1) {
         return false;
      }

      BlockPos check = findMassSpot(level, player, base);
      if (check != null
         && level.setBlockAndUpdate(check, (BlockState)((DeathCocoonBlock)ModBlocks.DEATH_COCOON.get()).defaultBlockState().setValue(DormantSampleBlock.STRAIN, p.strain))
         && level.getBlockEntity(check) instanceof DeathCocoonBlock.Entity ent) {
         ArrayList var10 = new ArrayList();
         boolean keepInv = level.getGameRules().getBoolean(GameRules.RULE_KEEPINVENTORY);
         if (!keepInv) {
            for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
               ItemStack s = player.getInventory().getItem(i);
               if (!s.isEmpty()) {
                  var10.add(new DeathCocoonBlock.Entity.SlotStack(i, s.copy()));
               }
            }

            player.getInventory().clearContent();
         }

         ent.storeRebond(p.toNbt(player.registryAccess()), player.getUUID(), var10);
         if (ModList.get().isLoaded("curios")) {
            CuriosRebondCompat.trackMass(player, ent);
         }

         SymbioteLog.event("REBOND_MASS_PLACED player={} pos={} stacks={} strain={} bond={}", player.getUUID(), check, var10.size(), p.strain, p.bond);
         return true;
      } else {
         SymbioteLog.event("REBOND_MASS_FAILED player={} pos={} reason=no_spot_in_reach", player.getUUID(), base);
         return false;
      }
   }

   private static void handOffArmItems(ServerPlayer player, SymbioteProfile p) {
      if (p.armSlots != null) {
         for (int i = 0; i < p.armSlots.length; i++) {
            ItemStack s = p.armSlots[i];
            if (s != null && !s.isEmpty() && !player.getInventory().add(s)) {
               player.drop(s, false);
            }

            p.armSlots[i] = ItemStack.EMPTY;
         }

         p.stolenArmSlot = -1;
         p.stolenArmItem = "";
         p.contrabandSlot = -1;
         p.contrabandTakenTick = 0L;
      }
   }

   private static void tearDownTendrilState(ServerPlayer player, ServerLevel level) {
      UUID id = player.getUUID();
      TendrilMantle.onLogout(id);
      SymbioteFeedingHunt.forceClear(level, id);
      FirePanicEscape.forceClear(level, id);
      EnemySlam.forceClear(level, id);
      RupturePounceScene.forceClear(level, id);
      SymbioteScavengeReflex.forceClear(level, id);
      Vindication.clear(id);
      TendrilSceneController.clear(id);
      GrabState.Held held = GrabState.get(id);
      if (held != null) {
         Entity fx = level.getEntity(held.tendrilFxId);
         if (fx != null) {
            fx.discard();
         }

         GrabState.clear(id);
      }

      int pid = player.getId();

      for (TendrilFxEntity t : level.getEntitiesOfClass(TendrilFxEntity.class, player.getBoundingBox().inflate(48.0), e -> e.getOwnerId() == pid)) {
         t.discard();
      }
   }

   private static BlockPos findMassSpot(ServerLevel level, ServerPlayer player, BlockPos base) {
      int minY = level.getMinY() + 1;
      int maxY = level.getMaxY();
      BlockPos best = null;
      long bestScore = Long.MAX_VALUE;

      for (int dx = -2; dx <= 2; dx++) {
         for (int dz = -2; dz <= 2; dz++) {
            for (int dy = -1; dy <= 2; dy++) {
               BlockPos at = base.offset(dx, dy, dz);
               if (at.getY() >= minY && at.getY() <= maxY && level.getBlockState(at).canBeReplaced()) {
                  boolean supported = !level.getBlockState(at.below()).canBeReplaced();
                  boolean seen = level.clip(new ClipContext(Vec3.atCenterOf(base), Vec3.atCenterOf(at), Block.COLLIDER, Fluid.NONE, player)).getType()
                     == Type.MISS;
                  long score = (dx * dx + dy * dy + dz * dz) * 100L + (supported ? 0 : 10) + (seen ? 0 : 30);
                  if (score < bestScore) {
                     bestScore = score;
                     best = at.immutable();
                  }
               }
            }
         }
      }

      return best;
   }

   private static void placeCocoon(ServerPlayer player, ServerLevel level) {
      BlockPos pos = player.blockPosition();
      BlockPos check = findMassSpot(level, player, pos);
      if (check != null
         && level.setBlockAndUpdate(check, ((DeathCocoonBlock)ModBlocks.DEATH_COCOON.get()).defaultBlockState())
         && level.getBlockEntity(check) instanceof DeathCocoonBlock.Entity ent) {
         List<ItemStack> snapshot = new ArrayList<>();

         for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
            ItemStack s = player.getInventory().getItem(i);
            if (!s.isEmpty()) {
               snapshot.add(s.copy());
            }
         }

         ent.storeInventory(snapshot);
         player.getInventory().clearContent();
         SymbioteLog.event("COCOON_PLACED player={} pos={} stacks={}", player.getUUID(), check, snapshot.size());
      } else {
         SymbioteLog.event("COCOON_PLACEMENT_FAILED player={} pos={} reason=no_spot_in_reach", player.getUUID(), pos);
      }
   }

   @SubscribeEvent
   public void onClone(Clone event) {
      if (event.isWasDeath()) {
         if (event.getEntity() instanceof ServerPlayer player) {
            ServerLevel level = player.serverLevel();
            ModNetwork.syncToPlayer(level, player);
         }
      }
   }
}
