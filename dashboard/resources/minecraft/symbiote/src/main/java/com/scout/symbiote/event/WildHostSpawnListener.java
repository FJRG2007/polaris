package com.scout.symbiote.event;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.InfectedZombieEntity;
import com.scout.symbiote.entity.NavigatorEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.FlyingMob;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.navigation.FlyingPathNavigation;
import net.minecraft.world.entity.ambient.AmbientCreature;
import net.minecraft.world.entity.animal.FlyingAnimal;
import net.minecraft.world.entity.animal.WaterAnimal;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.wither.WitherBoss;
import net.minecraft.world.entity.monster.warden.Warden;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.neoforge.event.entity.living.FinalizeSpawnEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class WildHostSpawnListener {
   @SubscribeEvent
   public static void onFinalizeSpawn(FinalizeSpawnEvent event) {
      if (WildHost.enabled()) {
         Mob mob = event.getEntity();
         if (mob.level() instanceof ServerLevel level) {
            if (eligible(mob)) {
               double chance = SymbioteConfig.WILD_HOST_SPAWN_CHANCE.get().intValue() / 1000.0;
               if (!(mob.getRandom().nextDouble() >= chance)) {
                  SymbioteStrain[] strains = SymbioteStrain.values();
                  SymbioteStrain strain = strains[mob.getRandom().nextInt(strains.length)];
                  WildHost.infect(mob, strain, level.getGameTime());
               }
            }
         }
      }
   }

   @SubscribeEvent
   public static void onJoin(EntityJoinLevelEvent event) {
      if (!event.getLevel().isClientSide) {
         if (WildHost.enabled()) {
            if (event.getEntity() instanceof Mob mob && WildHost.isInfected(mob)) {
               WildHost.reapply(mob);
            }
         }
      }
   }

   private static boolean eligible(Mob mob) {
      if (WildHost.isInfected(mob)) {
         return false;
      } else if (mob.isBaby()) {
         return false;
      } else if (mob instanceof WitherBoss || mob instanceof EnderDragon || mob instanceof Warden) {
         return false;
      } else if (isAquatic(mob) || isAirborne(mob)) {
         return false;
      } else if (mob instanceof NavigatorEntity) {
         return false;
      } else {
         return mob instanceof InfectedZombieEntity ? false : mob.getAttribute(Attributes.MAX_HEALTH) != null;
      }
   }

   public static boolean isAquatic(Mob mob) {
      return mob instanceof WaterAnimal || mob.getType().is(net.minecraft.tags.EntityTypeTags.AQUATIC);
   }

   public static boolean isAirborne(Mob mob) {
      return mob instanceof FlyingAnimal || mob instanceof FlyingMob || mob instanceof AmbientCreature || mob.getNavigation() instanceof FlyingPathNavigation;
   }

   private WildHostSpawnListener() {
   }
}
