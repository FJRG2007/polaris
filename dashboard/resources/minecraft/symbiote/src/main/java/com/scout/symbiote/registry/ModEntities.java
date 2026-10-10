package com.scout.symbiote.registry;

import com.scout.symbiote.entity.InfectedZombieEntity;
import com.scout.symbiote.entity.NavigatorEntity;
import com.scout.symbiote.entity.TendrilFxEntity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import net.neoforged.neoforge.event.entity.EntityAttributeCreationEvent;
import net.neoforged.neoforge.registries.DeferredHolder;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModEntities {
   public static final DeferredRegister.Entities REGISTER = DeferredRegister.createEntities("symbiote");
   public static final DeferredHolder<EntityType<?>, EntityType<TendrilFxEntity>> TENDRIL_FX = REGISTER.registerEntityType(
      "tendril_fx", TendrilFxEntity::new, MobCategory.MISC, b -> b.sized(0.1F, 0.1F).clientTrackingRange(64).updateInterval(2).noSummon().noSave()
   );
   public static final DeferredHolder<EntityType<?>, EntityType<InfectedZombieEntity>> INFECTED_ZOMBIE = REGISTER.registerEntityType(
      "infected_zombie", InfectedZombieEntity::new, MobCategory.MONSTER, b -> b.sized(0.6F, 1.95F).clientTrackingRange(8)
   );
   public static final DeferredHolder<EntityType<?>, EntityType<NavigatorEntity>> NAVIGATOR = REGISTER.registerEntityType(
      "navigator", NavigatorEntity::new, MobCategory.MISC, b -> b.sized(0.6F, 1.8F).clientTrackingRange(10).updateInterval(3).noSummon().noSave()
   );

   public static void registerAttributes(EntityAttributeCreationEvent event) {
      event.put(INFECTED_ZOMBIE.get(), InfectedZombieEntity.createAttributes().build());
      event.put(NAVIGATOR.get(), NavigatorEntity.createAttributes().build());
   }

   private ModEntities() {
   }
}
