package com.scout.symbiote.ability;

import com.scout.symbiote.tracker.SymbioteProfile;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class CostlyResistance {
   public static final boolean VAULTED = true;
   private static final int HOLD_TICKS = 20;
   private static final Map<UUID, Integer> HOLD = new HashMap<>();

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
   }

   public static void onLogout(UUID player) {
      HOLD.remove(player);
   }

   private CostlyResistance() {
   }
}
