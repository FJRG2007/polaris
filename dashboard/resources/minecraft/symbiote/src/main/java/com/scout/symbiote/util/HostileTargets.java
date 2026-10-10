package com.scout.symbiote.util;

import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.NeutralMob;
import net.minecraft.world.entity.player.Player;

public final class HostileTargets {
   public static boolean mayOpenOn(LivingEntity target, Player host) {
      if (target instanceof NeutralMob neutral) {
         return (host.level() instanceof net.minecraft.server.level.ServerLevel sl && neutral.isAngryAt(host, sl)) ? true : target instanceof Mob mob && mob.getTarget() == host;
      } else {
         return true;
      }
   }

   private HostileTargets() {
   }
}
