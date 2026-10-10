package com.scout.symbiote.voice;

import com.scout.symbiote.ability.StrainPersona;
import com.scout.symbiote.ability.SymbioteCuriosity;
import com.scout.symbiote.ability.VoidFarewell;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.MoodEngine;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteStrain;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.tracker.TrustRework;
import com.scout.symbiote.util.SymbioteLog;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public final class VoiceLines {
   public static final int TONE_NEUTRAL = 0;
   public static final int TONE_BOND_UP = 1;
   public static final int TONE_BOND_DOWN = 2;
   public static final int TONE_AGGRESSIVE = 3;
   public static final int TONE_WARNING = 4;
   private static final Random RANDOM = new Random();
   private static final Map<String, List<String>> POOL = new HashMap<>();
   private static final Set<String> INTEGRATION_MUTE = Set.of("symbiote.voice.vindication", "symbiote.voice.carried");
   private static final Set<String> CHATTER = Set.of(
      "symbiote.voice.scavenge",
      "symbiote.voice.curiosity_notice",
      "symbiote.voice.curiosity_villager",
      "symbiote.voice.curiosity_walk",
      "symbiote.voice.curiosity_done",
      "symbiote.voice.chest_curious",
      "symbiote.voice.chest_sort",
      "symbiote.voice.chest_take",
      "symbiote.voice.taste_new",
      "symbiote.voice.taste_villager",
      "symbiote.voice.torch_place",
      "symbiote.voice.arm_instinct",
      "symbiote.voice.wild_farther",
      "symbiote.voice.wild_holding",
      "symbiote.voice.wild_unaware"
   );
   private static final int POOL_REPEAT_COOLDOWN_TICKS = 60;
   private static final Map<UUID, Map<String, Long>> LAST_SENT = new HashMap<>();
   private static final int GLOBAL_VOICE_GAP_TICKS = 30;
   private static final Map<UUID, Long> LAST_ANY = new HashMap<>();
   private static final Map<UUID, Map<String, String>> LAST_LINE = new HashMap<>();

   private static String stageBucket(SymbioteProfile p) {
      if (p == null) {
         return null;
      }

      return switch (p.stage) {
         case ATTACHED -> "attached";
         case INTEGRATED -> "integrated";
         case DOMINANT -> "dominant";
         default -> null;
      };
   }

   private static void pool(String poolKey, String... lineKeys) {
      POOL.put(poolKey, List.of(lineKeys));
   }

   public static void sendAs(ServerPlayer player, String poolKey, int toneCode, SymbioteStrain speaker) {
      sendInternal(player, poolKey, toneCode, speaker == null ? -1 : speaker.ordinal());
   }

   public static void send(ServerPlayer player, String poolKey, int toneCode) {
      sendInternal(player, poolKey, toneCode, -1);
   }

   private static void sendInternal(ServerPlayer player, String poolKey, int toneCode, int speakerStrain) {
      if (!StrainPersona.isSilenced(player)) {
         long now = player.serverLevel().getGameTime();
         if (!VoidFarewell.inDyingSilence(player.getUUID(), now) || poolKey.startsWith("symbiote.voice.void_farewell")) {
            SymbioteProfile prof = SymbioteTracker.get(player.serverLevel()).peek(player.getUUID());
            if (prof != null
               && prof.isDormant(now)
               && !"symbiote.voice.dormant".equals(poolKey)
               && !"symbiote.voice.revival_collapse".equals(poolKey)
               && !"symbiote.voice.carried".equals(poolKey)
               && !"symbiote.voice.dormant_combat".equals(poolKey)) {
               SymbioteLog.event("VOICE_DORMANT_SWALLOWED pool={} player={}", poolKey, player.getUUID());
            } else if (prof != null && MoodEngine.current(prof) == MoodEngine.Mood.GRIEVING && toneCode != 4 && toneCode != 3 && RANDOM.nextFloat() < 0.35F) {
               SymbioteLog.event("VOICE_GRIEF_SWALLOWED pool={} player={}", poolKey, player.getUUID());
            } else if (prof == null
               || prof.instabilityUntilTick <= now
               || !INTEGRATION_MUTE.contains(poolKey) && (!CHATTER.contains(poolKey) || toneCode == 4 || toneCode == 3)) {
               String bucket = stageBucket(prof);
               if (bucket != null && CHATTER.contains(poolKey) && toneCode != 4 && toneCode != 3) {
                  float swallow = switch (bucket) {
                     case "attached" -> 0.5F;
                     case "integrated" -> 0.25F;
                     default -> 0.2F;
                  };
                  if (RANDOM.nextFloat() < swallow) {
                     SymbioteLog.event("VOICE_STAGE_SWALLOWED pool={} bucket={} player={}", poolKey, bucket, player.getUUID());
                     return;
                  }
               }

               if (SymbioteCuriosity.isFocused(player.getUUID())
                  && toneCode != 4
                  && toneCode != 3
                  && !poolKey.startsWith("symbiote.voice.curiosity")
                  && !poolKey.startsWith("symbiote.voice.taste")) {
                  SymbioteLog.event("VOICE_FOCUS_SWALLOWED pool={} player={}", poolKey, player.getUUID());
               } else {
                  Long lastAny = LAST_ANY.get(player.getUUID());
                  if (lastAny != null && now < lastAny) {
                     SymbioteLog.event("VOICE_CLOCK_SKEW_HEALED player={} last={} now={}", player.getUUID(), lastAny, now);
                     LAST_ANY.remove(player.getUUID());
                     LAST_SENT.remove(player.getUUID());
                     lastAny = null;
                  }

                  boolean priority = "symbiote.voice.desire_taken_done".equals(poolKey) || "symbiote.voice.ability_too_soon".equals(poolKey);
                  if (!priority && lastAny != null && now - lastAny < 30L) {
                     SymbioteLog.event("VOICE_OVERLAP_SWALLOWED pool={} player={}", poolKey, player.getUUID());
                  } else {
                     Map<String, Long> per = LAST_SENT.computeIfAbsent(player.getUUID(), k -> new HashMap<>());
                     Long last = per.get(poolKey);
                     if (last == null || now - last >= 60L) {
                        per.put(poolKey, now);
                        LAST_ANY.put(player.getUUID(), now);
                        String resolvedPool;
                        if (bucket != null && POOL.containsKey(poolKey + "." + bucket)) {
                           resolvedPool = poolKey + "." + bucket;
                        } else {
                           resolvedPool = applyToneBias(player, poolKey);
                        }

                        List<String> lines = POOL.get(resolvedPool);
                        if (lines != null && !lines.isEmpty()) {
                           String chosen = lines.get(RANDOM.nextInt(lines.size()));
                           Map<String, String> lastLines = LAST_LINE.computeIfAbsent(player.getUUID(), k -> new HashMap<>());
                           if (lines.size() > 1 && chosen.equals(lastLines.get(resolvedPool))) {
                              int shift = 1 + RANDOM.nextInt(lines.size() - 1);
                              chosen = lines.get((lines.indexOf(chosen) + shift) % lines.size());
                           }

                           lastLines.put(resolvedPool, chosen);
                           SymbioteLog.event("VOICE_FIRED pool={} line={} tone={} player={}", resolvedPool, chosen, toneCode, player.getUUID());
                           ModNetwork.sendSubtitle(player, chosen, toneCode, speakerStrain);
                        } else {
                           SymbioteLog.event("VOICE_POOL_MISSING pool={} fallback=key_passthrough", resolvedPool);
                           ModNetwork.sendSubtitle(player, resolvedPool, toneCode, speakerStrain);
                        }
                     }
                  }
               }
            } else {
               SymbioteLog.event("VOICE_INTEGRATION_SWALLOWED pool={} player={}", poolKey, player.getUUID());
            }
         }
      }
   }

   public static void sendLiteral(ServerPlayer player, String text, int toneCode) {
      ModNetwork.sendSubtitle(player, "literal:" + text, toneCode);
   }

   private static String applyToneBias(ServerPlayer player, String poolKey) {
      ServerLevel level = player.serverLevel();
      SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
      if (p == null) {
         return poolKey;
      }

      String warm = poolKey + ".warm";
      String hostile = poolKey + ".hostile";
      String neutral = poolKey + ".neutral";
      MoodEngine.Mood mood = MoodEngine.current(p);
      boolean tr = TrustRework.live();
      int warmAt = tr ? 75 : 70;
      int hostileAt = tr ? 40 : 30;
      switch (mood) {
         case CONTENT:
            warmAt = tr ? 60 : 55;
            break;
         case COILED:
            hostileAt = tr ? 48 : 45;
            break;
         case GRIEVING:
            warmAt = tr ? 88 : 85;
      }

      if (p.trust >= warmAt && POOL.containsKey(warm)) {
         return warm;
      } else if (p.trust < hostileAt && POOL.containsKey(hostile)) {
         return hostile;
      } else {
         return POOL.containsKey(neutral) ? neutral : poolKey;
      }
   }

   public static void onLogout(UUID player) {
      LAST_SENT.remove(player);
      LAST_LINE.remove(player);
   }

   private VoiceLines() {
   }

   static {
      pool(
         "symbiote.voice.bond_attached",
         "symbiote.voice.bond_attached.1",
         "symbiote.voice.bond_attached.2",
         "symbiote.voice.bond_attached.3",
         "symbiote.voice.bond_attached.4",
         "symbiote.voice.bond_attached.5"
      );
      pool("symbiote.voice.rejection", "symbiote.voice.rejection.1", "symbiote.voice.rejection.2", "symbiote.voice.rejection.3", "symbiote.voice.rejection.4");
      pool(
         "symbiote.voice.consumption",
         "symbiote.voice.consumption.1",
         "symbiote.voice.consumption.2",
         "symbiote.voice.consumption.3",
         "symbiote.voice.consumption.4"
      );
      pool("symbiote.voice.dormant", "symbiote.voice.dormant.1", "symbiote.voice.dormant.2", "symbiote.voice.dormant.3", "symbiote.voice.dormant.4");
      pool(
         "symbiote.voice.stage_promote",
         "symbiote.voice.stage_promote.1",
         "symbiote.voice.stage_promote.2",
         "symbiote.voice.stage_promote.3",
         "symbiote.voice.stage_promote.4"
      );
      pool(
         "symbiote.voice.stage_cooperative",
         "symbiote.voice.stage_cooperative.1",
         "symbiote.voice.stage_cooperative.2",
         "symbiote.voice.stage_cooperative.3",
         "symbiote.voice.stage_cooperative.4"
      );
      pool(
         "symbiote.voice.stage_dominant",
         "symbiote.voice.stage_dominant.1",
         "symbiote.voice.stage_dominant.2",
         "symbiote.voice.stage_dominant.3",
         "symbiote.voice.stage_dominant.4"
      );
      pool("symbiote.voice.first_crossing", "symbiote.voice.first_crossing.1", "symbiote.voice.first_crossing.2", "symbiote.voice.first_crossing.3");
      pool(
         "symbiote.voice.stage_demote",
         "symbiote.voice.stage_demote.1",
         "symbiote.voice.stage_demote.2",
         "symbiote.voice.stage_demote.3",
         "symbiote.voice.stage_demote.4"
      );
      pool("symbiote.voice.defiance", "symbiote.voice.defiance.1", "symbiote.voice.defiance.2", "symbiote.voice.defiance.3", "symbiote.voice.defiance.4");
      pool(
         "symbiote.voice.defiance_action",
         "symbiote.voice.defiance_action.1",
         "symbiote.voice.defiance_action.2",
         "symbiote.voice.defiance_action.3",
         "symbiote.voice.defiance_action.4"
      );
      pool("symbiote.voice.tendril_lash", "symbiote.voice.tendril_lash.1", "symbiote.voice.tendril_lash.2", "symbiote.voice.tendril_lash.3");
      pool("symbiote.voice.carapace", "symbiote.voice.carapace.1", "symbiote.voice.carapace.2", "symbiote.voice.carapace.3");
      pool("symbiote.voice.frenzy", "symbiote.voice.frenzy.1", "symbiote.voice.frenzy.2", "symbiote.voice.frenzy.3", "symbiote.voice.frenzy.4");
      pool("symbiote.voice.apex", "symbiote.voice.apex.1", "symbiote.voice.apex.2", "symbiote.voice.apex.3");
      pool(
         "symbiote.voice.control_struggle",
         "symbiote.voice.control_struggle.1",
         "symbiote.voice.control_struggle.2",
         "symbiote.voice.control_struggle.3",
         "symbiote.voice.control_struggle.4"
      );
      pool("symbiote.voice.exhausted", "symbiote.voice.exhausted.1", "symbiote.voice.exhausted.2", "symbiote.voice.exhausted.3");
      pool("symbiote.voice.consume", "symbiote.voice.consume.1", "symbiote.voice.consume.2", "symbiote.voice.consume.3");
      pool("symbiote.voice.aegis", "symbiote.voice.aegis.1", "symbiote.voice.aegis.2");
      pool("symbiote.voice.rupture", "symbiote.voice.rupture.1", "symbiote.voice.rupture.2");
      pool("symbiote.voice.nightstep", "symbiote.voice.nightstep.1", "symbiote.voice.nightstep.2");
      pool("symbiote.voice.screech", "symbiote.voice.screech.1", "symbiote.voice.screech.2");
      pool("symbiote.voice.onslaught", "symbiote.voice.onslaught.1", "symbiote.voice.onslaught.2", "symbiote.voice.onslaught.3");
      pool("symbiote.voice.desire_flesh", "symbiote.voice.desire_flesh.1", "symbiote.voice.desire_flesh.2");
      pool("symbiote.voice.desire_blood", "symbiote.voice.desire_blood.1", "symbiote.voice.desire_blood.2");
      pool("symbiote.voice.desire_deep", "symbiote.voice.desire_deep.1", "symbiote.voice.desire_deep.2");
      pool("symbiote.voice.desire_night", "symbiote.voice.desire_night.1", "symbiote.voice.desire_night.2");
      pool("symbiote.voice.desire_shell", "symbiote.voice.desire_shell.1", "symbiote.voice.desire_shell.2");
      pool("symbiote.voice.desire_sated", "symbiote.voice.desire_sated.1", "symbiote.voice.desire_sated.2");
      pool("symbiote.voice.desire_sated.warm", "symbiote.voice.desire_sated.warm.1");
      pool("symbiote.voice.desire_denied", "symbiote.voice.desire_denied.1", "symbiote.voice.desire_denied.2");
      pool("symbiote.voice.desire_denied.hostile", "symbiote.voice.desire_denied.hostile.1");
      pool("symbiote.voice.tantrum_blood", "symbiote.voice.tantrum_blood.1", "symbiote.voice.tantrum_blood.2");
      pool("symbiote.voice.tantrum_deep", "symbiote.voice.tantrum_deep.1", "symbiote.voice.tantrum_deep.2");
      pool("symbiote.voice.tantrum_deep_dig", "symbiote.voice.tantrum_deep.1");
      pool("symbiote.voice.mantle_busy_shell", "symbiote.voice.mantle_busy.2");
      pool("symbiote.voice.curiosity_lost", "symbiote.voice.curiosity_lost.1");
      pool("symbiote.voice.tantrum_night", "symbiote.voice.tantrum_night.1");
      pool("symbiote.voice.tantrum_shell", "symbiote.voice.tantrum_shell.1", "symbiote.voice.tantrum_shell.2");
      pool("symbiote.voice.seizure_resist", "symbiote.voice.seizure_resist.1", "symbiote.voice.seizure_resist.2", "symbiote.voice.seizure_resist.3");
      pool("symbiote.voice.seizure_release", "symbiote.voice.seizure_release.1");
      pool("symbiote.voice.seizure_walk", "symbiote.voice.seizure_walk.1", "symbiote.voice.seizure_walk.2", "symbiote.voice.seizure_walk.3");
      pool("symbiote.voice.stalk", "symbiote.voice.stalk.1", "symbiote.voice.stalk.2");
      pool("symbiote.voice.door_rip", "symbiote.voice.door_rip.1", "symbiote.voice.door_rip.2");
      pool("symbiote.voice.curiosity_notice", "symbiote.voice.curiosity_notice.1", "symbiote.voice.curiosity_notice.2", "symbiote.voice.curiosity_notice.3");
      pool("symbiote.voice.curiosity_villager", "symbiote.voice.curiosity_villager.1", "symbiote.voice.curiosity_villager.2");
      pool("symbiote.voice.curiosity_walk", "symbiote.voice.curiosity_walk.1", "symbiote.voice.curiosity_walk.2");
      pool("symbiote.voice.curiosity_done", "symbiote.voice.curiosity_done.1", "symbiote.voice.curiosity_done.2");
      pool("symbiote.voice.taste_new", "symbiote.voice.taste_new.1", "symbiote.voice.taste_new.2", "symbiote.voice.taste_new.3");
      pool("symbiote.voice.taste_villager", "symbiote.voice.taste_villager.1");
      pool("symbiote.voice.encounter_thunder", "symbiote.voice.encounter_thunder.1");
      pool("symbiote.voice.encounter_nether", "symbiote.voice.encounter_nether.1");
      pool("symbiote.voice.encounter_end", "symbiote.voice.encounter_end.1");
      pool("symbiote.voice.encounter_deep_dark", "symbiote.voice.encounter_deep_dark.1");
      pool("symbiote.voice.drowning", "symbiote.voice.drowning.1", "symbiote.voice.drowning.2");
      pool("symbiote.voice.suffocate_out", "symbiote.voice.suffocate_out.1");
      pool("symbiote.voice.freeze_escape", "symbiote.voice.freeze_escape.1");
      pool("symbiote.voice.host_feed", "symbiote.voice.host_feed.1", "symbiote.voice.host_feed.2");
      pool("symbiote.voice.warden_silence", "symbiote.voice.warden_silence.1");
      pool("symbiote.voice.guardian_ledge", "symbiote.voice.guardian_ledge.1", "symbiote.voice.guardian_ledge.2");
      pool("symbiote.voice.royal_carrion", "symbiote.voice.royal_carrion.1", "symbiote.voice.royal_carrion.2");
      pool("symbiote.voice.shadow_dark", "symbiote.voice.shadow_dark.1", "symbiote.voice.shadow_dark.2");
      pool("symbiote.voice.chest_curious", "symbiote.voice.chest_curious.1", "symbiote.voice.chest_curious.2");
      pool("symbiote.voice.chest_take", "symbiote.voice.chest_take.1");
      pool("symbiote.voice.chest_loot", "symbiote.voice.chest_loot.1", "symbiote.voice.chest_loot.2");
      pool("symbiote.voice.chest_sort", "symbiote.voice.chest_sort.1", "symbiote.voice.chest_sort.2");
      pool("symbiote.voice.chest_steal", "symbiote.voice.chest_steal.1", "symbiote.voice.chest_steal.2");
      pool("symbiote.voice.arm_reclaim", "symbiote.voice.arm_reclaim.1", "symbiote.voice.arm_reclaim.2");
      pool("symbiote.voice.torch_place", "symbiote.voice.torch_place.1");
      pool("symbiote.voice.feed_full", "symbiote.voice.feed_full.1", "symbiote.voice.feed_full.2");
      pool("symbiote.voice.neglect", "symbiote.voice.neglect.1", "symbiote.voice.neglect.2");
      pool("symbiote.voice.revival_collapse", "symbiote.voice.revival_collapse.1", "symbiote.voice.revival_collapse.2");
      pool("symbiote.voice.command_burst.protect_me", "symbiote.voice.command_burst.protect_me.1", "symbiote.voice.command_burst.protect_me.2");
      pool("symbiote.voice.command_burst.hunt", "symbiote.voice.command_burst.hunt.1", "symbiote.voice.command_burst.hunt.2");
      pool("symbiote.voice.command_burst.hide", "symbiote.voice.command_burst.hide.1", "symbiote.voice.command_burst.hide.2");
      pool("symbiote.voice.arms_take", "symbiote.voice.arms_take.1", "symbiote.voice.arms_take.2", "symbiote.voice.arms_take.3");
      pool("symbiote.voice.mantle_locked", "symbiote.voice.mantle_locked.1", "symbiote.voice.mantle_locked.2");
      pool("symbiote.voice.mantle_refuse", "symbiote.voice.mantle_refuse.1", "symbiote.voice.mantle_refuse.2");
      pool("symbiote.voice.mantle_busy", "symbiote.voice.mantle_busy.1");
      pool("symbiote.voice.mantle_refuse_edge", "symbiote.voice.mantle_refuse_edge.1", "symbiote.voice.mantle_refuse_edge.2");
      pool(
         "symbiote.voice.mantle_refuse_edge_threat",
         "symbiote.voice.mantle_refuse_edge.3",
         "symbiote.voice.mantle_refuse_edge.1",
         "symbiote.voice.mantle_refuse_edge.2"
      );
      pool("symbiote.voice.armor_too_soon", "symbiote.voice.armor_too_soon.1", "symbiote.voice.armor_too_soon.2");
      pool("symbiote.voice.armor_starved", "symbiote.voice.armor_starved.1", "symbiote.voice.armor_starved.2");
      pool("symbiote.voice.ability_too_soon", "symbiote.voice.ability_too_soon.1", "symbiote.voice.ability_too_soon.2");
      pool("symbiote.voice.ability_no_target", "symbiote.voice.ability_no_target.1", "symbiote.voice.ability_no_target.2");
      pool("symbiote.voice.ability_no_grip", "symbiote.voice.ability_no_grip.1", "symbiote.voice.ability_no_grip.2");
      pool("symbiote.voice.dominant_assert", "symbiote.voice.dominant_assert.1", "symbiote.voice.dominant_assert.2", "symbiote.voice.dominant_assert.3");
      pool("symbiote.voice.desire_taken_done", "symbiote.voice.desire_taken_done.1", "symbiote.voice.desire_taken_done.2");
      pool("symbiote.voice.arms_off", "symbiote.voice.arms_off.1", "symbiote.voice.arms_off.2", "symbiote.voice.arms_off.3");
      pool("symbiote.voice.arms_on", "symbiote.voice.arms_on.1", "symbiote.voice.arms_on.2", "symbiote.voice.arms_on.3");
      pool("symbiote.voice.arms_locked", "symbiote.voice.arms_locked.1", "symbiote.voice.arms_locked.2");
      pool("symbiote.voice.wall", "symbiote.voice.wall.1", "symbiote.voice.wall.2", "symbiote.voice.wall.3");
      pool("symbiote.voice.build_bridge", "symbiote.voice.build_bridge.1", "symbiote.voice.build_bridge.2", "symbiote.voice.build_bridge.3");
      pool("symbiote.voice.build_staircase", "symbiote.voice.build_staircase.1", "symbiote.voice.build_staircase.2", "symbiote.voice.build_staircase.3");
      pool("symbiote.voice.scavenge", "symbiote.voice.scavenge.1", "symbiote.voice.scavenge.2", "symbiote.voice.scavenge.3");
      pool("symbiote.voice.wall_nomaterial", "symbiote.voice.wall_nomaterial.1", "symbiote.voice.wall_nomaterial.2");
      pool(
         "symbiote.voice.bond_up.warm",
         "symbiote.voice.bond_up.warm.1",
         "symbiote.voice.bond_up.warm.2",
         "symbiote.voice.bond_up.warm.3",
         "symbiote.voice.bond_up.warm.4",
         "symbiote.voice.bond_up.warm.5"
      );
      pool(
         "symbiote.voice.bond_up.neutral",
         "symbiote.voice.bond_up.neutral.1",
         "symbiote.voice.bond_up.neutral.2",
         "symbiote.voice.bond_up.neutral.3",
         "symbiote.voice.bond_up.neutral.4"
      );
      pool("symbiote.voice.bond_up.hostile", "symbiote.voice.bond_up.hostile.1", "symbiote.voice.bond_up.hostile.2", "symbiote.voice.bond_up.hostile.3");
      pool(
         "symbiote.voice.bond_down.hostile",
         "symbiote.voice.bond_down.hostile.1",
         "symbiote.voice.bond_down.hostile.2",
         "symbiote.voice.bond_down.hostile.3",
         "symbiote.voice.bond_down.hostile.4",
         "symbiote.voice.bond_down.hostile.5"
      );
      pool(
         "symbiote.voice.bond_down.neutral",
         "symbiote.voice.bond_down.neutral.1",
         "symbiote.voice.bond_down.neutral.2",
         "symbiote.voice.bond_down.neutral.3",
         "symbiote.voice.bond_down.neutral.4"
      );
      pool("symbiote.voice.bond_down.warm", "symbiote.voice.bond_down.warm.1", "symbiote.voice.bond_down.warm.2", "symbiote.voice.bond_down.warm.3");
      pool(
         "symbiote.voice.creeper_save",
         "symbiote.voice.creeper_save.1",
         "symbiote.voice.creeper_save.2",
         "symbiote.voice.creeper_save.3",
         "symbiote.voice.creeper_save.4"
      );
      pool("symbiote.voice.careless", "symbiote.voice.careless.1", "symbiote.voice.careless.2", "symbiote.voice.careless.3");
      pool("symbiote.voice.dormant_combat", "symbiote.voice.dormant_combat.1", "symbiote.voice.dormant_combat.2");
      pool(
         "symbiote.voice.shadow_night",
         "symbiote.voice.shadow_night.1",
         "symbiote.voice.shadow_night.2",
         "symbiote.voice.shadow_night.3",
         "symbiote.voice.shadow_night.4",
         "symbiote.voice.shadow_night.5"
      );
      pool(
         "symbiote.voice.curiosity_squish",
         "symbiote.voice.curiosity_squish.1",
         "symbiote.voice.curiosity_squish.2",
         "symbiote.voice.curiosity_squish.3",
         "symbiote.voice.curiosity_squish.4",
         "symbiote.voice.curiosity_squish.5"
      );
      pool("symbiote.voice.rescue_reflex", "symbiote.voice.rescue_reflex.1", "symbiote.voice.rescue_reflex.3");
      pool("symbiote.voice.creeper_notice", "symbiote.voice.creeper_notice.1", "symbiote.voice.creeper_notice.2");
      pool("symbiote.voice.fall_hurt", "symbiote.voice.fall_hurt.1");
      pool(
         "symbiote.voice.sculk_city",
         "symbiote.voice.sculk_city.1",
         "symbiote.voice.sculk_city.2",
         "symbiote.voice.sculk_city.3",
         "symbiote.voice.sculk_city.4",
         "symbiote.voice.sculk_city.5"
      );
      pool("symbiote.voice.rescue_bleed", "symbiote.voice.rescue_reflex.2", "symbiote.voice.rescue_reflex.1", "symbiote.voice.rescue_reflex.3");
      pool(
         "symbiote.voice.fire_panic",
         "symbiote.voice.fire_panic.1",
         "symbiote.voice.fire_panic.2",
         "symbiote.voice.fire_panic.3",
         "symbiote.voice.fire_panic.4",
         "symbiote.voice.fire_panic.5"
      );
      pool(
         "symbiote.voice.low_health",
         "symbiote.voice.low_health.1",
         "symbiote.voice.low_health.2",
         "symbiote.voice.low_health.3",
         "symbiote.voice.low_health.4",
         "symbiote.voice.low_health.5"
      );
      pool(
         "symbiote.voice.hunger_override",
         "symbiote.voice.hunger_override.1",
         "symbiote.voice.hunger_override.2",
         "symbiote.voice.hunger_override.3",
         "symbiote.voice.hunger_override.4",
         "symbiote.voice.hunger_override.5"
      );
      pool("symbiote.voice.void_farewell", "symbiote.voice.void_farewell.1", "symbiote.voice.void_farewell.2", "symbiote.voice.void_farewell.3");
      pool(
         "symbiote.voice.hunger_low",
         "symbiote.voice.hunger_low.1",
         "symbiote.voice.hunger_low.2",
         "symbiote.voice.hunger_low.3",
         "symbiote.voice.hunger_low.4"
      );
      pool(
         "symbiote.voice.hunger_starving",
         "symbiote.voice.hunger_starving.1",
         "symbiote.voice.hunger_starving.2",
         "symbiote.voice.hunger_starving.3",
         "symbiote.voice.hunger_starving.4",
         "symbiote.voice.hunger_starving.5"
      );
      pool(
         "symbiote.voice.instability",
         "symbiote.voice.instability.1",
         "symbiote.voice.instability.2",
         "symbiote.voice.instability.3",
         "symbiote.voice.instability.4",
         "symbiote.voice.instability.5"
      );
      pool(
         "symbiote.voice.command_obeyed.protect_me",
         "symbiote.voice.command_obeyed.protect_me.1",
         "symbiote.voice.command_obeyed.protect_me.2",
         "symbiote.voice.command_obeyed.protect_me.3"
      );
      pool(
         "symbiote.voice.command_obeyed.protect_me.warm",
         "symbiote.voice.command_obeyed.protect_me.warm.1",
         "symbiote.voice.command_obeyed.protect_me.warm.2",
         "symbiote.voice.command_obeyed.protect_me.warm.3"
      );
      pool(
         "symbiote.voice.command_obeyed.protect_me.hostile",
         "symbiote.voice.command_obeyed.protect_me.hostile.1",
         "symbiote.voice.command_obeyed.protect_me.hostile.2",
         "symbiote.voice.command_obeyed.protect_me.hostile.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hunt",
         "symbiote.voice.command_obeyed.hunt.1",
         "symbiote.voice.command_obeyed.hunt.2",
         "symbiote.voice.command_obeyed.hunt.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hunt.warm",
         "symbiote.voice.command_obeyed.hunt.warm.1",
         "symbiote.voice.command_obeyed.hunt.warm.2",
         "symbiote.voice.command_obeyed.hunt.warm.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hunt.hostile",
         "symbiote.voice.command_obeyed.hunt.hostile.1",
         "symbiote.voice.command_obeyed.hunt.hostile.2",
         "symbiote.voice.command_obeyed.hunt.hostile.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hide",
         "symbiote.voice.command_obeyed.hide.1",
         "symbiote.voice.command_obeyed.hide.2",
         "symbiote.voice.command_obeyed.hide.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hide.warm",
         "symbiote.voice.command_obeyed.hide.warm.1",
         "symbiote.voice.command_obeyed.hide.warm.2",
         "symbiote.voice.command_obeyed.hide.warm.3"
      );
      pool(
         "symbiote.voice.command_obeyed.hide.hostile",
         "symbiote.voice.command_obeyed.hide.hostile.1",
         "symbiote.voice.command_obeyed.hide.hostile.2",
         "symbiote.voice.command_obeyed.hide.hostile.3"
      );
      pool(
         "symbiote.voice.command_ignored",
         "symbiote.voice.command_ignored.1",
         "symbiote.voice.command_ignored.2",
         "symbiote.voice.command_ignored.3",
         "symbiote.voice.command_ignored.4"
      );
      pool("symbiote.voice.command_standdown", "symbiote.voice.command_standdown.1", "symbiote.voice.command_standdown.2", "symbiote.voice.command_standdown.3");
      pool("symbiote.voice.command_exhausted", "symbiote.voice.command_exhausted.1", "symbiote.voice.command_exhausted.2", "symbiote.voice.command_exhausted.3");
      pool("symbiote.voice.revival", "symbiote.voice.revival.1", "symbiote.voice.revival.2", "symbiote.voice.revival.3");
      pool("symbiote.voice.emergency_regen", "symbiote.voice.emergency_regen.1", "symbiote.voice.emergency_regen.2", "symbiote.voice.emergency_regen.3");
      pool("symbiote.voice.retaliate", "symbiote.voice.retaliate.1", "symbiote.voice.retaliate.2");
      pool("symbiote.voice.armor_assert", "symbiote.voice.armor_assert.1", "symbiote.voice.armor_assert.2", "symbiote.voice.armor_assert.3");
      pool("symbiote.voice.vindication", "symbiote.voice.vindication.1", "symbiote.voice.vindication.2", "symbiote.voice.vindication.3");
      pool(
         "symbiote.voice.vindication.dominant",
         "symbiote.voice.vindication.dominant.1",
         "symbiote.voice.vindication.dominant.2",
         "symbiote.voice.vindication.dominant.3",
         "symbiote.voice.vindication.dominant.4"
      );
      pool("symbiote.voice.carried", "symbiote.voice.carried.1", "symbiote.voice.carried.2", "symbiote.voice.carried.3");
      pool("symbiote.voice.vindication.warm", "symbiote.voice.vindication.warm.1", "symbiote.voice.vindication.warm.2", "symbiote.voice.vindication.warm.3");
      pool("symbiote.voice.vindication.hostile", "symbiote.voice.vindication.hostile.1", "symbiote.voice.vindication.hostile.2");
      pool(
         "symbiote.voice.ability_reject",
         "symbiote.voice.ability_reject.1",
         "symbiote.voice.ability_reject.2",
         "symbiote.voice.ability_reject.3",
         "symbiote.voice.ability_reject.4"
      );
      pool(
         "symbiote.voice.tendril_yank",
         "symbiote.voice.tendril_yank.1",
         "symbiote.voice.tendril_yank.2",
         "symbiote.voice.tendril_yank.3",
         "symbiote.voice.tendril_yank.4"
      );
      pool("symbiote.voice.hunger_override.attached", "symbiote.voice.hunger_override.attached.1", "symbiote.voice.hunger_override.attached.2");
      pool("symbiote.voice.hunger_override.integrated", "symbiote.voice.hunger_override.integrated.1", "symbiote.voice.hunger_override.integrated.2");
      pool("symbiote.voice.hunger_override.dominant", "symbiote.voice.hunger_override.dominant.1", "symbiote.voice.hunger_override.dominant.2");
      pool("symbiote.voice.fire_panic.attached", "symbiote.voice.fire_panic.attached.1", "symbiote.voice.fire_panic.attached.2");
      pool("symbiote.voice.fire_panic.integrated", "symbiote.voice.fire_panic.integrated.1", "symbiote.voice.fire_panic.integrated.2");
      pool("symbiote.voice.fire_panic.dominant", "symbiote.voice.fire_panic.dominant.1", "symbiote.voice.fire_panic.dominant.2");
      pool("symbiote.voice.low_health.attached", "symbiote.voice.low_health.attached.1", "symbiote.voice.low_health.attached.2");
      pool("symbiote.voice.low_health.integrated", "symbiote.voice.low_health.integrated.1", "symbiote.voice.low_health.integrated.2");
      pool(
         "symbiote.voice.low_health.dominant",
         "symbiote.voice.low_health.dominant.1",
         "symbiote.voice.low_health.dominant.2",
         "symbiote.voice.low_health.dominant.3"
      );
      pool("symbiote.voice.drowning.attached", "symbiote.voice.drowning.attached.1", "symbiote.voice.drowning.attached.2");
      pool("symbiote.voice.drowning.integrated", "symbiote.voice.drowning.integrated.1", "symbiote.voice.drowning.integrated.2");
      pool("symbiote.voice.drowning.dominant", "symbiote.voice.drowning.dominant.1", "symbiote.voice.drowning.dominant.2");
      pool("symbiote.voice.creeper_save.attached", "symbiote.voice.creeper_save.attached.1", "symbiote.voice.creeper_save.attached.2");
      pool("symbiote.voice.creeper_save.integrated", "symbiote.voice.creeper_save.integrated.1", "symbiote.voice.creeper_save.integrated.2");
      pool("symbiote.voice.creeper_save.dominant", "symbiote.voice.creeper_save.dominant.1", "symbiote.voice.creeper_save.dominant.2");
      pool("symbiote.voice.seizure_walk.attached", "symbiote.voice.seizure_walk.attached.1", "symbiote.voice.seizure_walk.attached.2");
      pool("symbiote.voice.seizure_walk.integrated", "symbiote.voice.seizure_walk.integrated.1", "symbiote.voice.seizure_walk.integrated.2");
      pool("symbiote.voice.seizure_walk.dominant", "symbiote.voice.seizure_walk.dominant.1", "symbiote.voice.seizure_walk.dominant.2");
      pool("symbiote.voice.seizure_release.attached", "symbiote.voice.seizure_release.attached.1", "symbiote.voice.seizure_release.attached.2");
      pool("symbiote.voice.seizure_release.integrated", "symbiote.voice.seizure_release.integrated.1");
      pool("symbiote.voice.seizure_release.dominant", "symbiote.voice.seizure_release.dominant.1", "symbiote.voice.seizure_release.dominant.2");
      pool("symbiote.voice.desire_flesh.attached", "symbiote.voice.desire_flesh.attached.1", "symbiote.voice.desire_flesh.attached.2");
      pool("symbiote.voice.desire_flesh.integrated", "symbiote.voice.desire_flesh.integrated.1");
      pool("symbiote.voice.desire_flesh.dominant", "symbiote.voice.desire_flesh.dominant.1");
      pool("symbiote.voice.desire_blood.attached", "symbiote.voice.desire_blood.attached.1", "symbiote.voice.desire_blood.attached.2");
      pool("symbiote.voice.desire_blood.integrated", "symbiote.voice.desire_blood.integrated.1");
      pool("symbiote.voice.desire_blood.dominant", "symbiote.voice.desire_blood.dominant.1");
      pool("symbiote.voice.living_armor_on.attached", "symbiote.voice.living_armor_on.attached.1", "symbiote.voice.living_armor_on.attached.2");
      pool("symbiote.voice.living_armor_on.integrated", "symbiote.voice.living_armor_on.integrated.1", "symbiote.voice.living_armor_on.integrated.2");
      pool("symbiote.voice.living_armor_on.dominant", "symbiote.voice.living_armor_on.dominant.1", "symbiote.voice.living_armor_on.dominant.2");
      pool("symbiote.voice.tendril_yank.attached", "symbiote.voice.tendril_yank.attached.1", "symbiote.voice.tendril_yank.attached.2");
      pool("symbiote.voice.tendril_yank.integrated", "symbiote.voice.tendril_yank.integrated.1");
      pool("symbiote.voice.tendril_yank.dominant", "symbiote.voice.tendril_yank.dominant.1", "symbiote.voice.tendril_yank.dominant.2");
      pool("symbiote.voice.scavenge.attached", "symbiote.voice.scavenge.attached.1", "symbiote.voice.scavenge.attached.2");
      pool("symbiote.voice.scavenge.integrated", "symbiote.voice.scavenge.integrated.1", "symbiote.voice.scavenge.integrated.2");
      pool("symbiote.voice.scavenge.dominant", "symbiote.voice.scavenge.dominant.1", "symbiote.voice.scavenge.dominant.2");
      pool("symbiote.voice.consume.attached", "symbiote.voice.consume.attached.1", "symbiote.voice.consume.attached.2");
      pool("symbiote.voice.consume.integrated", "symbiote.voice.consume.integrated.1");
      pool("symbiote.voice.consume.dominant", "symbiote.voice.consume.dominant.1", "symbiote.voice.consume.dominant.2");
      pool("symbiote.voice.feed_accepted.attached", "symbiote.voice.feed_accepted.attached.1", "symbiote.voice.feed_accepted.attached.2");
      pool("symbiote.voice.feed_accepted.integrated", "symbiote.voice.feed_accepted.integrated.1");
      pool("symbiote.voice.feed_accepted.dominant", "symbiote.voice.feed_accepted.dominant.1", "symbiote.voice.feed_accepted.dominant.2");
      pool("symbiote.voice.wild_first", "symbiote.voice.wild_first.1", "symbiote.voice.wild_first.2", "symbiote.voice.wild_first.3");
      pool("symbiote.voice.wild_first_blind", "symbiote.voice.wild_first_blind.1", "symbiote.voice.wild_first_blind.2", "symbiote.voice.wild_first_blind.3");
      pool("symbiote.voice.wild_seen", "symbiote.voice.wild_seen.1", "symbiote.voice.wild_seen.2", "symbiote.voice.wild_seen.3");
      pool("symbiote.voice.predator_notice", "symbiote.voice.predator_notice.1", "symbiote.voice.predator_notice.2");
      pool("symbiote.voice.predator_hunt", "symbiote.voice.predator_hunt.1", "symbiote.voice.predator_hunt.2", "symbiote.voice.predator_hunt.3");
      pool("symbiote.voice.predator_night", "symbiote.voice.predator_night.1", "symbiote.voice.predator_night.2");
      pool("symbiote.voice.predator_kill", "symbiote.voice.predator_kill.1", "symbiote.voice.predator_kill.2");
      pool(
         "symbiote.voice.living_armor_on",
         "symbiote.voice.living_armor_on.1",
         "symbiote.voice.living_armor_on.2",
         "symbiote.voice.living_armor_on.3",
         "symbiote.voice.living_armor_on.4"
      );
      pool("symbiote.voice.living_armor_off", "symbiote.voice.living_armor_off.1", "symbiote.voice.living_armor_off.2", "symbiote.voice.living_armor_off.3");
      pool(
         "symbiote.voice.feed_accepted",
         "symbiote.voice.feed_accepted.1",
         "symbiote.voice.feed_accepted.2",
         "symbiote.voice.feed_accepted.3",
         "symbiote.voice.feed_accepted.4"
      );
      pool("symbiote.voice.feed_refused", "symbiote.voice.feed_refused.1", "symbiote.voice.feed_refused.2", "symbiote.voice.feed_refused.3");
      pool("symbiote.voice.revival", "symbiote.voice.revival.1", "symbiote.voice.revival.2", "symbiote.voice.revival.3", "symbiote.voice.revival.4");
      pool("symbiote.voice.shadow_sun", "symbiote.voice.shadow_sun.1", "symbiote.voice.shadow_sun.2", "symbiote.voice.shadow_sun.3");
      pool("symbiote.voice.bell_stun", "symbiote.voice.bell_stun.1", "symbiote.voice.bell_stun.2", "symbiote.voice.bell_stun.3");
      pool("symbiote.voice.sleep_takeover", "symbiote.voice.sleep_takeover.1", "symbiote.voice.sleep_takeover.2", "symbiote.voice.sleep_takeover.3");
      pool(
         "symbiote.voice.sleep_takeover_end",
         "symbiote.voice.sleep_takeover_end.1",
         "symbiote.voice.sleep_takeover_end.2",
         "symbiote.voice.sleep_takeover_end.3"
      );
      pool("symbiote.voice.aversion", "symbiote.voice.aversion.1", "symbiote.voice.aversion.2", "symbiote.voice.aversion.3");
      pool("symbiote.voice.memory_starved", "symbiote.voice.memory_starved.1", "symbiote.voice.memory_starved.2");
      pool("symbiote.voice.memory_stand", "symbiote.voice.memory_stand.1", "symbiote.voice.memory_stand.2");
      pool("symbiote.voice.memory_reclaimed", "symbiote.voice.memory_reclaimed.1", "symbiote.voice.memory_reclaimed.2");
      pool("symbiote.voice.memory_ignored", "symbiote.voice.memory_ignored.1", "symbiote.voice.memory_ignored.2");
      pool("symbiote.voice.reunion", "symbiote.voice.reunion.1", "symbiote.voice.reunion.2");
      pool("symbiote.voice.death_fear", "symbiote.voice.death_fear.1", "symbiote.voice.death_fear.2", "symbiote.voice.death_fear.3");
      pool("symbiote.voice.jealousy_player", "symbiote.voice.jealousy_player.1", "symbiote.voice.jealousy_player.2");
      pool("symbiote.voice.jealousy_pet", "symbiote.voice.jealousy_pet.1", "symbiote.voice.jealousy_pet.2");
      pool("symbiote.voice.arm_food_steal", "symbiote.voice.arm_food_steal.1", "symbiote.voice.arm_food_steal.2");
      pool("symbiote.voice.arm_contraband", "symbiote.voice.arm_contraband.1", "symbiote.voice.arm_contraband.2");
      pool("symbiote.voice.arm_contraband_return", "symbiote.voice.arm_contraband_return.1", "symbiote.voice.arm_contraband_return.2");
      pool("symbiote.voice.arm_instinct", "symbiote.voice.arm_instinct.1", "symbiote.voice.arm_instinct.2", "symbiote.voice.arm_instinct.3");
      pool("symbiote.voice.guardian_reflex", "symbiote.voice.guardian_reflex.1", "symbiote.voice.guardian_reflex.2");
      pool("symbiote.voice.graft_object", "symbiote.voice.graft_object.1");
      pool("symbiote.voice.graft_object2", "symbiote.voice.graft_object.2");
      pool("symbiote.voice.graft_first", "symbiote.voice.graft_first.1", "symbiote.voice.graft_first.2");
      pool("symbiote.voice.graft_seethe", "symbiote.voice.graft_seethe.1", "symbiote.voice.graft_seethe.2");
      pool("symbiote.voice.graft_refused", "symbiote.voice.graft_refused.1", "symbiote.voice.graft_refused.2");
      pool("symbiote.voice.graft_idle", "symbiote.voice.graft_idle.1", "symbiote.voice.graft_idle.2", "symbiote.voice.graft_idle.3");
      pool("symbiote.voice.graft_hungry", "symbiote.voice.graft_hungry.1", "symbiote.voice.graft_hungry.2");
      pool("symbiote.voice.graft_bicker", "symbiote.voice.graft_bicker.1", "symbiote.voice.graft_bicker.2", "symbiote.voice.graft_bicker.3");
      pool("symbiote.voice.graft_refuse_ask", "symbiote.voice.graft_refuse_ask.1", "symbiote.voice.graft_refuse_ask.2");
      pool("symbiote.voice.graft_tension_warn", "symbiote.voice.graft_tension_warn.1", "symbiote.voice.graft_tension_warn.2");
      pool("symbiote.voice.graft_tension_final", "symbiote.voice.graft_tension_final.1", "symbiote.voice.graft_tension_final.2");
      pool("symbiote.voice.graft_purge_open", "symbiote.voice.graft_purge_open.1");
      pool("symbiote.voice.graft_purge_plea", "symbiote.voice.graft_purge_plea.1");
      pool("symbiote.voice.graft_purge_done", "symbiote.voice.graft_purge_done.1");
      pool("symbiote.voice.reclaim_elder", "symbiote.voice.reclaim_elder.1");
      pool("symbiote.voice.reclaim_elder_press", "symbiote.voice.reclaim_elder.2");
      pool("symbiote.voice.reclaim_young", "symbiote.voice.reclaim_young.1", "symbiote.voice.reclaim_young.2");
      pool("symbiote.voice.reclaim_young_last", "symbiote.voice.reclaim_young_last.1");
      pool("symbiote.voice.reclaim_won", "symbiote.voice.reclaim_won.1", "symbiote.voice.reclaim_won.2");
      pool("symbiote.voice.molt_start", "symbiote.voice.molt_start.1", "symbiote.voice.molt_start.2");
      pool("symbiote.voice.molt_itch", "symbiote.voice.molt_itch.1", "symbiote.voice.molt_itch.2");
      pool("symbiote.voice.molt_done", "symbiote.voice.molt_done.1", "symbiote.voice.molt_done.2");
      pool("symbiote.voice.rebond_mass", "symbiote.voice.rebond_mass.1", "symbiote.voice.rebond_mass.2", "symbiote.voice.rebond_mass.3");
      pool("symbiote.voice.rebond_taken", "symbiote.voice.rebond_taken.1");
      pool("symbiote.voice.bloom_cornered", "symbiote.voice.bloom_cornered.1", "symbiote.voice.bloom_cornered.2");
      pool("symbiote.voice.bloom_starving", "symbiote.voice.bloom_starving.1", "symbiote.voice.bloom_starving.2");
      pool("symbiote.voice.bloom_panic", "symbiote.voice.bloom_panic.1", "symbiote.voice.bloom_panic.2");
      pool("symbiote.voice.bloom_warden", "symbiote.voice.bloom_warden.1");
      pool("symbiote.voice.bloom_debug", "symbiote.voice.bloom_panic.1");
      pool("symbiote.voice.wild_far", "symbiote.voice.wild_far.1", "symbiote.voice.wild_far.2");
      pool("symbiote.voice.wild_near", "symbiote.voice.wild_near.1", "symbiote.voice.wild_near.2");
      pool("symbiote.voice.wild_unaware", "symbiote.voice.wild_unaware.1", "symbiote.voice.wild_unaware.2", "symbiote.voice.wild_unaware.3");
      pool("symbiote.voice.wild_deciding", "symbiote.voice.wild_deciding.1", "symbiote.voice.wild_deciding.2");
      pool("symbiote.voice.wild_hunting", "symbiote.voice.wild_hunting.1", "symbiote.voice.wild_hunting.2");
      pool("symbiote.voice.wild_kin", "symbiote.voice.wild_kin.1", "symbiote.voice.wild_kin.2");
      pool("symbiote.voice.wild_closer", "symbiote.voice.wild_closer.1", "symbiote.voice.wild_closer.2");
      pool("symbiote.voice.wild_farther", "symbiote.voice.wild_farther.1", "symbiote.voice.wild_farther.2");
      pool("symbiote.voice.wild_holding", "symbiote.voice.wild_holding.1", "symbiote.voice.wild_holding.2");
      pool("symbiote.voice.wild_coming", "symbiote.voice.wild_coming.1", "symbiote.voice.wild_coming.2");
      pool("symbiote.voice.wild_coming_blind", "symbiote.voice.wild_coming_blind.1", "symbiote.voice.wild_coming_blind.2");
      pool("symbiote.voice.wild_feeding", "symbiote.voice.wild_feeding.1", "symbiote.voice.wild_feeding.2");
      pool("symbiote.voice.mend", "symbiote.voice.mend.1", "symbiote.voice.mend.2", "symbiote.voice.mend.3");
      pool("symbiote.voice.mend_nearly", "symbiote.voice.mend_nearly.1", "symbiote.voice.mend_nearly.2");
      pool("symbiote.voice.resist_break", "symbiote.voice.resist_break.1", "symbiote.voice.resist_break.2");
   }
}
