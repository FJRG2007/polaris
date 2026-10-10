package com.scout.symbiote.ability;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.WildHost;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.registry.ModSounds;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvent;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.entity.Mob;

public final class WildHostSense {
   private static final int INTERVAL = 30;
   private static final double NEAR = 18.0;
   private static final double CLOSE = 8.0;
   private static final int REANNOUNCE = 1200;
   private static final int TRACK_INTERVAL = 160;
   private static final double DELTA = 4.0;
   private static final Map<UUID, Map<Integer, Long>> ANNOUNCED = new HashMap<>();
   private static final Map<UUID, Set<Integer>> IN_RANGE = new HashMap<>();
   private static final Map<UUID, Integer> FIXATED = new HashMap<>();
   private static final Map<UUID, Double> LAST_DIST = new HashMap<>();
   private static final Map<UUID, Long> LAST_TRACK = new HashMap<>();
   private static final Map<UUID, Long> LAST_GAZE = new HashMap<>();
   private static final Map<UUID, Double> NEAREST = new HashMap<>();
   private static final int GAZE_COOLDOWN = 600;
   private static final Map<UUID, Set<Integer>> MET = new HashMap<>();
   private static final Map<UUID, Set<Integer>> MET_BLIND = new HashMap<>();

   public static boolean shouldTick(long now) {
      return now % 30L == 0L;
   }

