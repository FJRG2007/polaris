package com.scout.symbiote.ability;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.BondStage;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.util.CombatSense;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;

public final class DominantAssertion {
   private static final Map<UUID, Long> NEXT = new HashMap<>();
   private static final int GAP_MIN = 18000;
   private static final int GAP_SPAN = 12000;
   private static final int RETRY = 600;

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      UUID id = player.getUUID();
      if (p.stage != BondStage.DOMINANT) {
         NEXT.remove(id);
      } else if (!p.isStarving()) {
         Long next = NEXT.get(id);
         if (next == null) {
            long due = now + 18000L + player.getRandom().nextInt(12000);
            NEXT.put(id, due);
            SymbioteLog.event("DOMINANT_ASSERT_ARMED player={} due_in={}t", id, due - now);
         } else if (now >= next) {
            if (busy(player, id)) {
               NEXT.put(id, now + 600L);
               SymbioteLog.event("DOMINANT_ASSERT_DEFERRED player={} retry_in={}t", id, 600);
            } else {
               if (!fire(player, level, p, now)) {
                  NEXT.put(id, now + 600L);
               }
            }
         }
      }
   }

   private static boolean busy(ServerPlayer player, UUID id) {
      return CombatSense.inCombat(player)
         || player.isFallFlying()
         || player.isUnderWater()
         || player.fallDistance > 1.0F
         || WalkSeizure.isActive(id)
         || DeepSeizure.isActive(id)
         || TendrilSceneController.isInScene(id)
         || SymbioteFeedingHunt.isHunting(id)
         || FirePanicEscape.isActive(id);
   }

   private static boolean fire(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      UUID id = player.getUUID();
      BlockPos dest = pickDest(player, level);
      if (dest != null && WalkSeizure.start(player, level, p, dest, true)) {
         VoiceLines.send(player, "symbiote.voice.dominant_assert", 0);
         SymbioteLog.event("DOMINANT_ASSERT player={} dest={}", id, dest.toShortString());
         NEXT.put(id, now + 18000L + player.getRandom().nextInt(12000));
         return true;
      } else {
         return false;
      }
   }

   public static String force(ServerPlayer player, ServerLevel level, SymbioteProfile p) {
      if (p.stage != BondStage.DOMINANT) {
         return "not DOMINANT";
      } else if (busy(player, player.getUUID())) {
         return "body busy (combat/seizure/water/air)";
      } else {
         return fire(player, level, p, level.getGameTime()) ? null : "walk refused (no path)";
      }
   }

   private static BlockPos pickDest(ServerPlayer player, ServerLevel level) {
      List<LivingEntity> living = level.getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(12.0), e -> e != player && e.isAlive() && !(e instanceof Player));
      if (!living.isEmpty()) {
         LivingEntity t = living.get(player.getRandom().nextInt(living.size()));
         ModNetwork.sendOverrideFx(player, "gaze:" + t.getId(), 60);
         return t.blockPosition();
      } else {
         double a = player.getRandom().nextDouble() * Math.PI * 2.0;
         int dist = 6 + player.getRandom().nextInt(4);
         return player.blockPosition().offset((int)Math.round(Math.cos(a) * dist), 0, (int)Math.round(Math.sin(a) * dist));
      }
   }

   public static void onLogout(UUID id) {
      NEXT.remove(id);
   }

   private DominantAssertion() {
   }
}
