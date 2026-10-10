package com.scout.symbiote.config;

import java.util.function.Supplier;
import net.neoforged.neoforge.common.ModConfigSpec;
import net.neoforged.neoforge.common.ModConfigSpec.BooleanValue;
import net.neoforged.neoforge.common.ModConfigSpec.Builder;
import net.neoforged.neoforge.common.ModConfigSpec.DoubleValue;
import net.neoforged.neoforge.common.ModConfigSpec.IntValue;

public final class SymbioteConfig {
   public static final ModConfigSpec SPEC;
   public static final Supplier<Integer> BOND_MAX = () -> 500;
   public static final IntValue BOND_DECAY_PER_DAY;
   public static final Supplier<Integer> BOND_KILL_HOSTILE = () -> 1;
   public static final Supplier<Integer> BOND_FEED = () -> 1;
   public static final Supplier<Integer> BOND_SLEEP = () -> 2;
   public static final Supplier<Integer> BOND_CLUTCH_SAVE = () -> 2;
   public static final Supplier<Integer> BOND_PASSIVE_KILL = () -> 1;
   public static final Supplier<Integer> BOND_FIRE_DAMAGE = () -> 1;
   public static final Supplier<Integer> TRUST_COMMAND_OBEYED = () -> 1;
   public static final Supplier<Integer> TRUST_COMMAND_IGNORED = () -> 2;
   public static final Supplier<Integer> TRUST_OVERRIDE_HELPED = () -> 3;
   public static final Supplier<Integer> TRUST_OVERRIDE_HURT = () -> 4;
   public static final Supplier<Integer> HUNGER_DRAIN_PER_DAY = () -> 25;
   public static final Supplier<Integer> HUNGER_PER_RAW_MEAT = () -> 15;
   public static final Supplier<Integer> HUNGER_PER_HOSTILE_KILL = () -> 5;
   public static final Supplier<Integer> HUNGER_STARVE_THRESHOLD = () -> 15;
   public static final Supplier<Integer> STRESS_FIRE_PER_TICK = () -> 4;
   public static final Supplier<Integer> STRESS_LOW_HP_PER_TICK = () -> 1;
   public static final Supplier<Integer> STRESS_DECAY_PER_TICK = () -> 1;
   public static final Supplier<Integer> STRESS_DECAY_INTERVAL = () -> 60;
   public static final Supplier<Integer> STRESS_HIGH_THRESHOLD = () -> 70;
   public static final IntValue STAGE_INTEGRATED_BOND;
   public static final IntValue STAGE_COOPERATIVE_BOND;
   public static final IntValue STAGE_DOMINANT_BOND;
   public static final Supplier<Double> DEFIANCE_BASE_CHANCE = () -> 0.25;
   public static final Supplier<Integer> DEFIANCE_ACTION_INTERVAL_TICKS = () -> 600;
   public static final Supplier<Double> DOMINANT_OVERRIDE_INTENSITY = () -> 1.6;
   public static final Supplier<Double> COOPERATIVE_OVERRIDE_INTENSITY = () -> 1.25;
   public static final Supplier<Integer> FRENZY_DURATION_TICKS = () -> 100;
   public static final Supplier<Integer> FRENZY_COOLDOWN_TICKS = () -> 1200;
   public static final Supplier<Integer> APEX_DURATION_TICKS = () -> 200;
   public static final Supplier<Integer> APEX_COOLDOWN_TICKS = () -> 2400;
   public static final Supplier<Integer> TENDRIL_LASH_COOLDOWN_TICKS = () -> 60;
   public static final Supplier<Double> TENDRIL_LASH_RANGE = () -> 4.5;
   public static final Supplier<Integer> CARAPACE_DURATION_TICKS = () -> 80;
   public static final Supplier<Integer> CARAPACE_COOLDOWN_TICKS = () -> 400;
   public static final DoubleValue REJECTION_CHANCE;
   public static final IntValue CRATER_RARITY;
   public static final BooleanValue FIRE_PANIC_CONTACT_ONLY;
   public static final BooleanValue DEFIANCE_SHOVES;
   public static final BooleanValue FIRE_PANIC_PULL;
   public static final BooleanValue CONTROL_STRUGGLES;
   public static final Supplier<Integer> INSTABILITY_DURATION_TICKS = () -> 24000;
   public static final Supplier<Double> CREEPER_SAVE_RANGE = () -> 4.0;
   public static final Supplier<Double> CREEPER_SAVE_MIN_HP_FRAC = () -> 0.6;
   public static final Supplier<Double> LOW_HEALTH_OVERRIDE_HP_FRAC = () -> 0.2;
   public static final Supplier<Integer> FIRE_PANIC_RANGE = () -> 3;
   public static final Supplier<Integer> OVERRIDE_GLOBAL_COOLDOWN_TICKS = () -> 40;
   public static final Supplier<Double> HUNGER_OVERRIDE_SEARCH_RANGE = () -> 8.0;
   public static final DoubleValue HUNGER_STALK_RANGE;
   public static final BooleanValue WALK_DOOR_RIP;
   public static final BooleanValue WALK_TERRAIN_BITE;
   public static final Supplier<Integer> TENDRIL_YANK_RANGE = () -> 8;
   public static final Supplier<Integer> TENDRIL_YANK_COOLDOWN_TICKS = () -> 40;
   public static final Supplier<Integer> PREDATOR_SENSE_RANGE = () -> 12;
   public static final Supplier<Integer> WALL_CLING_DURATION_TICKS = () -> 100;
   public static final Supplier<Integer> LIVING_ARMOR_STAMINA_MAX = () -> 100;
   public static final Supplier<Double> LIVING_ARMOR_DR_INTEGRATED = () -> 0.5;
   public static final Supplier<Double> LIVING_ARMOR_DR_COOPERATIVE = () -> 0.65;
   public static final Supplier<Double> LIVING_ARMOR_DR_DOMINANT = () -> 0.8;
   public static final Supplier<Integer> LIVING_ARMOR_HUNGER_INTERVAL = () -> 70;
   public static final Supplier<Integer> LIVING_ARMOR_AUTOLASH_INTERVAL = () -> 45;
   public static final Supplier<Double> LIVING_ARMOR_AUTOLASH_DAMAGE = () -> 3.0;
   public static final Supplier<Double> LIVING_ARMOR_AUTOLASH_RANGE = () -> 5.0;
   public static final Supplier<Double> LIVING_ARMOR_THORNS_DAMAGE = () -> 3.0;
   public static final Supplier<Integer> LIVING_ARMOR_TOGGLE_COOLDOWN_TICKS = () -> 80;
   public static final Supplier<Double> LIVING_ARMOR_HIT_CAP_FRAC = () -> 0.5;
   public static final Supplier<Double> ROYAL_HIT_CAP_FRAC = () -> 0.4;
   public static final Supplier<Integer> EMERGENCY_REGEN_COOLDOWN_TICKS = () -> 600;
   public static final Supplier<Integer> STANCE_STAMINA_DRAIN = () -> 2;
   public static final Supplier<Integer> STANCE_DRAIN_INTERVAL = () -> 10;
   public static final Supplier<Double> PROTECT_HEAL_AMOUNT = () -> 1.5;
   public static final Supplier<Integer> PROTECT_HEAL_INTERVAL = () -> 20;
   public static final Supplier<Integer> HUNT_KILL_HUNGER = () -> 4;
   public static final Supplier<Integer> TRUST_FEED = () -> 2;
   public static final Supplier<Integer> TRUST_STANCE_KILL = () -> 1;
   public static final Supplier<Integer> TRUST_STANCE_KILL_COOLDOWN_TICKS = () -> 40;
   public static final Supplier<Integer> REVIVAL_MIN_BOND = () -> 275;
   public static final Supplier<Integer> REVIVAL_DORMANCY_TICKS = () -> 12000;
   public static final Supplier<Double> PREDATOR_DAMAGE_MULT = () -> 1.4;
   public static final Supplier<Double> PREDATOR_HUNGER_DRAIN_MULT = () -> 1.5;
   public static final Supplier<Double> PREDATOR_TENDRIL_COOLDOWN_MULT = () -> 0.6;
   public static final Supplier<Double> PREDATOR_REVIVAL_BOND_MULT = () -> 1.2;
   public static final Supplier<Integer> PREDATOR_STARVE_THRESHOLD_BONUS = () -> 10;
   public static final BooleanValue DESIRES_ENABLED;
   public static final BooleanValue DESIRE_HINTS;
   public static final Supplier<Integer> DESIRE_INTERVAL_TICKS = () -> 9600;
   public static final Supplier<Integer> DESIRE_WINDOW_TICKS = () -> 6000;
   public static final Supplier<Integer> TRUST_DESIRE_FULFILLED = () -> 3;
   public static final Supplier<Integer> STRESS_DESIRE_IGNORED = () -> 8;
   public static final Supplier<Double> DESIRE_TANTRUM_CHANCE = () -> 0.5;
   public static final BooleanValue CURIOSITY_ENABLED;
   public static final Supplier<Integer> CURIOSITY_MIN_GAP_TICKS = () -> 800;
   public static final Supplier<Double> CURIOSITY_WALK_CHANCE = () -> 0.45;
   public static final Supplier<Double> CURIOSITY_RANGE = () -> 20.0;
   public static final BooleanValue FIDGET_ENABLED;
   public static final Supplier<Integer> FIDGET_IDLE_TICKS = () -> 300;
   public static final BooleanValue DROWNING_SAVE_ENABLED;
   public static final BooleanValue SUFFOCATION_DIG_ENABLED;
   public static final BooleanValue FREEZE_ESCAPE_ENABLED;
   public static final Supplier<Integer> HOST_FEED_HUNGER_THRESHOLD = () -> 4;
   public static final BooleanValue JEALOUSY_ENABLED;
   public static final Supplier<Boolean> COSTLY_RESISTANCE_ENABLED = () -> false;
   public static final BooleanValue DEATH_KEEPS_BOND;
   public static final BooleanValue DEATH_MASS_ENABLED;
   public static final Supplier<Integer> BIOMASS_DORMANCY_CUT = () -> 1200;
   public static final BooleanValue MANTLE_MOODS;
   public static final BooleanValue PREDATOR_HUNT_ENABLED;
   public static final Supplier<Boolean> MOLT_ENABLED = () -> true;
   public static final Supplier<Integer> MOLT_INTERVAL_TICKS = () -> 84000;
   public static final Supplier<Boolean> WILD_HOSTS_ENABLED = () -> true;
   public static final Supplier<Integer> WILD_HOST_SPAWN_CHANCE = () -> 8;
   public static final Supplier<Integer> WILD_HOST_SENSE_RANGE = () -> 32;
   public static final Supplier<Boolean> WILD_HOST_LEAP_ENABLED = () -> true;
   public static final Supplier<Integer> WILD_HOST_LEAP_CHANCE = () -> 35;
   public static final BooleanValue VERBOSE_LOGGING;
   public static final IntValue TENDRIL_CAP;
   public static final Supplier<Integer> SHADOW_NIGHT_SPEED_AMPLIFIER = () -> 0;
   public static final Supplier<Integer> SHADOW_DAY_STRESS = () -> 1;
   public static final Supplier<Double> SCULK_SONIC_RESIST = () -> 0.5;
   public static final Supplier<Integer> SCULK_SENSE_RANGE_BONUS = () -> 8;
   public static final Supplier<Double> ROYAL_DEFIANCE_MULT = () -> 1.6;
   public static final Supplier<Double> ROYAL_HUNGER_DRAIN_MULT = () -> 1.35;
   public static final Supplier<Double> ROYAL_INTENSITY_BONUS = () -> 0.25;
   public static final Supplier<Double> ROYAL_DAMAGE_MULT = () -> 1.5;
   public static final Supplier<Double> ROYAL_ARMOR_DR_BONUS = () -> 0.1;
   public static final Supplier<Double> GUARDIAN_ARMOR_DR_BONUS = () -> 0.05;
   public static final Supplier<Boolean> ROYAL_REGEN_ENABLED = () -> true;
   public static final Supplier<Double> BELL_STUN_RADIUS = () -> 16.0;
   public static final Supplier<Integer> BELL_STUN_SECONDS = () -> 8;
   public static final Supplier<Integer> BELL_STRESS = () -> 15;
   public static final Supplier<Double> SONIC_BOOM_BONUS_MULT = () -> 1.5;
   public static final Supplier<Boolean> VILLAGER_FEAR_ENABLED = () -> true;
   public static final Supplier<Integer> VILLAGER_FEAR_MIN_STAGE = () -> 3;
   public static final Supplier<Double> VILLAGER_FEAR_RANGE = () -> 8.0;
   public static final Supplier<Boolean> GOLEM_HOSTILE_TO_DOMINANT = () -> true;
   public static final BooleanValue SLAM_ENABLED;
   public static final Supplier<Double> SLAM_DAMAGE = () -> 10.0;
   public static final Supplier<Double> SLAM_RANGE = () -> 5.0;
   public static final Supplier<Integer> SLAM_COOLDOWN_TICKS = () -> 600;
   public static final Supplier<Double> SLEEP_TAKEOVER_BASE_CHANCE = () -> 0.2;
   public static final Supplier<Double> BIOMASS_DROP_CHANCE = () -> 0.5;
   public static final BooleanValue PROTECT_ALLIES;
   public static final Supplier<Integer> STAMINA_MAX_ATTACHED = () -> 60;
   public static final Supplier<Integer> STAMINA_MAX_INTEGRATED = () -> 85;
   public static final Supplier<Integer> STAMINA_MAX_COOPERATIVE = () -> 115;
   public static final Supplier<Integer> STAMINA_MAX_DOMINANT = () -> 150;
   public static final Supplier<Integer> STAMINA_REGEN_PER_TICK = () -> 1;
   public static final Supplier<Integer> STAMINA_REGEN_INTERVAL = () -> 8;
   public static final Supplier<Integer> STAMINA_COST_YANK = () -> 18;
   public static final Supplier<Integer> STAMINA_COST_CLING = () -> 12;
   public static final Supplier<Integer> STAMINA_COST_LASH = () -> 30;
   public static final Supplier<Integer> STAMINA_COST_CARAPACE = () -> 28;
   public static final Supplier<Integer> STAMINA_COST_FRENZY = () -> 50;
   public static final Supplier<Integer> STAMINA_COST_APEX = () -> 65;
   public static final Supplier<Integer> STAMINA_COST_CONSUME = () -> 33;
   public static final Supplier<Integer> CONSUME_COOLDOWN_TICKS = () -> 120;
   public static final Supplier<Double> CONSUME_MAX_TARGET_HP = () -> 100.0;
   public static final Supplier<Boolean> STRAIN_POWERS_ENABLED = () -> false;
   public static final Supplier<Integer> STRAIN_ABILITY_COOLDOWN_TICKS = () -> 140;
   public static final Supplier<Integer> STAMINA_COST_AEGIS = () -> 30;
   public static final Supplier<Integer> AEGIS_DURATION_TICKS = () -> 100;
   public static final Supplier<Double> AEGIS_DAMAGE_REDUCTION = () -> 0.6;
   public static final Supplier<Double> AEGIS_RANGE = () -> 4.0;
   public static final Supplier<Integer> STAMINA_COST_RUPTURE = () -> 28;
   public static final Supplier<Double> RUPTURE_RANGE = () -> 6.0;
   public static final Supplier<Double> RUPTURE_DAMAGE = () -> 9.0;
   public static final Supplier<Double> RUPTURE_EXECUTE_FRAC = () -> 0.3;
   public static final Supplier<Double> RUPTURE_SCENE_DAMAGE_REDUCTION = () -> 0.3;
   public static final Supplier<Integer> STAMINA_COST_NIGHTSTEP = () -> 18;
   public static final Supplier<Double> NIGHTSTEP_RANGE_DAY = () -> 6.0;
   public static final Supplier<Double> NIGHTSTEP_RANGE_NIGHT = () -> 14.0;
   public static final Supplier<Integer> STAMINA_COST_SCREECH = () -> 35;
   public static final Supplier<Double> SCREECH_RANGE = () -> 9.0;
   public static final Supplier<Double> SCREECH_DAMAGE = () -> 8.0;
   public static final Supplier<Integer> STAMINA_COST_ONSLAUGHT = () -> 40;
   public static final Supplier<Integer> ONSLAUGHT_DURATION_TICKS = () -> 200;
   public static final Supplier<Integer> ONSLAUGHT_COOLDOWN_TICKS = () -> 360;
   public static final Supplier<Integer> ONSLAUGHT_STRIKE_INTERVAL = () -> 8;
   public static final Supplier<Integer> ONSLAUGHT_TENDRILS = () -> 6;
   public static final Supplier<Double> ONSLAUGHT_RANGE = () -> 8.0;
   public static final Supplier<Double> ONSLAUGHT_DAMAGE = () -> 6.0;
   public static final Supplier<Boolean> ARMS_ENABLED = () -> true;
   public static final Supplier<Double> ARMS_RETALIATE_CHANCE = () -> 0.28;
   public static final Supplier<Double> ARMS_GRIEF_MULT = () -> 1.0;
   public static final Supplier<Boolean> ARMS_VEIN_ASSIST = () -> true;
   public static final Supplier<Integer> ARMS_VEIN_MAX = () -> 24;
   public static final Supplier<Boolean> ARMS_WALL_ENABLED = () -> true;
   public static final Supplier<Integer> ARMS_WALL_COOLDOWN_TICKS = () -> 20;
   public static final Supplier<Boolean> ARROW_WALL_ENABLED = () -> true;
   public static final Supplier<Double> ARROW_WALL_CHANCE = () -> 0.3;
   public static final Supplier<Boolean> TORCH_REFLEX_ENABLED = () -> true;
   public static final Supplier<Boolean> ARMS_SCAVENGE = () -> true;
   public static final Supplier<Integer> SCAVENGE_MIN_DURABILITY = () -> 300;
   public static final Supplier<Double> ARMS_SCAVENGE_RANGE = () -> 8.0;
   public static final ModConfigSpec CLIENT_SPEC;
   public static final BooleanValue SCULK_ECHO_BLIPS;
   public static final BooleanValue TENDRIL_OVERLAY;

