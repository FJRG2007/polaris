package com.scout.symbiote.event;

import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import java.util.function.Predicate;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LightningBolt;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.goal.AvoidEntityGoal;
import net.minecraft.world.entity.ai.goal.target.NearestAttackableTargetGoal;
import net.minecraft.world.entity.ai.memory.MemoryModuleType;
import net.minecraft.world.entity.animal.IronGolem;
import net.minecraft.world.entity.npc.Villager;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.player.PlayerEvent.PlayerChangedDimensionEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent.RightClickBlock;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class WorldReactionHandler {
   private static final int VILLAGER_FEAR_PRIORITY = 1;
   private static final int GOLEM_TARGET_PRIORITY = 4;
   private static final double FEAR_WALK_SPEED = 0.8;
   private static final double FEAR_SPRINT_SPEED = 1.0;

   @SubscribeEvent
   public static void onChestClick(RightClickBlock event) {
      if (event.getLevel() instanceof ServerLevel level) {
         if (level.getBlockEntity(event.getPos()) instanceof ChestBlockEntity chest && chest.saveWithoutMetadata(level.registryAccess()).contains("LootTable")) {
            chest.getPersistentData().putBoolean("symbiote_natural", true);
         }
      }
   }

   @SubscribeEvent
   public static void onEntityJoin(EntityJoinLevelEvent event) {
      if (event.getLevel() instanceof ServerLevel level) {
         if (event.getEntity() instanceof Villager villager) {
            injectVillagerFear(villager, level);
         } else if (event.getEntity() instanceof IronGolem golem) {
            injectGolemHostility(golem, level);
         } else if (event.getEntity() instanceof LightningBolt bolt) {
            for (ServerPlayer sp : level.players()) {
               if (sp.distanceToSqr(bolt.position()) < 25600.0) {
                  SymbioteCuriosity.noteEncounter(sp, level, "first_thunder", "symbiote.voice.encounter_thunder");
               }
            }
         }
      }
   }

   @SubscribeEvent
   public static void onDimensionChange(PlayerChangedDimensionEvent event) {
      if (event.getEntity() instanceof ServerPlayer player) {
         ServerLevel var3 = player.serverLevel();
         if (event.getTo() == Level.NETHER) {
            SymbioteCuriosity.noteEncounter(player, var3, "first_nether", "symbiote.voice.encounter_nether");
         } else if (event.getTo() == Level.END) {
            SymbioteCuriosity.noteEncounter(player, var3, "first_end", "symbiote.voice.encounter_end");
         }
      }
   }

   private static void injectVillagerFear(Villager villager, ServerLevel level) {
      villager.goalSelector
         .addGoal(
            1,
            new WorldReactionHandler.BrainOverridingAvoidGoal(
               villager, SymbioteConfig.VILLAGER_FEAR_RANGE.get().floatValue(), target -> isFearedHost(target, level)
            )
         );
      if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
         SymbioteLog.debug("WORLD_REACTION_INJECT type=villager_fear villager={}", villager.getUUID());
      }
   }

   private static void injectGolemHostility(IronGolem golem, ServerLevel level) {
      golem.targetSelector.addGoal(4, new NearestAttackableTargetGoal<>(golem, Player.class, 10, true, false, (target, lvl) -> isDominantHost(target, level)));
      if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
         SymbioteLog.debug("WORLD_REACTION_INJECT type=golem_hostility golem={}", golem.getUUID());
      }
   }

   private static boolean isFearedHost(LivingEntity target, ServerLevel level) {
      if (!SymbioteConfig.VILLAGER_FEAR_ENABLED.get()) {
         return false;
      }

      if (target instanceof Player player) {
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         if (p == null || !p.stage.isBonded()) {
            return false;
         } else {
            return !p.stage.isAtLeast(BondStage.DOMINANT)
               ? false
               : PlayerCommandDispatcher.getMode(player.getUUID()) != PlayerCommandDispatcher.CommandMode.HIDE;
         }
      } else {
         return false;
      }
   }

   private static boolean isDominantHost(LivingEntity target, ServerLevel level) {
      if (!SymbioteConfig.GOLEM_HOSTILE_TO_DOMINANT.get()) {
         return false;
      } else if (!(target instanceof Player player)) {
         return false;
      } else {
         SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
         return p != null && p.stage == BondStage.DOMINANT;
      }
   }

   private WorldReactionHandler() {
   }

   private static final class BrainOverridingAvoidGoal extends AvoidEntityGoal<Player> {
      private final Villager villager;

      BrainOverridingAvoidGoal(Villager villager, float range, Predicate<LivingEntity> predicate) {
         super(villager, Player.class, range, 0.8, 1.0, predicate);
         this.villager = villager;
      }

      public void start() {
         this.clearBrainWalk();
         super.start();
      }

      public void tick() {
         this.clearBrainWalk();
         super.tick();
      }

      private void clearBrainWalk() {
         this.villager.getBrain().eraseMemory(MemoryModuleType.WALK_TARGET);
         this.villager.getBrain().eraseMemory(MemoryModuleType.PATH);
      }
   }
}
