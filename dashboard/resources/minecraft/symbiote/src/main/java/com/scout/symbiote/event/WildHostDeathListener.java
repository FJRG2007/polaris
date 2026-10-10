package com.scout.symbiote.event;

import com.scout.symbiote.ability.WildHostBrain;
import com.scout.symbiote.bonding.BondingFlow;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.registry.ModItems;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ItemLike;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.entity.living.LivingDeathEvent;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class WildHostDeathListener {
   private static final double LEAP_RANGE = 5.0;

   @SubscribeEvent(priority = EventPriority.NORMAL)
   public static void onDeath(LivingDeathEvent event) {
      LivingEntity dead = event.getEntity();
      if (WildHost.isInfected(dead)) {
         if (dead.level() instanceof ServerLevel level) {
            WildHostBrain.forget(dead.getId());
            SymbioteStrain strain = WildHost.strainOf(dead);
            if (strain == null) {
               strain = SymbioteStrain.GUARDIAN;
            }

            Vec3 origin = dead.position().add(0.0, dead.getBbHeight() * 0.5, 0.0);

            for (int i = 0; i < 6; i++) {
               double a = (Math.PI * 2) * i / 6.0 + level.random.nextDouble() * 0.4;
               Vec3 out = origin.add(Math.cos(a) * 1.6, 0.5 + level.random.nextDouble() * 0.9, Math.sin(a) * 1.6);
               TendrilFxEntity fx = TendrilFxEntity.spawnAmbient(level, origin, out, 22, strain, 0.55F, (float)a);
               fx.setReachTicksOverride(6);
               fx.scheduleRetract(14);
            }

            level.playSound(null, dead.getX(), dead.getY(), dead.getZ(), (SoundEvent)ModSounds.REJECTION.get(), SoundSource.HOSTILE, 0.9F, 1.15F);
            if (!tryLeap(dead, level, strain)) {
               int count = 1 + level.random.nextInt(2);
               dead.spawnAtLocation(level, new ItemStack((ItemLike)ModItems.BIOMASS.get(), count));
               SymbioteLog.event("WILD_HOST_KILLED entity={} type={} strain={} biomass={}", dead.getId(), dead.getType().toString(), strain, count);
            }
         }
      }
   }

   private static boolean tryLeap(LivingEntity dead, ServerLevel level, SymbioteStrain strain) {
      boolean forced = WildHost.isForcedLeap(dead);
      if (!forced) {
         if (!SymbioteConfig.WILD_HOST_LEAP_ENABLED.get()) {
            return false;
         }

         double chance = SymbioteConfig.WILD_HOST_LEAP_CHANCE.get().intValue() / 100.0;
         if (level.random.nextDouble() >= chance) {
            return false;
         }
      }

      ServerPlayer target = null;
      double bestSq = Double.MAX_VALUE;

      for (ServerPlayer sp : level.players()) {
         if (!sp.isSpectator() && !sp.isCreative()) {
            SymbioteProfile p = SymbioteTracker.get(level).peek(sp.getUUID());
            if (p == null || !p.stage.isBonded()) {
               double d = sp.distanceToSqr(dead);
               if (!(d > 25.0) && d < bestSq) {
                  bestSq = d;
                  target = sp;
               }
            }
         }
      }

      if (target == null) {
         return false;
      }

      TendrilFxEntity.spawnWhip(level, dead, target, 16, strain);
      level.playSound(null, target.getX(), target.getY(), target.getZ(), (SoundEvent)ModSounds.BOND_ATTACH.get(), SoundSource.PLAYERS, 1.0F, 0.9F);
      SymbioteLog.event("WILD_HOST_LEAP entity={} strain={} player={}", dead.getId(), strain, target.getUUID());
      BondingFlow.attemptBond(target, level, false, strain);
      return true;
   }

   private WildHostDeathListener() {
   }
}
