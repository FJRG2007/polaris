package com.scout.symbiote.util;

import com.scout.symbiote.ability.DeepSeizure;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.WalkSeizure;
import java.util.UUID;
import net.minecraft.world.entity.player.Player;

public final class BodySeized {
   public static boolean is(Player player) {
      return is(player.getUUID());
   }

   public static boolean is(UUID id) {
      return WalkSeizure.isActive(id) || DeepSeizure.isActive(id) || SymbioteCuriosity.isStaring(id);
   }

   private BodySeized() {
   }
}
