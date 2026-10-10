package com.scout.symbiote.event;

import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteStrain;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.LivingEntity;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class WildHostCombatListener {
   @SubscribeEvent
   public static void onHurt(LivingIncomingDamageEvent event) {
      if (event.getSource().getEntity() instanceof LivingEntity attacker) {
         if (WildHost.isInfected(attacker)) {
            if (attacker.level() instanceof ServerLevel level) {
               SymbioteStrain strain = WildHost.strainOf(attacker);
               if (strain == null) {
                  strain = SymbioteStrain.GUARDIAN;
               }

               TendrilFxEntity.spawnWhip(level, attacker, event.getEntity(), 14, strain);
            }
         }
      }
   }

   @SubscribeEvent
   public static void onHostHurt(LivingIncomingDamageEvent event) {
      LivingEntity victim = event.getEntity();
      if (WildHost.isInfected(victim)) {
         if (victim.level() instanceof ServerLevel level) {
            if (event.getSource().getEntity() instanceof ServerPlayer sp) {
               WildHostBrain.provoke(victim, sp, level.getGameTime());
            }

            if (!(level.random.nextFloat() > 0.6F)) {
               level.playSound(
                  null,
                  victim.getX(),
                  victim.getY(),
                  victim.getZ(),
                  (SoundEvent)ModSounds.TENDRIL_RETRACT.get(),
                  SoundSource.HOSTILE,
                  0.8F,
                  0.75F + level.random.nextFloat() * 0.2F
               );
            }
         }
      }
   }

   private WildHostCombatListener() {
   }
}