   private SymbioteConfig() {
   }

   static {
      Builder b = new Builder();
      b.push("meters");
      BOND_DECAY_PER_DAY = b.comment("Bond lost per in-game day if no bond events occur.").defineInRange("bond_decay_per_day", 1, 0, 100);
      b.pop();
      b.push("stages");
      STAGE_INTEGRATED_BOND = b.comment("Bond at which the symbiote promotes from Attached → Integrated.").defineInRange("stage_integrated_bond", 120, 1, 1000);
      STAGE_COOPERATIVE_BOND = b.comment("Bond at which the symbiote promotes Integrated → Cooperative (it becomes a partner and will start defying you).")
         .defineInRange("stage_cooperative_bond", 240, 1, 1000);
      STAGE_DOMINANT_BOND = b.comment(
            "Bond at which the symbiote promotes Cooperative → Dominant (it takes over with the most power, and the most loss of control)"
         )
         .defineInRange("stage_dominant_bond", 400, 1, 1000);
      b.pop();
      b.push("bonding");
      CRATER_RARITY = b.comment("Meteor crater rarity multiplier. 1 = default density. 2 = half as many craters, 4 = a quarter, and so on.")
         .defineInRange("crater_rarity", 1, 1, 16);
      REJECTION_CHANCE = b.comment("Probability that the dormant sample violently rejects the host on bonding. 0.10 = 10%.")
         .defineInRange("rejection_chance", 0.1, 0.0, 1.0);
      b.pop();
      b.push("overrides");
      FIRE_PANIC_PULL = b.comment(
            "The symbiote physically pulls the body out of fire once panicked enough. false = it still panics, speaks, stresses, and the bond still pays for burns, without the movement."
         )
         .define("fire_panic_pull", true);
      CONTROL_STRUGGLES = b.comment(
            "Dominant symbiotes have short fights for the wheel that you lose (brief heavy slowness + vignette). Shipped OFF. true restores it."
         )
         .define("control_struggles", false);
      DEFIANCE_SHOVES = b.comment(
            "Unprompted defiance may physically move the body (this now hazard-checks lunges and staggers). Shipped OFF. true restores the shoves for whoever wants the full loss of control."
         )
         .define("defiance_shoves", false);
      FIRE_PANIC_CONTACT_ONLY = b.comment(
            "Fire panic only triggers when the host is actually on fire or in lava (nether behavior, everywhere). false = the old preemptive panic near any fire source outside the nether."
         )
         .define("fire_panic_contact_only", true);
      HUNGER_STALK_RANGE = b.comment(
            "Starving with no prey in grab range: the symbiote WALKS the host to prey within this range (INTEGRATED+, uses the forced-walk hijack), then eats it there. 0 disables stalking."
         )
         .defineInRange("hunger_stalk_range", 28.0, 0.0, 64.0);
      WALK_DOOR_RIP = b.comment(
            "A forced walk blocked by a closed WOODEN door rips it off with tendrils (drops the door item) and continues inside. Iron doors always stop it."
         )
         .define("walk_door_rip", true);
      WALK_TERRAIN_BITE = b.comment(
            "A forced walk WEDGED by terrain (leaf ceilings, lips) bites the blocking blocks out with tendrils, with at most 2 per stall, 4 per walk, breakable blocks only, drops kept."
         )
         .define("walk_terrain_bite", true);
      DROWNING_SAVE_ENABLED = b.comment(
            "Air nearly gone underwater: the symbiote seizes the body and hauls it straight up until it can breathe. Gives up after ~6s under solid ceiling."
         )
         .define("drowning_save_enabled", true);
      SUFFOCATION_DIG_ENABLED = b.comment("Buried alive: the arms burst whatever block is crushing the skull. Only bedrock-tier resists.")
         .define("suffocation_dig_enabled", true);
      FREEZE_ESCAPE_ENABLED = b.comment("Freezing in powder snow: the arms smash the snow around the body and shove it out.")
         .define("freeze_escape_enabled", true);
      b.pop();
      b.push("desires");
      DESIRES_ENABLED = b.comment(
            "The symbiote periodically ASKS for things (feed me / a kill / take me deep / the night / wear me). Fulfilling pays trust and calms it. Ignoring stresses it."
         )
         .define("desires_enabled", true);
      DESIRE_HINTS = b.comment("The gray hints for desires. Off means you figure it out yourself, for immersion.").define("desire_hints", true);
      b.pop();
      b.push("curiosity");
      CURIOSITY_ENABLED = b.comment(
            "The organism notices species it has never met. Each species fires ONCE per bond: a line, and sometimes it walks you over to look at it."
         )
         .define("curiosity_enabled", true);
      FIDGET_ENABLED = b.comment("Idle fidgets: stand still long enough and a tendril pokes at nearby blocks, or tastes the rain. Pure body language.")
         .define("fidget_enabled", true);
      b.pop();
      b.push("expansion");
      SLAM_ENABLED = b.comment("Enemy Slam: when exactly two close threats trigger the defense override, grab both, lift, and slam them together.")
         .define("slam_enabled", true);
      PROTECT_ALLIES = b.comment("If true, Tendril Lash / feeding hunt skip tamed pets, named mobs, and other players.").define("protect_allies", true);
      b.pop();
      b.push("emotional");
      JEALOUSY_ENABLED = b.comment(
            new String[]{
               "EM-8: the organism gets possessive when another player (or a tamed pet/villager)",
               "lingers close to its host for a sustained stretch, firing a jealous line + a",
               "red pull. Cosmetic flavor only."
            }
         )
         .define("jealousy_enabled", true);
      DEATH_KEEPS_BOND = b.comment(
            new String[]{
               "Death rework: TRUE = the bond simply survives death (respawn still bonded,",
               "items follow vanilla rules). The zero-friction toggle for players who asked",
               "to never lose their symbiote. Overrides death_mass_enabled."
            }
         )
         .define("death_keeps_bond", false);
      DEATH_MASS_ENABLED = b.comment(
            new String[]{
               "Death rework (DEFAULT): on death the symbiote remains at the death point as",
               "a mass holding your ENTIRE inventory, exactly as you had it. Return to it and",
               "the same organism rebonds and gives everything back. Only answers to its host.",
               "Deaths the symbiote itself causes (consumption, rejection) leave nothing.",
               "FALSE (with death_keeps_bond false) = v1.0 behavior: death ends the bond."
            }
         )
         .define("death_mass_enabled", true);
      MANTLE_MOODS = b.comment(
            new String[]{
               "The mantle as the organism's face: at Cooperative+, the shoulder tendrils rise",
               "on their own when the mood turns (anxious flare, coiled strike-arch, grieving",
               "droop) and lean after whatever the gaze fixes on. Content = they tuck away.",
               "OFF disables only the MOOD trigger and postures. The drape still rises with",
               "Living Armor, during body hijacks, underwater, and after fire saves."
            }
         )
         .define("mantle_moods_enabled", true);
      PREDATOR_HUNT_ENABLED = b.comment(
            new String[]{
               "Predator strain night prowls: at night the organism sometimes seizes your",
               "body turning your armor on, drape out, and it lunges. IT will force a fight",
               "with a nearby hostile until the prey is dead or lost. Rare on purpose."
            }
         )
         .define("predator_hunt_enabled", true);
      b.pop();
      b.push("debug");
      TENDRIL_CAP = b.comment("Most tendrils allowed in one dimension at once. Range is 40 to 2000").defineInRange("tendril_cap", 220, 40, 2000);
      VERBOSE_LOGGING = b.comment(
            "If true, the mod's full gameplay event stream prints to the console (and SYMBIOTE_DEBUG state lines with it). Off, the release build keeps the console quiet. Turn on when reporting a bug. Spammy."
         )
         .define("verbose_logging", false);
      b.pop();
      SPEC = b.build();
      b = new Builder();
      b.push("client");
      TENDRIL_OVERLAY = b.comment(
            "The tendril membrane around the screen edges (ambient while bonded, surging during body control). Set false to hide it entirely."
         )
         .define("tendril_overlay", true);
      SCULK_ECHO_BLIPS = b.comment("Sculk sonar echo blips (the diamonds drawn when a shaderpack is active). Set false for clean recordings.")
         .define("sculk_echo_blips", true);
      b.pop();
      CLIENT_SPEC = b.build();
   }
}
