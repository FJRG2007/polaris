package com.scout.symbiote.event;

import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.neoforged.neoforge.event.entity.EntityJoinLevelEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class HeldGravityGuard {
   private static final String TAG = "symbiote_held_nograv";

   public static void mark(LivingEntity held) {
      held.getPersistentData().putBoolean("symbiote_held_nograv", true);
   }

   public static void release(LivingEntity held) {
      held.getPersistentData().remove("symbiote_held_nograv");
   }

   @SubscribeEvent
   public static void onEntityJoin(EntityJoinLevelEvent event) {
      if (!event.getLevel().isClientSide()) {
         if (event.getEntity() instanceof LivingEntity le) {
            if (le instanceof ServerPlayer player) {
               if (player.isNoGravity()) {
                  player.setNoGravity(false);
                  SymbioteLog.event("HELD_GRAVITY_HEALED player={} (crashed scene lift)", player.getUUID());
               }
            } else {
               if (le.getPersistentData().getBoolean("symbiote_held_nograv")) {
                  le.getPersistentData().remove("symbiote_held_nograv");
                  le.setNoGravity(false);
                  SymbioteLog.event("HELD_GRAVITY_HEALED entity={} type={}", le.getId(), le.getType());
               }
            }
         }
      }
   }

   private HeldGravityGuard() {
   }
}
