package com.scout.symbiote.ability;

import com.scout.symbiote.SymbioteMod;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;

public final class PredatorSense {
   private static final int TICK_INTERVAL = 40;
   private static final int PING_DURATION_TICKS = 55;
   private static final double NOISE_SPEED_SQ = 0.0025;

   public static boolean shouldTick(long worldTick) {
      return worldTick % 40L == 0L;
   }

   public static void tickFor(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (p.stage.isBonded() && !p.isDormant(level.getGameTime())) {
         if (p.strain == SymbioteStrain.SCULK) {
            if (p.instabilityUntilTick <= level.getGameTime()) {
               PlayerCommandDispatcher.CommandMode mode = PlayerCommandDispatcher.getMode(player.getUUID());
               if (mode != PlayerCommandDispatcher.CommandMode.HIDE) {
                  int range = SymbioteConfig.PREDATOR_SENSE_RANGE.get() + StrainTraits.senseRangeBonus(p.strain);
                  AABB box = player.getBoundingBox().inflate(range);
                  List<Mob> loud = level.getEntitiesOfClass(
                     Mob.class, box, e -> e instanceof Enemy && e.isAlive() && (e.getDeltaMovement().horizontalDistanceSqr() > 0.0025 || e.hurtTime > 0)
                  );
                  if (!loud.isEmpty()) {
                     int[] ids = new int[loud.size()];

                     for (int i = 0; i < loud.size(); i++) {
                        ids[i] = loud.get(i).getId();
                     }

                     ModNetwork.sendSculkGlow(player, ids, 55);
                     if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
                        SymbioteLog.event("SCULK_ECHOLOCATION player={} pinged={}", player.getUUID(), ids.length);
                     }
                  }
               }
            }
         }
      }
   }

   private PredatorSense() {
      SymbioteMod.LOGGER.debug("PredatorSense loaded");
   }
}
