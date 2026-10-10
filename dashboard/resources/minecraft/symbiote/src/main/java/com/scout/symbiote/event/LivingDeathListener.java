package com.scout.symbiote.event;

import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.SymbioteDesires;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.InfectedZombieEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.registry.ModItems;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.ItemLike;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class LivingDeathListener {
   private static final int RECENT_OVERRIDE_WINDOW_TICKS = 40;
   private static final int KILL_BOND_COOLDOWN_TICKS = 600;
   private static final Map<UUID, Long> LAST_KILL_BOND = new HashMap<>();
   private static final Map<UUID, Long> LAST_KILL = new HashMap<>();

   public static long lastKillTick(UUID player) {
      return LAST_KILL.getOrDefault(player, -4611686018427387904L);
   }

   @SubscribeEvent
   public void onLivingDeath(LivingDeathEvent event) {
      LivingEntity dead = event.getEntity();
      if (!(dead instanceof ServerPlayer)) {
         if (dead.level() instanceof ServerLevel) {
            dropBiomass(dead);
            if (event.getSource().getEntity() instanceof ServerPlayer killer) {
               ServerLevel level = killer.serverLevel();
               SymbioteProfile p = SymbioteTracker.get(level).peek(killer.getUUID());
               if (p != null && p.stage.isBonded()) {
                  long now = level.getGameTime();
                  boolean recentOverride = now - p.lastOverrideTick <= 40L;
                  SymbioteDesires.notifyAnyKill(killer, level, p, now);
                  SymbioteCuriosity.noteTaste(killer, level, dead, recentOverride);
                  SymbioteCuriosity.noteSeenCombat(killer, level, dead);
                  if (p.isDormant(now)) {
                     if (isHostile(dead)) {
                        LAST_KILL.put(killer.getUUID(), now);
                     }

                     SymbioteLog.event("KILL_WHILE_DORMANT player={} no_rewards", killer.getUUID());
                  } else {
                     if (isHostile(dead)) {
                        LAST_KILL.put(killer.getUUID(), now);
                        Long lastBondKill = LAST_KILL_BOND.get(killer.getUUID());
                        if (lastBondKill == null || now - lastBondKill >= 600L) {
                           LAST_KILL_BOND.put(killer.getUUID(), now);
                           SymbioteTracker.adjustBond(level, killer, SymbioteConfig.BOND_KILL_HOSTILE.get(), "bond_kill_assist");
                        }

                        SymbioteTracker.adjustHunger(level, killer, SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get(), "hunger_kill");
                        PlayerCommandDispatcher.onStanceKill(killer, level, now);
                        SymbioteDesires.notifyHostileKill(killer, level, p, now);
                     } else if (dead instanceof Animal && !recentOverride) {
                        SymbioteTracker.adjustHunger(level, killer, SymbioteConfig.HUNGER_PER_HOSTILE_KILL.get() / 2, "hunger_passive_kill");
                     }

                     if (PlayerCommandDispatcher.getMode(killer.getUUID()) == PlayerCommandDispatcher.CommandMode.HUNT) {
                        SymbioteTracker.adjustHunger(level, killer, SymbioteConfig.HUNT_KILL_HUNGER.get(), "hunger_hunt_feed");
                     }
                  }
               }
            }
         }
      }
   }

   private static boolean isHostile(LivingEntity entity) {
      return entity instanceof Enemy || entity.getType().getCategory() == MobCategory.MONSTER;
   }

   public static void onLogout(UUID player) {
      LAST_KILL_BOND.remove(player);
      LAST_KILL.remove(player);
   }

   private static void dropBiomass(LivingEntity dead) {
      if (dead instanceof InfectedZombieEntity || WildHost.isInfected(dead)) {
         if (dead.level() instanceof net.minecraft.server.level.ServerLevel sl && sl.getGameRules().getBoolean(GameRules.RULE_DOMOBLOOT)) {
            double chance = SymbioteConfig.BIOMASS_DROP_CHANCE.get();
            if (!(dead.getRandom().nextDouble() >= chance)) {
               dead.spawnAtLocation(sl, new ItemStack((ItemLike)ModItems.BIOMASS.get()));
               SymbioteLog.event("BIOMASS_DROP pos={} chance={}", dead.blockPosition().toShortString(), chance);
            }
         }
      }
   }
}