   public static void tick(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (WildHost.enabled()) {
         if (p.stage.isBonded() && !p.isDormant(now)) {
            double range = SymbioteConfig.WILD_HOST_SENSE_RANGE.get().intValue();
            List<Mob> found = level.getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(range), mx -> mx.isAlive() && WildHost.isInfected(mx));
            Set<Integer> nowInRange = new HashSet<>();
            Mob best = null;
            double bestSq = Double.MAX_VALUE;

            for (Mob m : found) {
               nowInRange.add(m.getId());
               double d = m.distanceToSqr(player);
               if (d < bestSq) {
                  bestSq = d;
                  best = m;
               }
            }

            IN_RANGE.put(player.getUUID(), nowInRange);
            if (best == null) {
               NEAREST.remove(player.getUUID());
            } else {
               double dist = Math.sqrt(bestSq);
               NEAREST.put(player.getUUID(), dist);
               if (!PredatorHunt.isHunting(player.getUUID())) {
                  Set<Integer> owedReveal = MET_BLIND.get(player.getUUID());
                  if (owedReveal != null && owedReveal.contains(best.getId()) && best.hasLineOfSight(player)) {
                     owedReveal.remove(best.getId());
                     VoiceLines.sendAs(player, "symbiote.voice.wild_seen", 4, p.strain);
                     gaze(player, best, now, true);
                     LAST_TRACK.put(player.getUUID(), now);
                  } else {
                     Map<Integer, Long> seen = ANNOUNCED.computeIfAbsent(player.getUUID(), k -> new HashMap<>());
                     Long last = seen.get(best.getId());
                     if (last != null && now - last < 1200L) {
                        track(player, best, dist, p.strain, now);
                     } else {
                        seen.put(best.getId(), now);
                        FIXATED.put(player.getUUID(), best.getId());
                        LAST_DIST.put(player.getUUID(), dist);
                        LAST_TRACK.put(player.getUUID(), now);
                        announce(player, best, dist, p.strain);
                        if (best.hasLineOfSight(player)) {
                           gaze(player, best, now);
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private static void track(ServerPlayer player, Mob host, double dist, SymbioteStrain mine, long now) {
      UUID id = player.getUUID();
      Integer fixed = FIXATED.get(id);
      if (fixed != null && fixed == host.getId()) {
         Long lastAt = LAST_TRACK.get(id);
         if (lastAt == null || now - lastAt >= 160L) {
            LAST_TRACK.put(id, now);
            if (WildHostBrain.isFeeding(host.getId())) {
               VoiceLines.sendAs(player, "symbiote.voice.wild_feeding", 0, mine);
               LAST_DIST.put(id, dist);
            } else if (WildHostBrain.stateOf(host.getId()) == WildHostBrain.State.STRIKING) {
               boolean los = host.hasLineOfSight(player);
               VoiceLines.sendAs(player, los ? "symbiote.voice.wild_coming" : "symbiote.voice.wild_coming_blind", 3, mine);
               if (los) {
                  gaze(player, host, now);
               }

               LAST_DIST.put(id, dist);
            } else {
               Double prev = LAST_DIST.get(id);
               LAST_DIST.put(id, dist);
               if (prev != null) {
                  double delta = prev - dist;
                  if (delta > 4.0) {
                     VoiceLines.sendAs(player, "symbiote.voice.wild_closer", 4, mine);
                  } else if (delta < -4.0) {
                     VoiceLines.sendAs(player, "symbiote.voice.wild_farther", 0, mine);
                  } else {
                     VoiceLines.sendAs(player, "symbiote.voice.wild_holding", 4, mine);
                  }
               }
            }
         }
      } else {
         FIXATED.put(id, host.getId());
         LAST_DIST.put(id, dist);
         LAST_TRACK.put(id, now);
      }
   }

   private static void announce(ServerPlayer player, Mob host, double distance, SymbioteStrain mine) {
      SymbioteStrain theirs = WildHost.strainOf(host);
      if (MET.computeIfAbsent(player.getUUID(), k -> new HashSet<>()).add(host.getId())) {
         if (host.hasLineOfSight(player)) {
            VoiceLines.sendAs(player, "symbiote.voice.wild_first", 4, mine);
         } else {
            MET_BLIND.computeIfAbsent(player.getUUID(), k -> new HashSet<>()).add(host.getId());
            VoiceLines.sendAs(player, "symbiote.voice.wild_first_blind", 4, mine);
         }
      } else {
         WildHostBrain.State state = WildHostBrain.stateOf(host.getId());
         boolean huntingYou = state == WildHostBrain.State.STRIKING;
         boolean awareOfYou = state != WildHostBrain.State.DORMANT;
         boolean stalking = state == WildHostBrain.State.STALKING || state == WildHostBrain.State.WATCHING;
         String pool;
         int tone;
         if (huntingYou) {
            pool = "symbiote.voice.wild_hunting";
            tone = 3;
         } else if (stalking) {
            pool = "symbiote.voice.wild_deciding";
            tone = 4;
         } else if (distance <= 8.0 && awareOfYou) {
            pool = "symbiote.voice.wild_deciding";
            tone = 4;
         } else if (!awareOfYou) {
            pool = "symbiote.voice.wild_unaware";
            tone = 0;
         } else if (distance <= 18.0) {
            pool = "symbiote.voice.wild_near";
            tone = 4;
         } else {
            pool = "symbiote.voice.wild_far";
            tone = 0;
         }

         if (theirs == mine && !huntingYou) {
            pool = "symbiote.voice.wild_kin";
            tone = 4;
         }

         VoiceLines.sendAs(player, pool, tone, mine);
         SymbioteLog.event(
            "WILD_HOST_SENSED player={} host={} type={} strain={} dist={} state={}",
            player.getUUID(),
            host.getId(),
            host.getType().toString(),
            theirs,
            String.format("%.1f", distance),
            state
         );
      }
   }

   private static void gaze(ServerPlayer player, Mob host, long now) {
      gaze(player, host, now, false);
   }

   private static void gaze(ServerPlayer player, Mob host, long now, boolean force) {
      Long last = LAST_GAZE.get(player.getUUID());
      if (force || last == null || now - last >= 600L) {
         LAST_GAZE.put(player.getUUID(), now);
         ModNetwork.sendOverrideFx(player, "gaze:" + host.getId(), 25);
         TendrilMantle.noteFixation(player, host);
      }
   }

   public static Set<Integer> hostsNear(UUID player) {
      Set<Integer> s = IN_RANGE.get(player);
      return s != null && !s.isEmpty() ? Set.copyOf(s) : Set.of();
   }

   public static boolean anyNear(UUID player) {
      Set<Integer> s = IN_RANGE.get(player);
      return s != null && !s.isEmpty();
   }

   public static void tickHeartbeat(ServerPlayer player, ServerLevel level, SymbioteProfile p, long now) {
      if (WildHost.enabled()) {
         if (p.stage.isBonded() && !p.isDormant(now)) {
            Double dist = NEAREST.get(player.getUUID());
            if (dist != null) {
               if (!(player.getHealth() / player.getMaxHealth() <= 0.45F)) {
                  if (!StrainPersona.isSilenced(player)) {
                     double range = Math.max(1.0, SymbioteConfig.WILD_HOST_SENSE_RANGE.get().intValue());
                     float f = (float)Math.min(1.0, Math.max(0.0, 1.0 - dist / range));
                     int interval = Math.max(1, Math.round(50.0F - 34.0F * f));
                     if (now % interval == 0L) {
                        player.playNotifySound((SoundEvent)ModSounds.HEARTBEAT.get(), SoundSource.PLAYERS, 0.3F + 0.55F * f, 0.9F + 0.3F * f);
                     }
                  }
               }
            }
         }
      }
   }

   public static void onLogout(UUID player) {
      ANNOUNCED.remove(player);
      IN_RANGE.remove(player);
      NEAREST.remove(player);
      MET.remove(player);
      MET_BLIND.remove(player);
      FIXATED.remove(player);
      LAST_DIST.remove(player);
      LAST_TRACK.remove(player);
      LAST_GAZE.remove(player);
   }

   private WildHostSense() {
   }
}
