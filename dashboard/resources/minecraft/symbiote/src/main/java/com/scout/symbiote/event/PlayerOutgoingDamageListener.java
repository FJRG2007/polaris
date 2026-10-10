package com.scout.symbiote.event;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.tracker.StrainTraits;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.bus.api.SubscribeEvent;

public class PlayerOutgoingDamageListener {
   @SubscribeEvent(priority = EventPriority.NORMAL)
   public void onLivingHurt(LivingIncomingDamageEvent event) {
      if (event.getSource().getEntity() instanceof ServerPlayer attacker) {
         if (attacker != event.getEntity()) {
            CombatSense.note(attacker);
            ServerLevel level = attacker.serverLevel();
            SymbioteProfile p = SymbioteTracker.get(level).peek(attacker.getUUID());
            if (p != null && p.stage.isBonded() && !p.isDormant(level.getGameTime())) {
               double mult = StrainTraits.damageMult(p.strain);
               if (mult != 1.0) {
                  float before = event.getAmount();
                  float after = (float)(before * mult);
                  event.setAmount(after);
                  if ((Boolean)SymbioteConfig.VERBOSE_LOGGING.get()) {
                     SymbioteLog.debug(
                        "STRAIN_DAMAGE_SCALE player={} strain={} before={} after={} target={}",
                        attacker.getUUID(),
                        p.strain,
                        before,
                        after,
                        event.getEntity().getType()
                     );
                  }
               }
            }
         }
      }
   }
}
