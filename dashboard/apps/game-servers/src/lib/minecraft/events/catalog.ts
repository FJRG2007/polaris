/**
 * The events a Minecraft server can run, as data: what each one is, what it can
 * be set to, and how it is stored.
 *
 * Every event is played through commands the game itself understands - the
 * scoreboard counts what players do, a boss bar shows the clock, titles say what
 * is happening - so it works on Paper, NeoForge, Fabric and vanilla alike, from
 * 1.13 on, with nothing installed on the server. Polaris starts it, keeps the
 * clock, reads the scores at the end and hands out the rewards.
 *
 * Pure and free of anything server-side, because the screen that edits events
 * runs in the browser and validates with the same schemas the actions do.
 */

import { z } from "zod";
import { gameMessage } from "../../game-message";
import type { GameKey } from "../../../../messages";

/** A schema's complaint, carried as its catalog key until a reader's language is
 *  known (`lib/game-message`): the screen and the actions write it out. */
type ProblemKey =
    GameKey<"minecraft"> extends infer K
        ? K extends `events.problems.${infer P}`
            ? P
            : never
        : never;
const problem = (key: ProblemKey, params?: Readonly<Record<string, number>>): string =>
    gameMessage("minecraft", `events.problems.${key}`, params);

export const EVENT_KINDS = [
    "mining-rush",
    "mob-hunt",
    "supply-drop",
    "blood-moon",
    "world-boss",
    "fishing",
    "trivia",
    "explorer",
    "happy-hour",
    "king-of-the-hill",
    "treasure-hunt",
    "gathering",
    "rare-catch",
    "xp-boost",
    "waves",
    "meteor-shower",
    "parkour",
    "spleef",
    "team-duel",
    "build-battle",
    "tnt-run",
    "boat-race",
    "dropper",
    "capture-the-flag",
    "hide-and-seek",
    "hot-potato",
    "sky-wars",
    "village-defense",
    "bingo",
    "boss-fishing",
    "nether-maze",
    "acid-rain"
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Where the settings live in the install's config. Edited by the screen. */
export const EVENTS_KEY = "events";
/** Where what happened lives. Written only by Polaris, so a save from the screen
 *  can never put an old copy of it back. */
export const EVENT_STATE_KEY = "eventState";

/** A player's name as the game allows it - the only thing ever put into a
 *  command in place of a selector. A Bedrock player's through Floodgate has a
 *  `.` in front, and is that player, not the Java one without it. */
export const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

/** A namespaced item id, `minecraft:diamond` or a mod's own. */
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

export const rewardItemSchema = z.object({
    id: z.string().trim().toLowerCase().regex(ITEM_ID, problem("itemId")),
    count: z
        .number()
        .int()
        .min(1, problem("atLeast", { count: 1 }))
        .max(256, problem("atMost", { count: 256 }))
});

export const rewardSchema = z.object({
    items: z.array(rewardItemSchema).max(6, problem("itemsPerReward", { count: 6 })),
    levels: z
        .number()
        .int()
        .min(0)
        .max(100, problem("levelsAtMost", { count: 100 }))
});

export type Reward = z.infer<typeof rewardSchema>;
export type RewardItem = z.infer<typeof rewardItemSchema>;

export const rewardsSchema = z.object({
    first: rewardSchema,
    second: rewardSchema,
    third: rewardSchema,
    /** For everybody off the podium who took part - scored at all, and on a blood moon
     *  survived the night. Never on top of a place's own prize. */
    everyone: rewardSchema
});

export type Rewards = z.infer<typeof rewardsSchema>;

export const NO_REWARD: Reward = { items: [], levels: 0 };

/** Where an event that needs a place happens. */
export const placeSchema = z.discriminatedUnion("mode", [
    /** Around where the players who are active are, picked when it starts. */
    z.object({ mode: z.literal("players") }),
    z.object({
        mode: z.literal("fixed"),
        x: z.number().int().min(-29_999_000).max(29_999_000),
        z: z.number().int().min(-29_999_000).max(29_999_000)
    })
]);

export type EventPlace = z.infer<typeof placeSchema>;

export const MINING_TARGETS = ["any-ore", "diamond", "debris"] as const;
export const HUNT_TARGETS = [
    "hostile",
    "zombie",
    "skeleton",
    "creeper",
    "spider",
    "enderman"
] as const;
/** The ways a spleef is played: shovels, floors that vanish underfoot, snowballs. */
export const SPLEEF_VARIANTS = ["shovel", "decay", "snowballs"] as const;
export const LOOT_TABLES = ["treasure", "dungeon", "bastion", "end-city", "ancient-city"] as const;
export const BOSS_KINDS = [
    "wither-skeleton",
    "ravager",
    "vindicator",
    "husk",
    "evoker",
    "captain",
    "wither"
] as const;
export type BossKind = (typeof BOSS_KINDS)[number];
/** Bosses whose attacks would reach the land, fought only in the sky arena: the
 *  Wither's skulls explode. */
export const ARENA_ONLY_BOSSES: readonly BossKind[] = ["wither"];
/** How hard a world boss is. Epic is the default: players found the old boss easy. */
export const BOSS_DIFFICULTIES = ["normal", "hard", "epic"] as const;
export type BossDifficulty = (typeof BOSS_DIFFICULTIES)[number];

/** Bosses that change blocks when `mobGriefing` is on - a ravager's leaves and
 *  crops, an evoker's sheep - which it is held off for, on the land. */
export const BLOCK_CHANGING_BOSSES: readonly BossKind[] = ["ravager", "evoker"];
/** What a world boss's prizes are multiplied by on each difficulty. */
export const BOSS_PRIZE_TIMES: Readonly<Record<BossDifficulty, number>> = {
    normal: 1,
    hard: 1.5,
    epic: 2
};

/** Whether a fight has to hold `mobGriefing` off: the Wither always, since its
 *  skulls would break even the arena; a boss that changes blocks, on the land. */
export function holdsGriefing(kind: BossKind, arena: boolean): boolean {
    return ARENA_ONLY_BOSSES.includes(kind) || (!arena && BLOCK_CHANGING_BOSSES.includes(kind));
}

/** The bosses a world boss can be drawn from, with or without the sky arena. */
export function bossesFor(arena: boolean, pool: readonly BossKind[] = BOSS_KINDS): BossKind[] {
    return pool.filter((kind) => arena || !ARENA_ONLY_BOSSES.includes(kind));
}
export const INTENSITIES = ["low", "medium", "high"] as const;
export const TRIVIA_MODES = ["questions", "scramble", "mixed"] as const;
export const LANGUAGES = ["en", "es"] as const;
/** What a gathering can ask for. `logs` is every kind of log and stem. */
export const GATHER_MATERIALS = [
    "wheat",
    "logs",
    "cobblestone",
    "iron_ingot",
    "coal",
    "kelp",
    "bamboo",
    "sugar_cane",
    "potato",
    "carrot",
    "sand",
    "pumpkin"
] as const;
export type GatherMaterial = (typeof GATHER_MATERIALS)[number];
/** What a rare catch can be for: the fishing treasures. `any` is whichever of them. */
export const RARE_CATCHES = [
    "name_tag",
    "saddle",
    "nautilus_shell",
    "enchanted_book",
    "bow"
] as const;
export type RareCatch = (typeof RARE_CATCHES)[number];
/** Which monsters a horde defense sends: only ones that cannot break a block. */
export const WAVE_MIXES = ["classic", "undead", "mixed"] as const;
/** What decides a horde defense: kills near the point, or damage dealt there. */
export const WAVE_WINNERS = ["kills", "damage"] as const;
/** What decides a world boss: the most damage dealt to it, or the blow that fells it. */
export const BOSS_WINNERS = ["damage", "final-blow"] as const;
export type BossWinner = (typeof BOSS_WINNERS)[number];
/** What a meteor is made of. */
export const METEOR_ORES = ["common", "precious", "diamond", "debris"] as const;
export const PARKOUR_DIFFICULTIES = ["easy", "medium", "hard"] as const;
/** How a parkour course looks: its blocks, and whether it is climbed by ladder or vine. */
export const PARKOUR_THEMES = ["classic", "frost", "jungle", "nether"] as const;
/** The shapes a parkour course takes: rows snaking up, or a tower climbed round. */
export const PARKOUR_SHAPES = ["rows", "tower"] as const;
/** The sword a team duel hands everybody, alike for all. */
export const DUEL_KITS = ["wood", "stone", "iron"] as const;
/** Where a build battle's theme comes from: the built-in list or the operator's. */
export const THEME_MODES = ["random", "mine"] as const;
/** A bingo card won by its first full line, or only by the whole card. */
export const BINGO_GOALS = ["line", "card"] as const;
/** What a SkyWars island's chests hold: plain survival gear, or rich. */
export const SKY_WARS_LOOT = ["normal", "rich"] as const;
/** A nether maze's rooms a side, and how many of them are deadly. */
export const MAZE_SIZES = ["small", "medium", "large"] as const;
export const MAZE_HAZARDS = ["few", "some", "many"] as const;
/** How big an acid rain's arena is, and how fast its rain fills a player's
 *  bar and eats their shelter. */
export const ACID_SIZES = ["small", "medium", "large"] as const;
export const ACIDITIES = ["mild", "harsh"] as const;

/** How big hide and seek's house is: by how many play, or three, four or five
 *  rooms along a side. */
export const HOUSE_SIZES = ["auto", "small", "medium", "large"] as const;

export type Language = (typeof LANGUAGES)[number];

const triviaQuestionSchema = z.object({
    question: z.string().trim().min(3).max(200),
    answers: z.array(z.string().trim().min(1).max(60)).min(1).max(6)
});

export type TriviaQuestion = z.infer<typeof triviaQuestionSchema>;

/** A world boss saved before there was a choice keeps fighting as it did: its
 *  own boss, on Normal, on the land. */
function legacyWorldBoss(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    if ("choice" in value || !("boss" in value)) return value;
    return { choice: "chosen", difficulty: "normal", arena: false, ...value };
}

/** How many jumps a parkour course has unless the operator says otherwise. */
export const PARKOUR_JUMPS = 30;

/**
 * A parkour saved before it could take more than one shape, and still on the
 * twenty jumps every course had then - nobody's choice - is read as the longer
 * course it has now. One saved since carries its shapes, and keeps its length.
 */
function legacyParkour(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    if ("shapes" in value) return value;
    const jumps = (value as { jumps?: unknown }).jumps;
    return jumps === 20 ? { ...value, jumps: PARKOUR_JUMPS } : value;
}

/** A spleef saved with one `variant` - "random", or always one way - reads as
 *  the ways that allowed: random is every way, drawn the same as before. */
function legacySpleef(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    if ("variants" in value || !("variant" in value)) return value;
    const { variant, ...rest } = value as { variant: unknown };
    const one = SPLEEF_VARIANTS.find((way) => way === variant);
    return { ...rest, variants: one ? [one] : [...SPLEEF_VARIANTS] };
}

/** What each kind can be set to. Every field has a default, so an event made on
 *  an older version of this screen reads as a whole one. */
export const optionsSchemas = {
    "mining-rush": z.object({ target: z.enum(MINING_TARGETS).default("any-ore") }),
    "mob-hunt": z.object({ target: z.enum(HUNT_TARGETS).default("hostile") }),
    "supply-drop": z.object({
        place: placeSchema.default({ mode: "players" }),
        distance: z.number().int().min(100).max(3000).default(600),
        loot: z.enum(LOOT_TABLES).default("treasure")
    }),
    "blood-moon": z.object({
        intensity: z.enum(INTENSITIES).default("medium"),
        creepers: z.boolean().default(false)
    }),
    "world-boss": z.preprocess(
        legacyWorldBoss,
        z
            .object({
                /** Drawn from `pool` each time, or always `boss`. */
                choice: z.enum(["random", "chosen"]).default("random"),
                boss: z.enum(BOSS_KINDS).default("wither-skeleton"),
                pool: z
                    .array(z.enum(BOSS_KINDS))
                    .max(BOSS_KINDS.length)
                    .transform((kinds) => [...new Set(kinds)])
                    .default([...BOSS_KINDS]),
                difficulty: z.enum(BOSS_DIFFICULTIES).default("epic"),
                /** Fought in a closed arena built into empty air, so nothing it does
                 *  reaches the land. */
                arena: z.boolean().default(true),
                /** Its health for one fighter on Normal; harder levels and more
                 *  fighters raise it. */
                health: z.number().int().min(100).max(1024).default(400),
                place: placeSchema.default({ mode: "players" }),
                /** Who wins: whoever dealt it the most damage, or whoever felled it. */
                winner: z.enum(BOSS_WINNERS).default("damage"),
                /** A named Nether Star for the winner, once it is felled. */
                trophy: z.boolean().default(true)
            })
            .refine(
                (value) =>
                    value.arena ||
                    value.choice === "random" ||
                    !ARENA_ONLY_BOSSES.includes(value.boss),
                { message: problem("witherArenaOnly"), path: ["boss"] }
            )
            .refine(
                (value) =>
                    value.choice === "chosen" || bossesFor(value.arena, value.pool).length > 0,
                { message: problem("chooseBoss"), path: ["pool"] }
            )
    ),
    fishing: z.object({}),
    trivia: z.object({
        rounds: z.number().int().min(3).max(15).default(8),
        seconds: z.number().int().min(15).max(90).default(30),
        mode: z.enum(TRIVIA_MODES).default("mixed"),
        /** Written by the operator, asked before the built-in ones. */
        questions: z.array(triviaQuestionSchema).max(100).default([])
    }),
    explorer: z.object({
        mode: z.enum(["distance", "race"]).default("distance"),
        distance: z.number().int().min(200).max(3000).default(800),
        place: placeSchema.default({ mode: "players" })
    }),
    "happy-hour": z
        .object({
            haste: z.boolean().default(true),
            luck: z.boolean().default(true),
            speed: z.boolean().default(false),
            regeneration: z.boolean().default(false)
        })
        .refine((value) => value.haste || value.luck || value.speed || value.regeneration, {
            message: problem("chooseEffect")
        }),
    "king-of-the-hill": z.object({
        place: placeSchema.default({ mode: "players" }),
        radius: z.number().int().min(3).max(20).default(6),
        /** Played by who joins, brought to it with nothing in their hands - their
         *  things kept and given back after - where nobody can die, and pushing
         *  is how the circle is won (`kinds/hill`). */
        fistsOnly: z.boolean().default(true),
        /** With fists only: the game split into rounds, the ring whole and in
         *  the middle again at the start of each (`kinds/hill`, the ring). */
        rounds: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(5, problem("atMost", { count: 5 }))
            .default(3),
        /** With fists only: the ring shrinks over each round, down to what the
         *  players need (`hill.leastRadius`). */
        shrinks: z.boolean().default(true),
        /** With fists only: the ring drifts over the platform. */
        moves: z.boolean().default(true)
    }),
    "treasure-hunt": z.object({
        chests: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(10, problem("atMost", { count: 10 }))
            .default(5),
        /** How far from the players the treasure is hidden, at most. */
        distance: z
            .number()
            .int()
            .min(50, problem("atLeast", { count: 50 }))
            .max(1000, problem("atMost", { count: 1000 }))
            .default(300),
        /** A bastion's treasure room by default: the richest table there is. */
        loot: z.enum(LOOT_TABLES).default("bastion")
    }),
    gathering: z.object({
        /** Drawn at the start of each round, from the list, when `random`. */
        material: z.enum([...GATHER_MATERIALS, "random"]).default("random"),
        /** Short rounds, each for its own material. */
        rounds: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(6, problem("atMost", { count: 6 }))
            .default(3),
        roundMinutes: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(5, problem("atMost", { count: 5 }))
            .default(2)
    }),
    "rare-catch": z.object({
        treasure: z.enum([...RARE_CATCHES, "any"]).default("any")
    }),
    "xp-boost": z
        .object({
            /** Experience points on top of the game's own, per mob killed. */
            perKill: z
                .number()
                .int()
                .min(0)
                .max(100, problem("atMost", { count: 100 }))
                .default(5),
            /** And per ore block mined. */
            perOre: z
                .number()
                .int()
                .min(0)
                .max(100, problem("atMost", { count: 100 }))
                .default(3)
        })
        .refine((value) => value.perKill > 0 || value.perOre > 0, {
            message: problem("killsOrOres")
        }),
    waves: z.object({
        place: placeSchema.default({ mode: "players" }),
        waves: z
            .number()
            .int()
            .min(3, problem("wavesAtLeast", { count: 3 }))
            .max(10, problem("wavesAtMost", { count: 10 }))
            .default(5),
        /** Monsters in the first wave for one defender; later waves and more
         *  defenders bring more. */
        size: z
            .number()
            .int()
            .min(2, problem("atLeast", { count: 2 }))
            .max(12, problem("atMost", { count: 12 }))
            .default(4),
        mix: z.enum(WAVE_MIXES).default("classic"),
        winner: z.enum(WAVE_WINNERS).default("kills")
    }),
    "meteor-shower": z.object({
        place: placeSchema.default({ mode: "players" }),
        distance: z
            .number()
            .int()
            .min(50, problem("atLeast", { count: 50 }))
            .max(1000, problem("atMost", { count: 1000 }))
            .default(150),
        meteors: z
            .number()
            .int()
            .min(2, problem("atLeast", { count: 2 }))
            .max(30, problem("atMost", { count: 30 }))
            .default(10),
        /** Ore blocks in each meteor. */
        size: z
            .number()
            .int()
            .min(3, problem("atLeast", { count: 3 }))
            .max(12, problem("atMost", { count: 12 }))
            .default(4),
        ores: z.enum(METEOR_ORES).default("precious")
    }),
    parkour: z.preprocess(
        legacyParkour,
        z.object({
            place: placeSchema.default({ mode: "players" }),
            jumps: z
                .number()
                .int()
                .min(10, problem("atLeast", { count: 10 }))
                .max(60, problem("atMost", { count: 60 }))
                .default(PARKOUR_JUMPS),
            /** The shapes it may take (`kinds/parkour-layout`): one is drawn for each run. */
            shapes: z
                .array(z.enum(PARKOUR_SHAPES))
                .min(1, problem("chooseParkourShape"))
                .max(PARKOUR_SHAPES.length)
                .transform((shapes) => PARKOUR_SHAPES.filter((shape) => shapes.includes(shape)))
                .default([...PARKOUR_SHAPES]),
            difficulty: z.enum(PARKOUR_DIFFICULTIES).default("medium"),
            /** Drawn for each run, or always one. */
            theme: z.enum(["random", ...PARKOUR_THEMES]).default("random"),
            /** How far above the ground it is built. */
            height: z
                .number()
                .int()
                .min(25, problem("atLeast", { count: 25 }))
                .max(40, problem("atMost", { count: 40 }))
                .default(30)
        })
    ),
    spleef: z.preprocess(
        legacySpleef,
        z.object({
            place: placeSchema.default({ mode: "players" }),
            /** Blocks from the middle of the floor to its edge. */
            size: z
                .number()
                .int()
                .min(5, problem("atLeast", { count: 5 }))
                .max(15, problem("atMost", { count: 15 }))
                .default(8),
            height: z
                .number()
                .int()
                .min(25, problem("atLeast", { count: 25 }))
                .max(40, problem("atMost", { count: 40 }))
                .default(30),
            /** The ways it may be played (`kinds/spleef`): one of them is drawn for
             *  each run, so a single one is always that way. */
            variants: z
                .array(z.enum(SPLEEF_VARIANTS))
                .min(1, problem("chooseSpleefWay"))
                .max(SPLEEF_VARIANTS.length)
                .transform((ways) => SPLEEF_VARIANTS.filter((way) => ways.includes(way)))
                .default([...SPLEEF_VARIANTS])
        })
    ),
    "team-duel": z.object({
        /** The arena is built in the air above ground found here. */
        place: placeSchema.default({ mode: "players" }),
        kit: z.enum(DUEL_KITS).default("stone"),
        /** Hearts left at which a player is out of the fight and sent back to
         *  their side, before the next blow can kill them. */
        downHearts: z.number().int().min(1).max(6).default(3)
    }),
    "build-battle": z
        .object({
            place: placeSchema.default({ mode: "players" }),
            /** Each plot's floor, in blocks a side; it is as tall as it is wide. */
            plotSize: z.number().int().min(7).max(15).default(11),
            /** How long the vote lasts, after the building time (`minutes`). */
            voteSeconds: z.number().int().min(30).max(180).default(60),
            themeMode: z.enum(THEME_MODES).default("random"),
            /** Written by the operator; one is drawn when the mode is `mine`. */
            themes: z
                .array(
                    z
                        .string()
                        .trim()
                        .min(2, problem("charsAtLeast", { count: 2 }))
                        .max(40, problem("charsAtMost", { count: 40 }))
                        .regex(/^[^{}&]+$/, problem("themeChars"))
                )
                .max(50, problem("themesAtMost", { count: 50 }))
                .default([])
        })
        .refine((value) => value.themeMode === "random" || value.themes.length > 0, {
            message: problem("writeTheme"),
            path: ["themes"]
        }),
    "tnt-run": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Blocks from the middle of each floor to its edge. */
        size: z
            .number()
            .int()
            .min(5, problem("atLeast", { count: 5 }))
            .max(15, problem("atMost", { count: 15 }))
            .default(9),
        /** Floors stacked one under the other: falling through one lands on the next. */
        layers: z
            .number()
            .int()
            .min(2, problem("atLeast", { count: 2 }))
            .max(4, problem("atMost", { count: 4 }))
            .default(3),
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    }),
    "boat-race": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Times round the ice track to finish. */
        laps: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(5, problem("atMost", { count: 5 }))
            .default(2),
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    }),
    dropper: z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Floors with holes to fall through on the way down to the water. */
        levels: z
            .number()
            .int()
            .min(5, problem("atLeast", { count: 5 }))
            .max(20, problem("atMost", { count: 20 }))
            .default(10),
        difficulty: z.enum(PARKOUR_DIFFICULTIES).default("medium")
    }),
    "capture-the-flag": z.object({
        place: placeSchema.default({ mode: "players" }),
        kit: z.enum(DUEL_KITS).default("stone"),
        /** Flags brought home that win it outright, before the time is up. */
        captures: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(10, problem("atMost", { count: 10 }))
            .default(3),
        /** As in a duel: hearts left at which a player is sent back to their base. */
        downHearts: z.number().int().min(1).max(6).default(3)
    }),
    "hide-and-seek": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** How long the hiders have before the seekers can move: the house has
         *  nine rooms to run through, so longer than a hall would need. */
        hideSeconds: z
            .number()
            .int()
            .min(15, problem("atLeast", { count: 15 }))
            .max(90, problem("atMost", { count: 90 }))
            .default(45),
        /** Seekers at the start; everybody found becomes one. */
        seekers: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(3, problem("atMost", { count: 3 }))
            .default(1),
        house: z.enum(HOUSE_SIZES).default("auto"),
        /** Minutes between the hiders' power-ups; 0 for none. */
        powerUpMinutes: z
            .number()
            .int()
            .min(0, problem("atLeast", { count: 0 }))
            .max(10, problem("atMost", { count: 10 }))
            .default(2)
    }),
    "hot-potato": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Seconds before the potato goes off in whoever holds it. */
        fuseSeconds: z
            .number()
            .int()
            .min(10, problem("atLeast", { count: 10 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(20)
    }),
    "sky-wars": z.object({
        place: placeSchema.default({ mode: "players" }),
        loot: z.enum(SKY_WARS_LOOT).default("normal"),
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    }),
    "village-defense": z.object({
        place: placeSchema.default({ mode: "players" }),
        waves: z
            .number()
            .int()
            .min(3, problem("wavesAtLeast", { count: 3 }))
            .max(10, problem("wavesAtMost", { count: 10 }))
            .default(5),
        /** As in a horde defense: monsters in the first wave for one defender. */
        size: z
            .number()
            .int()
            .min(2, problem("atLeast", { count: 2 }))
            .max(12, problem("atMost", { count: 12 }))
            .default(4),
        mix: z.enum(WAVE_MIXES).default("classic")
    }),
    bingo: z.object({
        goal: z.enum(BINGO_GOALS).default("card"),
        /** Which items the card is drawn from: easy ones, or rarer. */
        difficulty: z.enum(PARKOUR_DIFFICULTIES).default("medium")
    }),
    "boss-fishing": z.object({
        /** Catches it takes to land the fish, for each player fishing. */
        catches: z
            .number()
            .int()
            .min(3, problem("atLeast", { count: 3 }))
            .max(30, problem("atMost", { count: 30 }))
            .default(10)
    }),
    "nether-maze": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Rooms a side: 7, 11 or 15. */
        size: z.enum(MAZE_SIZES).default("medium"),
        /** How many rooms carry fire, magma or a lava pit. */
        hazards: z.enum(MAZE_HAZARDS).default("some"),
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    }),
    "acid-rain": z.object({
        place: placeSchema.default({ mode: "players" }),
        /** The arena's floor: 17, 23 or 29 blocks a side inside its walls. */
        size: z.enum(ACID_SIZES).default("medium"),
        /** How fast the rain fills a player's bar and eats a shelter. */
        acidity: z.enum(ACIDITIES).default("mild"),
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    })
} as const satisfies Record<EventKind, z.ZodTypeAny>;

export type EventOptions<K extends EventKind> = z.output<(typeof optionsSchemas)[K]>;

/** One event the operator set up: a kind, how long, its options, its prizes. */
export interface EventPreset<K extends EventKind = EventKind> {
    readonly id: string;
    readonly kind: K;
    readonly name: string;
    readonly enabled: boolean;
    readonly minutes: number;
    /** The least to be ranked; absent reads the kind's default (`minScoreOf`). */
    readonly minScore?: number;
    /** The fewest players it goes ahead with; absent reads the kind's default (`minPlayersOf`). */
    readonly minPlayers?: number;
    readonly options: EventOptions<K>;
    readonly rewards: Rewards;
}

export const DURATION = { min: 3, max: 60 } as const;

const presetBase = z.object({
    id: z.string().min(1).max(64),
    name: z
        .string()
        .trim()
        .min(1, problem("giveName"))
        .max(40, problem("charsAtMost", { count: 40 })),
    enabled: z.boolean().default(true),
    minutes: z.number().int().min(DURATION.min).max(DURATION.max).default(10),
    /** The least a player must score to be ranked at all, and to get the prize
     *  for taking part. Absent on an event saved before it existed, which then
     *  reads its kind's default (`minScoreOf`). */
    minScore: z
        .number()
        .int()
        .min(1, problem("atLeast", { count: 1 }))
        .max(1_000_000)
        .optional(),
    /** Below this many players it does not go ahead: players who joined, for an
     *  event players join; players on the server when it starts, for the rest.
     *  Absent on an event saved before it existed, which then reads its kind's
     *  default (`minPlayersOf`). */
    minPlayers: z
        .number()
        .int()
        .min(1, problem("atLeast", { count: 1 }))
        .max(50, problem("atMost", { count: 50 }))
        .optional(),
    rewards: rewardsSchema
});

export const presetSchema = z
    .discriminatedUnion("kind", [
        presetBase.extend({
            kind: z.literal("mining-rush"),
            options: optionsSchemas["mining-rush"]
        }),
        presetBase.extend({ kind: z.literal("mob-hunt"), options: optionsSchemas["mob-hunt"] }),
        presetBase.extend({
            kind: z.literal("supply-drop"),
            options: optionsSchemas["supply-drop"]
        }),
        presetBase.extend({ kind: z.literal("blood-moon"), options: optionsSchemas["blood-moon"] }),
        presetBase.extend({ kind: z.literal("world-boss"), options: optionsSchemas["world-boss"] }),
        presetBase.extend({ kind: z.literal("fishing"), options: optionsSchemas.fishing }),
        presetBase.extend({ kind: z.literal("trivia"), options: optionsSchemas.trivia }),
        presetBase.extend({ kind: z.literal("explorer"), options: optionsSchemas.explorer }),
        presetBase.extend({ kind: z.literal("happy-hour"), options: optionsSchemas["happy-hour"] }),
        presetBase.extend({
            kind: z.literal("king-of-the-hill"),
            options: optionsSchemas["king-of-the-hill"]
        }),
        presetBase.extend({
            kind: z.literal("treasure-hunt"),
            options: optionsSchemas["treasure-hunt"]
        }),
        presetBase.extend({ kind: z.literal("gathering"), options: optionsSchemas.gathering }),
        presetBase.extend({ kind: z.literal("rare-catch"), options: optionsSchemas["rare-catch"] }),
        presetBase.extend({ kind: z.literal("xp-boost"), options: optionsSchemas["xp-boost"] }),
        presetBase.extend({ kind: z.literal("waves"), options: optionsSchemas.waves }),
        presetBase.extend({
            kind: z.literal("meteor-shower"),
            options: optionsSchemas["meteor-shower"]
        }),
        presetBase.extend({ kind: z.literal("parkour"), options: optionsSchemas.parkour }),
        presetBase.extend({ kind: z.literal("spleef"), options: optionsSchemas.spleef }),
        presetBase.extend({ kind: z.literal("team-duel"), options: optionsSchemas["team-duel"] }),
        presetBase.extend({
            kind: z.literal("build-battle"),
            options: optionsSchemas["build-battle"]
        }),
        presetBase.extend({
            kind: z.literal("tnt-run"),
            options: optionsSchemas["tnt-run"]
        }),
        presetBase.extend({
            kind: z.literal("boat-race"),
            options: optionsSchemas["boat-race"]
        }),
        presetBase.extend({
            kind: z.literal("dropper"),
            options: optionsSchemas["dropper"]
        }),
        presetBase.extend({
            kind: z.literal("capture-the-flag"),
            options: optionsSchemas["capture-the-flag"]
        }),
        presetBase.extend({
            kind: z.literal("hide-and-seek"),
            options: optionsSchemas["hide-and-seek"]
        }),
        presetBase.extend({
            kind: z.literal("hot-potato"),
            options: optionsSchemas["hot-potato"]
        }),
        presetBase.extend({
            kind: z.literal("sky-wars"),
            options: optionsSchemas["sky-wars"]
        }),
        presetBase.extend({
            kind: z.literal("village-defense"),
            options: optionsSchemas["village-defense"]
        }),
        presetBase.extend({
            kind: z.literal("bingo"),
            options: optionsSchemas["bingo"]
        }),
        presetBase.extend({
            kind: z.literal("boss-fishing"),
            options: optionsSchemas["boss-fishing"]
        }),
        presetBase.extend({
            kind: z.literal("nether-maze"),
            options: optionsSchemas["nether-maze"]
        }),
        presetBase.extend({ kind: z.literal("acid-rain"), options: optionsSchemas["acid-rain"] })
    ])
    .transform((value) => value as EventPreset);

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const daysSchema = z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((days) => [...new Set(days)].sort());

export const scheduleEntrySchema = z.object({
    id: z.string().min(1).max(64),
    presetId: z.string().min(1).max(64),
    enabled: z.boolean().default(true),
    /** Empty means every day. 0 is Sunday. */
    days: daysSchema.default([]),
    at: z.string().regex(TIME, problem("timeFormat"))
});

export type EventScheduleEntry = z.infer<typeof scheduleEntrySchema>;

/** The most events one server keeps, and the most the random draw picks from. */
const EVENTS_AT_MOST = 40;
const POOL_AT_MOST = 50;

export const randomSchema = z
    .object({
        enabled: z.boolean().default(false),
        days: daysSchema.default([]),
        /** The same time in both is any time of day, which is the default: each
         *  event's own conditions decide whether now suits it. */
        from: z.string().regex(TIME, problem("timeFormat")).default("00:00"),
        to: z.string().regex(TIME, problem("timeFormat")).default("00:00"),
        minGap: z
            .number()
            .int()
            .min(15)
            .max(24 * 60)
            .default(60),
        maxGap: z
            .number()
            .int()
            .min(15)
            .max(24 * 60)
            .default(120),
        /** Which events it draws from, and how often each comes up. */
        pool: z
            .array(
                z.object({
                    presetId: z.string().min(1).max(64),
                    weight: z.number().int().min(1).max(10)
                })
            )
            .max(POOL_AT_MOST)
            .default([])
    })
    .refine((value) => value.maxGap >= value.minGap, {
        message: problem("gapOrder"),
        path: ["maxGap"]
    });

export type RandomEvents = z.infer<typeof randomSchema>;

/**
 * Which defaults a server's events were last saved with. Events saved before
 * the defaults were set by kind carry no number, and are brought up to them
 * once (`toKindDefaults`) - never again after the screen has saved them, so a
 * value an operator chooses later, even one that happens to be an old default,
 * is theirs.
 */
export const DEFAULTS_VERSION = 5;

/** Events saved before this were brought up to their kind's defaults once
 *  (`toKindDefaults`). */
const KIND_DEFAULTS_SINCE = 2;

/**
 * The defaults version each kind joined the catalog at. A server whose events
 * were saved before a kind existed is given one of it, once, the way a server
 * that never saved its events is given one of every kind - otherwise a kind
 * added in an update is offered only to servers set up after it, and every
 * server already running never hears of it. One the operator deletes after
 * that stays deleted: the save writes the new version down.
 */
const KIND_SINCE: Partial<Readonly<Record<EventKind, number>>> = {
    "tnt-run": 3,
    "boat-race": 3,
    dropper: 3,
    "capture-the-flag": 3,
    "hide-and-seek": 3,
    "hot-potato": 3,
    "sky-wars": 3,
    "village-defense": 3,
    bingo: 3,
    "boss-fishing": 3,
    "nether-maze": 4,
    "acid-rain": 5
};

export const settingsSchema = z.object({
    defaults: z.number().int().min(1).max(1000).default(DEFAULTS_VERSION),
    /** What the players read. The screen itself is in English, like the rest. */
    language: z.enum(LANGUAGES).default("en"),
    /** An automatic event waits for at least this many players who are playing,
     *  not standing still. */
    minActive: z.number().int().min(1).max(50).default(2),
    /** How long somebody may stand still before they stop counting as active. */
    afkMinutes: z.number().int().min(2).max(30).default(5),
    /** How long players are warned before an event begins. */
    countdownSeconds: z.number().int().min(0).max(300).default(60),
    timezone: z.string().min(1).max(64).default("UTC"),
    random: randomSchema.default({})
});

export type EventSettings = z.infer<typeof settingsSchema>;

export const eventsConfigSchema = z
    .object({
        settings: settingsSchema.default({}),
        presets: z
            .array(presetSchema)
            .max(EVENTS_AT_MOST, problem("eventsAtMost", { count: EVENTS_AT_MOST })),
        schedules: z
            .array(scheduleEntrySchema)
            .max(40, problem("schedulesAtMost", { count: 40 }))
            .default([])
    })
    .superRefine((value, context) => {
        const ids = new Set(value.presets.map((preset) => preset.id));
        value.schedules.forEach((entry, index) => {
            if (!ids.has(entry.presetId)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["schedules", index, "presetId"],
                    message: problem("eventGone")
                });
            }
        });
        value.settings.random.pool.forEach((entry, index) => {
            if (!ids.has(entry.presetId)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["settings", "random", "pool", index, "presetId"],
                    message: problem("eventGone")
                });
            }
        });
    });

export type EventsConfig = z.infer<typeof eventsConfigSchema>;

/** An event's kind in the players' words: titles, and the name a server's first
 *  events are given in its language. */
export const KIND_NAMES: Readonly<Record<EventKind, Readonly<Record<Language, string>>>> = {
    "mining-rush": { en: "Mining rush", es: "Fiebre minera" },
    "mob-hunt": { en: "Mob hunt", es: "Cacería" },
    "supply-drop": { en: "Supply drop", es: "Suministro aéreo" },
    "blood-moon": { en: "Blood moon", es: "Luna de sangre" },
    "world-boss": { en: "World boss", es: "Jefe de mundo" },
    fishing: { en: "Fishing contest", es: "Concurso de pesca" },
    trivia: { en: "Trivia", es: "Trivia" },
    explorer: { en: "Explorer", es: "Explorador" },
    "happy-hour": { en: "Happy hour", es: "Hora feliz" },
    "king-of-the-hill": { en: "King of the ring", es: "Rey del ring" },
    "treasure-hunt": { en: "Treasure hunt", es: "Búsqueda del tesoro" },
    gathering: { en: "Gathering", es: "Recolección" },
    "rare-catch": { en: "Rare catch", es: "Pesca rara" },
    "xp-boost": { en: "Experience boost", es: "Experiencia extra" },
    waves: { en: "Horde defense", es: "Oleadas" },
    "meteor-shower": { en: "Meteor shower", es: "Lluvia de meteoritos" },
    parkour: { en: "Parkour race", es: "Carrera de parkour" },
    spleef: { en: "Spleef", es: "El suelo es lava" },
    "team-duel": { en: "Team duel", es: "Duelo por equipos" },
    "build-battle": { en: "Build battle", es: "Construcción rápida" },
    "tnt-run": { en: "TNT run", es: "TNT run" },
    "boat-race": { en: "Ice boat race", es: "Carrera de barcos" },
    dropper: { en: "Dropper", es: "Dropper" },
    "capture-the-flag": { en: "Capture the flag", es: "Captura la bandera" },
    "hide-and-seek": { en: "Hide and seek", es: "Escondite" },
    "hot-potato": { en: "Hot potato", es: "Patata bomba" },
    "sky-wars": { en: "SkyWars", es: "SkyWars" },
    "village-defense": { en: "Villager defense", es: "Defensa del aldeano" },
    bingo: { en: "Bingo rush", es: "Bingo exprés" },
    "boss-fishing": { en: "Boss fishing", es: "Pesca del jefe" },
    "nether-maze": { en: "Deadly nether maze", es: "Laberintos mortales" },
    "acid-rain": { en: "Acid rain", es: "Lluvia ácida" }
};

/** What an event of each kind is. Its name and summary on a screen are the
 *  catalog's (`events.kinds.<kind>`), in the reader's language. */
export interface KindInfo {
    /** What decides who wins, in the words the podium uses. */
    readonly unit: string;
    /** Whether it ends with a podium at all. */
    readonly competitive: boolean;
}

export const KIND_INFO: Readonly<Record<EventKind, KindInfo>> = {
    "mining-rush": {
        unit: "points",
        competitive: true
    },
    "mob-hunt": {
        unit: "points",
        competitive: true
    },
    "supply-drop": {
        unit: "",
        competitive: true
    },
    "blood-moon": {
        unit: "kills",
        competitive: true
    },
    "world-boss": {
        unit: "damage",
        competitive: true
    },
    fishing: {
        unit: "catches",
        competitive: true
    },
    trivia: {
        unit: "rounds",
        competitive: true
    },
    explorer: {
        unit: "meters",
        competitive: true
    },
    "happy-hour": {
        unit: "",
        competitive: false
    },
    "king-of-the-hill": {
        unit: "seconds",
        competitive: true
    },
    "treasure-hunt": {
        unit: "chests",
        competitive: true
    },
    gathering: {
        unit: "points",
        competitive: true
    },
    "rare-catch": {
        unit: "",
        competitive: true
    },
    "xp-boost": {
        unit: "",
        competitive: false
    },
    waves: {
        unit: "kills",
        competitive: true
    },
    "meteor-shower": {
        unit: "blocks",
        competitive: true
    },
    parkour: {
        unit: "jumps",
        competitive: true
    },
    spleef: {
        unit: "points",
        competitive: true
    },
    "team-duel": {
        unit: "eliminations",
        competitive: true
    },
    "build-battle": {
        unit: "votes",
        competitive: true
    },
    "tnt-run": {
        unit: "points",
        competitive: true
    },
    "boat-race": {
        unit: "laps",
        competitive: true
    },
    dropper: {
        unit: "levels",
        competitive: true
    },
    "capture-the-flag": {
        unit: "captures",
        competitive: true
    },
    "hide-and-seek": {
        unit: "points",
        competitive: true
    },
    "hot-potato": {
        unit: "points",
        competitive: true
    },
    "sky-wars": {
        unit: "points",
        competitive: true
    },
    "village-defense": {
        unit: "kills",
        competitive: true
    },
    bingo: {
        unit: "items",
        competitive: true
    },
    "boss-fishing": {
        unit: "catches",
        competitive: true
    },
    "nether-maze": {
        unit: "rooms",
        competitive: true
    },
    "acid-rain": {
        unit: "points",
        competitive: true
    }
};

/** What decides who wins, in the words the podium uses: the kind's own, or a
 *  horde defense's damage when that decides it. */
export function unitOf(preset: EventPreset): string {
    if (preset.kind === "waves" && (preset.options as EventOptions<"waves">).winner === "damage")
        return "damage";
    return KIND_INFO[preset.kind].unit;
}

/** What every new competition paid before the prizes were set by kind: an event
 *  still on exactly these is taken to be on its default (`toKindDefaults`). */
export const OLD_DEFAULT_REWARDS: Rewards = {
    first: { items: [{ id: "minecraft:diamond", count: 5 }], levels: 15 },
    second: { items: [{ id: "minecraft:diamond", count: 3 }], levels: 10 },
    third: { items: [{ id: "minecraft:diamond", count: 1 }], levels: 5 },
    everyone: { items: [{ id: "minecraft:experience_bottle", count: 8 }], levels: 0 }
};

const prize = (levels: number, ...items: readonly (readonly [string, number])[]): Reward => ({
    items: items.map(([id, count]) => ({ id: `minecraft:${id}`, count })),
    levels
});

const NO_REWARDS: Rewards = {
    first: NO_REWARD,
    second: NO_REWARD,
    third: NO_REWARD,
    everyone: NO_REWARD
};

/** One winner, who keeps what they found besides: a little experience on top. */
const FOUND_IT: Rewards = {
    first: prize(3, ["experience_bottle", 12]),
    second: NO_REWARD,
    third: NO_REWARD,
    everyone: NO_REWARD
};

/** A few minutes of one skill, or a question game. */
const QUICK: Rewards = {
    first: prize(3, ["diamond", 1], ["experience_bottle", 8]),
    second: prize(2, ["gold_ingot", 4], ["experience_bottle", 4]),
    third: prize(1, ["iron_ingot", 4], ["experience_bottle", 2]),
    everyone: prize(0, ["experience_bottle", 3])
};

/** Several minutes of steady work: mining, hunting, gathering, searching. */
const STANDARD: Rewards = {
    first: prize(5, ["diamond", 2], ["experience_bottle", 12]),
    second: prize(3, ["diamond", 1], ["experience_bottle", 8]),
    third: prize(2, ["gold_ingot", 6], ["experience_bottle", 4]),
    everyone: prize(0, ["experience_bottle", 4])
};

/** A fight: a night out among monsters, a duel. */
const HARD: Rewards = {
    first: prize(8, ["diamond", 3], ["golden_apple", 2]),
    second: prize(5, ["diamond", 2], ["golden_apple", 1]),
    third: prize(3, ["diamond", 1], ["experience_bottle", 8]),
    everyone: prize(0, ["experience_bottle", 6])
};

/** The longest and hardest: a horde held off wave after wave, a build and its vote. */
const EPIC: Rewards = {
    first: prize(12, ["diamond", 5], ["golden_apple", 3]),
    second: prize(8, ["diamond", 3], ["golden_apple", 2]),
    third: prize(5, ["diamond", 2], ["golden_apple", 1]),
    everyone: prize(0, ["experience_bottle", 8])
};

/** A world boss on Normal. Its difficulty multiplies it (`BOSS_PRIZE_TIMES`), so
 *  on Epic - the default - it pays the most of all, and its trophy besides. */
const BOSS: Rewards = {
    first: prize(8, ["diamond", 3], ["golden_apple", 2]),
    second: prize(5, ["diamond", 2], ["golden_apple", 1]),
    third: prize(3, ["diamond", 1]),
    everyone: prize(0, ["experience_bottle", 6])
};

/**
 * What each kind pays when it is made, by how hard, how long and how much work
 * it is: a quick race or a question game little, a night of fighting more, a
 * horde defense, a build battle and a world boss the most.
 */
export const DEFAULT_PRIZES: Readonly<Record<EventKind, Rewards>> = {
    "mining-rush": STANDARD,
    "mob-hunt": STANDARD,
    "supply-drop": FOUND_IT,
    "blood-moon": HARD,
    "world-boss": BOSS,
    fishing: QUICK,
    trivia: QUICK,
    explorer: STANDARD,
    "happy-hour": NO_REWARDS,
    "king-of-the-hill": STANDARD,
    "treasure-hunt": STANDARD,
    gathering: STANDARD,
    "rare-catch": FOUND_IT,
    "xp-boost": NO_REWARDS,
    waves: EPIC,
    "meteor-shower": STANDARD,
    parkour: QUICK,
    spleef: QUICK,
    "team-duel": HARD,
    "build-battle": EPIC,
    "tnt-run": QUICK,
    "boat-race": QUICK,
    dropper: QUICK,
    "capture-the-flag": HARD,
    "hide-and-seek": STANDARD,
    "hot-potato": QUICK,
    "sky-wars": HARD,
    "village-defense": EPIC,
    bingo: STANDARD,
    "boss-fishing": STANDARD,
    "nether-maze": STANDARD,
    "acid-rain": STANDARD
};

/** The names a king of the ring was given by default while it was a hill, and
 *  what each reads as now. */
const OLD_HILL_NAMES: ReadonlyMap<unknown, string> = new Map([
    ["King of the hill", "King of the ring"],
    ["Rey de la colina", "Rey del ring"]
]);

/** A king of the hill's length: three minutes of pushing is plenty. */
export const HILL_MINUTES = 3;

/**
 * How long each kind runs when it is made, in minutes: what fits it. A trivia
 * game, a gathering and a horde defense run for their rounds and waves
 * (`runMinutes`), whatever this says.
 */
export const DEFAULT_MINUTES: Readonly<Record<EventKind, number>> = {
    "mining-rush": 5,
    "mob-hunt": 5,
    "supply-drop": 5,
    "blood-moon": 8,
    "world-boss": 10,
    fishing: 8,
    trivia: 5,
    explorer: 6,
    "happy-hour": 20,
    "king-of-the-hill": HILL_MINUTES,
    "treasure-hunt": 8,
    gathering: 6,
    "rare-catch": 8,
    "xp-boost": 20,
    waves: 10,
    "meteor-shower": 6,
    parkour: 4,
    spleef: 4,
    "team-duel": 5,
    "build-battle": 8,
    "tnt-run": 4,
    "boat-race": 5,
    dropper: 4,
    "capture-the-flag": 8,
    "hide-and-seek": 7,
    "hot-potato": 5,
    "sky-wars": 8,
    "village-defense": 10,
    bingo: 15,
    "boss-fishing": 10,
    "nether-maze": 6,
    "acid-rain": 6
};

/** What every kind ran for before `DEFAULT_MINUTES`: an event still on exactly
 *  this is taken to be on its default (`toKindDefaults`). */
export function oldDefaultMinutes(kind: EventKind): number {
    if (kind === "happy-hour" || kind === "xp-boost" || kind === "rare-catch") return 20;
    return kind === "trivia" ? 5 : 10;
}

/**
 * A king of the hill saved before "fists only" existed, and still on the ten
 * minutes every event started with then, is read as the shorter length it has
 * now: ten was nobody's choice, and ten minutes of it was too long. One saved
 * since carries the option, and keeps whatever length it was given.
 */
export function migratePreset(entry: unknown): unknown {
    if (typeof entry !== "object" || entry === null) return entry;
    const named = entry as { kind?: unknown; name?: unknown };
    if (named.kind !== "king-of-the-hill") return entry;
    // Named "King of the hill" when it was added, before it became a ring
    // floating in the air: the name it was given, not one anybody chose.
    const renamed = OLD_HILL_NAMES.get(named.name);
    const raw = (renamed ? { ...entry, name: renamed } : entry) as {
        kind?: unknown;
        minutes?: unknown;
        options?: unknown;
    };
    // Four was the length every hill started with until it was shortened to
    // three: nobody's choice either.
    if (raw.minutes === 4) return { ...raw, minutes: HILL_MINUTES };
    if (raw.minutes !== 10) return raw;
    const options = raw.options;
    if (typeof options === "object" && options !== null && "fistsOnly" in options) return raw;
    return { ...raw, minutes: HILL_MINUTES };
}

/** A new event of one kind, as the screen adds it. */
export function newPreset(kind: EventKind, id: string, name = KIND_NAMES[kind].en): EventPreset {
    const options = optionsSchemas[kind].parse({}) as EventOptions<EventKind>;
    return {
        id,
        kind,
        name,
        enabled: true,
        minutes: DEFAULT_MINUTES[kind],
        minScore: DEFAULT_MIN_SCORE[kind],
        minPlayers: defaultMinPlayers(kind),
        options,
        rewards: KIND_INFO[kind].competitive ? DEFAULT_PRIZES[kind] : NO_REWARDS
    };
}

/**
 * A saved event as it can still be read: whole when it reads, otherwise every
 * part of it that still reads on top of its kind's defaults, and the parts
 * that had to be set back (`minutes`, `options.size`). Null for what is not an
 * event of a kind this version knows.
 */
export function repairPreset(entry: unknown): { preset: EventPreset; reset: string[] } | null {
    const whole = presetSchema.safeParse(entry);
    if (whole.success) return { preset: whole.data, reset: [] };
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    if (!EVENT_KINDS.includes(raw.kind as EventKind)) return null;
    const kind = raw.kind as EventKind;
    const id =
        typeof raw.id === "string" && raw.id.length > 0 ? raw.id.slice(0, 64) : `${kind}-saved`;
    let current: Record<string, unknown> = { ...newPreset(kind, id) };
    const reset: string[] = [];
    const reads = (candidate: Record<string, unknown>) => presetSchema.safeParse(candidate).success;
    for (const [key, value] of Object.entries(raw)) {
        if (key === "kind" || key === "options" || key === "id") continue;
        const next = { ...current, [key]: value };
        if (reads(next)) current = next;
        else reset.push(key);
    }
    if (typeof raw.options === "object" && raw.options !== null && !Array.isArray(raw.options)) {
        for (const [key, value] of Object.entries(raw.options)) {
            const options = { ...(current.options as Record<string, unknown>), [key]: value };
            const next = { ...current, options };
            if (reads(next)) current = next;
            else reset.push(`options.${key}`);
        }
    }
    const final = presetSchema.safeParse(current);
    return final.success ? { preset: final.data, reset } : null;
}

/** The saved events that had parts set back to their defaults, by name - for
 *  the screen to say so. */
export function repairedPresets(
    config: Record<string, unknown>
): { id: string; name: string; reset: string[] }[] {
    const raw = config[EVENTS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
    return readPresets((raw as { presets?: unknown }).presets).flatMap(({ preset, reset }) =>
        reset.length > 0 ? [{ id: preset.id, name: preset.name, reset }] : []
    );
}

/**
 * Every saved event that can still be read (`repairPreset`), each with an id of
 * its own: one that had to be set back and shares its id with another - two
 * left without one, or cut to the same length - takes a numbered one, so
 * editing, scheduling or drawing it never reaches the other.
 */
function readPresets(list: unknown): { preset: EventPreset; reset: string[] }[] {
    const read = (Array.isArray(list) ? list : []).flatMap((entry) => {
        const repaired = repairPreset(migratePreset(entry));
        return repaired ? [repaired] : [];
    });
    const taken = new Set(read.filter((one) => one.reset.length === 0).map((one) => one.preset.id));
    return read.map((one) => {
        if (one.reset.length === 0) return one;
        let id = one.preset.id;
        for (let n = 2; taken.has(id); n++)
            id = `${one.preset.id.slice(0, 63 - String(n).length)}-${n}`;
        taken.add(id);
        return id === one.preset.id ? one : { ...one, preset: { ...one.preset, id } };
    });
}

/** The name the first events gave a horde defense. */
const BRITISH_HORDE_NAME = "Horde defence";

const same = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

/**
 * An event saved before its defaults were set by kind, brought up to them where
 * it never left the old ones - an operator who changed a value keeps it: prizes
 * still exactly the old five diamonds and fifteen levels, a duration still the
 * old default, a meteor shower still on four meteors or six blocks, and the
 * name the first events gave a horde defense, spelled the British way.
 */
export function toKindDefaults(preset: EventPreset): EventPreset {
    let next = preset;
    if (KIND_INFO[preset.kind].competitive && same(preset.rewards, OLD_DEFAULT_REWARDS))
        next = { ...next, rewards: DEFAULT_PRIZES[preset.kind] };
    // A king of the hill's length is `migratePreset`'s, which runs first.
    if (preset.kind !== "king-of-the-hill" && preset.minutes === oldDefaultMinutes(preset.kind))
        next = { ...next, minutes: DEFAULT_MINUTES[preset.kind] };
    if (preset.kind === "waves" && preset.name === BRITISH_HORDE_NAME)
        next = { ...next, name: KIND_NAMES.waves.en };
    if (preset.kind === "meteor-shower") {
        const options = preset.options as EventOptions<"meteor-shower">;
        const fresh = optionsSchemas["meteor-shower"].parse({});
        next = {
            ...next,
            options: {
                ...options,
                meteors: options.meteors === 4 ? fresh.meteors : options.meteors,
                size: options.size === 6 ? fresh.size : options.size
            }
        } as EventPreset;
    }
    return next;
}

/** The value that comes up most often, the first of a tie; null for none. */
function mostCommon(values: readonly number[]): number | null {
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best: number | null = null;
    for (const [value, count] of counts)
        if (best === null || count > counts.get(best)!) best = value;
    return best;
}

/** Every kind once, which is what a server that never opened this screen has. */
export function defaultEventsConfig(language: Language = "en"): EventsConfig {
    return {
        settings: settingsSchema.parse({}),
        presets: EVENT_KINDS.map((kind) =>
            newPreset(kind, `default-${kind}`, KIND_NAMES[kind][language])
        ),
        schedules: []
    };
}

/**
 * The language the operator chose for what players read, or null when none was
 * ever chosen - the server then speaks its owner's (`speech-service`).
 */
export function chosenLanguage(config: Record<string, unknown>): Language | null {
    const raw = config[EVENTS_KEY];
    if (typeof raw !== "object" || raw === null) return null;
    const settings = (raw as { settings?: unknown }).settings;
    if (typeof settings !== "object" || settings === null) return null;
    const language = (settings as { language?: unknown }).language;
    return LANGUAGES.includes(language as Language) ? (language as Language) : null;
}

/**
 * The stored settings, whole.
 *
 * A preset that no longer reads whole - a value a later version no longer
 * allows - keeps every part that still reads and has the rest set back to its
 * kind's defaults (`repairPreset`); only one of a kind this version does not
 * know is left out. A server that has
 * none gets one of each kind, named in `language`, so the screen opens on something
 * to run.
 */
export function readEventsConfig(
    config: Record<string, unknown>,
    timezone = "UTC",
    language: Language = "en"
): EventsConfig {
    const raw = config[EVENTS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        const fresh = defaultEventsConfig(language);
        return { ...fresh, settings: { ...fresh.settings, timezone } };
    }
    const value = raw as Record<string, unknown>;
    const stamp = (value.settings as { defaults?: unknown } | undefined)?.defaults;
    const saved = typeof stamp === "number" ? stamp : 1;
    const settings = settingsSchema.safeParse(value.settings);
    const read = settings.success ? settings.data : settingsSchema.parse({ timezone });
    // A king of the hill's own length first (`migratePreset`), then every
    // kind's defaults, which leave a king of the hill's length to it.
    // One that no longer reads whole keeps every part that does, the rest
    // back to its kind's defaults (`repairPreset`), rather than vanishing
    // from the list and the draw with nothing to say so.
    const kept = readPresets(value.presets).map(({ preset }) =>
        saved < KIND_DEFAULTS_SINCE ? toKindDefaults(preset) : preset
    );
    // Every kind this server's events were saved before, once, named in the
    // language its players read.
    const had = new Set(kept.map((preset) => preset.kind));
    const taken = new Set(kept.map((preset) => preset.id));
    const added = EVENT_KINDS.filter((kind) => (KIND_SINCE[kind] ?? 1) > saved && !had.has(kind))
        .slice(0, Math.max(0, EVENTS_AT_MOST - kept.length))
        .map((kind) => {
            let id = `default-${kind}`;
            while (taken.has(id)) id = `${id}-2`;
            taken.add(id);
            return newPreset(kind, id, KIND_NAMES[kind][read.language]);
        });
    const presets = [...kept, ...added];
    const ids = new Set(presets.map((preset) => preset.id));
    const schedules = (Array.isArray(value.schedules) ? value.schedules : []).flatMap((entry) => {
        const parsed = scheduleEntrySchema.safeParse(entry);
        return parsed.success && ids.has(parsed.data.presetId) ? [parsed.data] : [];
    });
    const pool = read.random.pool.filter((entry) => ids.has(entry.presetId));
    // Drawn from every event the server had: the new ones join the draw too,
    // as often as most of the others come up. Drawn from a choice: left to it.
    const everything =
        kept.length > 0 && kept.every((one) => pool.some((entry) => entry.presetId === one.id));
    const weight = mostCommon(pool.map((entry) => entry.weight)) ?? 1;
    return {
        settings: {
            ...read,
            // Read as brought up to date: saving it from here writes that down.
            defaults: DEFAULTS_VERSION,
            random: {
                ...read.random,
                pool: everything
                    ? [
                          ...pool,
                          ...added
                              .slice(0, Math.max(0, POOL_AT_MOST - pool.length))
                              .map((preset) => ({ presetId: preset.id, weight }))
                      ]
                    : pool
            }
        },
        presets,
        schedules
    };
}

/** How long an event of this preset really runs: a trivia game runs for its
 *  rounds, whatever the minutes say. */
/**
 * Whether an event hands out anything: a competition with at least one prize
 * that is not empty.
 */
export function awardsPrizes(preset: EventPreset): boolean {
    if (!KIND_INFO[preset.kind].competitive) return false;
    const { first, second, third, everyone } = preset.rewards;
    return [first, second, third, everyone].some(
        (reward) => reward.items.length > 0 || reward.levels > 0
    );
}

/**
 * The fewest players who must actually be playing for an event to start on its
 * own.
 *
 * Never fewer than two for a competition with prizes, whatever the setting says:
 * one player alone, or one playing beside a row of idle ones, would win it
 * uncontested - a prize for being the only one there, handed out again at every
 * draw, which is what farming a server's events looks like.
 */
export const PRIZE_COMPETITION_FLOOR = 2;

export function activeNeeded(preset: EventPreset, settings: EventSettings): number {
    const floor = Math.max(settings.minActive, minPlayersOf(preset), joinersFloor(preset));
    return awardsPrizes(preset) ? Math.max(floor, PRIZE_COMPETITION_FLOOR) : floor;
}

/** The fewest players an event goes ahead with (`minPlayers`): two for a
 *  competition, one for the rest, unless the operator chose otherwise. */
export function minPlayersOf(preset: EventPreset): number {
    return preset.minPlayers ?? defaultMinPlayers(preset.kind);
}

export function defaultMinPlayers(kind: EventKind): number {
    if (kind === "build-battle") return BUILD_BATTLE_FLOOR;
    return KIND_INFO[kind].competitive ? 2 : 1;
}

/** A build battle is voted on by the others: with two, each vote is for the
 *  only other build, and the winner is a coin toss. Three at the least,
 *  whatever the event's own minimum says. */
export const BUILD_BATTLE_FLOOR = 3;

/**
 * What each kind asks for before somebody is ranked, in its own unit: enough to
 * say they took part rather than happened to be there. Two players who each
 * kill one zombie are not a podium; nobody reaching it means nobody wins.
 */
export const DEFAULT_MIN_SCORE: Readonly<Record<EventKind, number>> = {
    "mining-rush": 10,
    "mob-hunt": 5,
    "supply-drop": 1,
    "blood-moon": 3,
    "world-boss": 20,
    fishing: 3,
    trivia: 1,
    explorer: 250,
    "happy-hour": 1,
    "king-of-the-hill": 30,
    "treasure-hunt": 1,
    gathering: 16,
    "rare-catch": 1,
    "xp-boost": 1,
    waves: 3,
    "meteor-shower": 2,
    parkour: 1,
    spleef: 1,
    "team-duel": 1,
    "build-battle": 1,
    "tnt-run": 1,
    "boat-race": 1,
    dropper: 1,
    "capture-the-flag": 1,
    "hide-and-seek": 1,
    "hot-potato": 1,
    "sky-wars": 1,
    "village-defense": 3,
    bingo: 3,
    "boss-fishing": 2,
    "nether-maze": 1,
    "acid-rain": 1
};

/** Whether the minimum is something an operator can set for this event. A
 *  supply drop, a rare catch and a race have one winner and nothing to count. */
export function hasMinScore(preset: EventPreset): boolean {
    if (!KIND_INFO[preset.kind].competitive) return false;
    if (preset.kind === "supply-drop" || preset.kind === "rare-catch") return false;
    // Ranked by the finish and by who is left standing: anybody who took part at all is.
    if (playsOnStage(preset) || lastStanding(preset)) return false;
    return !(
        preset.kind === "explorer" && (preset.options as EventOptions<"explorer">).mode === "race"
    );
}

export function minScoreOf(preset: EventPreset): number {
    if (!hasMinScore(preset)) return 1;
    return preset.minScore ?? DEFAULT_MIN_SCORE[preset.kind];
}

/**
 * Whether the event happens on the surface of the Overworld - a chest, a boss, a
 * circle, a finish line, a night - and so only counts the players who are there.
 * A player in the Nether cannot reach a chest in the Overworld, and a mining
 * rush or a trivia game does not care where anybody is.
 */
export function needsOverworld(preset: EventPreset): boolean {
    switch (preset.kind) {
        case "supply-drop":
        case "world-boss":
        case "blood-moon":
        case "king-of-the-hill":
        case "treasure-hunt":
        case "waves":
        case "meteor-shower":
        case "parkour":
        case "spleef":
        case "tnt-run":
        case "boat-race":
        case "dropper":
        case "nether-maze":
        case "acid-rain":
        case "village-defense":
            return true;
        case "explorer":
            return (preset.options as EventOptions<"explorer">).mode === "race";
        default:
            return false;
    }
}

/** The events hostile mobs are the whole of, which Peaceful takes away. */
export function needsHostileMobs(preset: EventPreset): boolean {
    return (
        preset.kind === "blood-moon" ||
        preset.kind === "world-boss" ||
        preset.kind === "mob-hunt" ||
        preset.kind === "waves" ||
        preset.kind === "village-defense"
    );
}

/**
 * Whether being AFK all the way through is a way to win it - a fishing farm, a
 * mob farm, a water stream, a bunker through the night - and so keeps somebody
 * off the podium. Not where standing still is the play: holding the hill,
 * answering in the chat.
 */
export function afkCounts(preset: EventPreset): boolean {
    switch (preset.kind) {
        case "mining-rush":
        case "mob-hunt":
        case "fishing":
        case "blood-moon":
        case "gathering":
        case "rare-catch":
        case "waves":
        case "village-defense":
        case "bingo":
        case "boss-fishing":
            return true;
        case "explorer":
            return (preset.options as EventOptions<"explorer">).mode === "distance";
        default:
            return false;
    }
}

/**
 * Whether an event is playable yet, from what it has written down: its place
 * found and set up, its boss standing, its first question asked, its players
 * brought in. Its clock only starts then (`events-service` `markReady`); an
 * event with nothing to set up is playable as soon as it begins.
 */
export function readyToPlay(run: {
    readonly preset: EventPreset;
    readonly place: unknown;
    readonly hidden: boolean;
    readonly chests: readonly unknown[];
    readonly meteors: readonly unknown[];
    readonly round: number;
    readonly stage: { readonly racers: readonly unknown[]; readonly goAt?: number | null } | null;
    readonly readyAt: number | null;
}): boolean {
    const { preset } = run;
    switch (preset.kind) {
        case "king-of-the-hill":
            // With fists only, once everybody is on the hill.
            return hillFistsOnly(preset) ? run.readyAt !== null : run.place !== null;
        case "supply-drop":
        case "world-boss":
        case "waves":
        case "village-defense":
            return run.place !== null;
        case "explorer":
            return (
                (preset.options as EventOptions<"explorer">).mode !== "race" || run.place !== null
            );
        case "treasure-hunt":
            // Once the first chest is down: the rest are hidden while it is hunted.
            return run.chests.length > 0;
        case "meteor-shower":
            return run.meteors.length > 0;
        case "trivia":
            return run.round >= 0;
        case "parkour":
        case "spleef":
        case "tnt-run":
        case "boat-race":
        case "dropper":
        case "nether-maze":
        case "acid-rain":
            // Once everybody brought in is there and the start given (`arrival`).
            return (run.stage?.racers.length ?? 0) > 0 && (run.stage?.goAt ?? null) !== null;
        case "team-duel":
        case "build-battle":
        case "capture-the-flag":
        case "hide-and-seek":
        case "hot-potato":
        case "sky-wars":
            // The arena writes its own start when everybody is in it.
            return run.readyAt !== null;
        default:
            return true;
    }
}

export function runMinutes(preset: EventPreset): number {
    if (preset.kind === "trivia") {
        const options = preset.options as EventOptions<"trivia">;
        return Math.ceil((options.rounds * (options.seconds + ROUND_PAUSE_SECONDS)) / 60);
    }
    if (preset.kind === "waves" || preset.kind === "village-defense") {
        // Time to reach the point, every wave fought to its limit with the
        // breath after it, and a minute to find the place.
        const options = preset.options as EventOptions<"waves" | "village-defense">;
        const seconds =
            WAVE_TIMING.firstSeconds +
            options.waves * (WAVE_TIMING.limitSeconds + WAVE_TIMING.pauseSeconds) +
            60;
        return Math.ceil(seconds / 60);
    }
    if (preset.kind === "build-battle") {
        const options = preset.options as EventOptions<"build-battle">;
        return preset.minutes + Math.ceil(options.voteSeconds / 60);
    }
    if (preset.kind === "gathering") {
        const options = preset.options as EventOptions<"gathering">;
        return options.rounds * options.roundMinutes;
    }
    return preset.minutes;
}

/** A horde defense's clock: how long before the first wave, how long a wave
 *  may last before it is called over, and the breath between two. */
export const WAVE_TIMING = { firstSeconds: 45, limitSeconds: 120, pauseSeconds: 20 } as const;

/** The least and the most time between two meteors of a shower: one a few
 *  seconds after the last feels like a shower, one minutes after it felt like
 *  nothing was falling. */
export const METEOR_GAP_MS = { least: 12_000, most: 40_000 } as const;

/**
 * The time between two meteors: `count` of them spread over the first three
 * quarters of an event of `totalMs`, never nearer than `METEOR_GAP_MS.least`
 * nor further apart than `METEOR_GAP_MS.most` - so a long event with few
 * meteors has them all down early and left to mine, rather than one every two
 * minutes.
 */
export function meteorGap(totalMs: number, count: number): number {
    const spread = (Math.max(0, totalMs) * 0.75) / Math.max(1, count);
    return Math.min(METEOR_GAP_MS.most, Math.max(METEOR_GAP_MS.least, Math.round(spread)));
}

/** The breath between one trivia round and the next. */
export const ROUND_PAUSE_SECONDS = 6;

// ------------------------------------------------------------------ taking part by choice

/**
 * The events a player takes part in only by saying so - `join` in the chat
 * during the countdown - because they are taken somewhere to play them and
 * brought back after. Nobody is moved who did not ask to be.
 */
export function takesJoiners(preset: EventPreset): boolean {
    return playsOnStage(preset) || playsInArena(preset);
}

/** Played on a stage built in the sky for each to play alone - a parkour
 *  course, a spleef or TNT run floor, an ice track, a dropper's shaft
 *  (`kinds/stage-service.ts`). */
export function playsOnStage(preset: EventPreset): boolean {
    return (
        preset.kind === "parkour" ||
        preset.kind === "spleef" ||
        preset.kind === "tnt-run" ||
        preset.kind === "boat-race" ||
        preset.kind === "dropper" ||
        preset.kind === "nether-maze" ||
        preset.kind === "acid-rain"
    );
}

/** Played in an arena built in the sky, by sides - two teams, a plot each, an
 *  island each - with a marked kit (`kinds/arena-service.ts`). */
export function playsInArena(preset: EventPreset): boolean {
    return (
        preset.kind === "team-duel" ||
        preset.kind === "build-battle" ||
        preset.kind === "capture-the-flag" ||
        preset.kind === "hide-and-seek" ||
        preset.kind === "hot-potato" ||
        preset.kind === "sky-wars" ||
        hillFistsOnly(preset)
    );
}

/** Played with loot found in the arena, which must never sit beside what a
 *  player brought: only from 1.17, where their own things are put away first. */
/** A race's finish is scored above this, so any finish beats any progress:
 *  `FINISH_BASE` less the seconds it took (`kinds/parkour` `finishScore`). */
export const FINISH_BASE = 100_000;

/** The races scored that way: a finish as its time, short of it as progress. */
const RACES: readonly EventKind[] = ["parkour", "boat-race", "dropper", "nether-maze"];

/** How long a race took, in seconds, when the score is a finish; null for a
 *  score that is progress, or a kind that is not a race. */
export function finishedIn(kind: EventKind, score: number): number | null {
    if (!RACES.includes(kind) || score <= FINISH_BASE / 2) return null;
    return FINISH_BASE - score;
}

export function stashesFirst(preset: EventPreset): boolean {
    return preset.kind === "sky-wars";
}

/** Whether a version is at least another. A snapshot is taken as recent; one
 *  that cannot be read at all as unknown, which is not at least anything. */
export function versionAtLeast(version: string | null, wanted: readonly number[]): boolean {
    if (version === null) return false;
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
    if (!match) return true;
    const have = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < wanted.length; index += 1) {
        const left = have[index] ?? 0;
        const right = wanted[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

/** Why an event cannot be played on a server, in the screen's words
 *  (`events.incompatible.<why>`): what it needs, and from which version. */
export interface Incompatibility {
    readonly why: "arena" | "items" | "loot" | "ores" | "material";
    /** The version it needs, as players write it. */
    readonly needs: string;
}

/** What an option of an event names that only exists from a version on. */
const LOOT_SINCE: Partial<Record<(typeof LOOT_TABLES)[number], readonly number[]>> = {
    bastion: [1, 16],
    "ancient-city": [1, 19]
};
const ORES_SINCE: Partial<Record<(typeof METEOR_ORES)[number], readonly number[]>> = {
    debris: [1, 16]
};
const MATERIAL_SINCE: Partial<Record<GatherMaterial, readonly number[]>> = {
    bamboo: [1, 14]
};

const written = (version: readonly number[]): string => version.join(".");

/**
 * Whether this event, as set up, cannot be played on a server running
 * `version`, and why - or null when it can. A version that could not be read is
 * never a reason: the screen says nothing it does not know, and the start
 * itself still refuses what the game turns out not to have.
 *
 * The rules are the start's own (`events-service` `startEvent`): an arena reads
 * its kit and what players dropped the way 1.16 writes them, SkyWars needs what
 * players carry put away first (1.17), and a loot table, an ore or a material
 * the game does not have yet would leave a chest empty or a round unwinnable.
 */
export function incompatibility(
    preset: EventPreset,
    version: string | null
): Incompatibility | null {
    if (version === null) return null;
    const lacks = (since: readonly number[] | undefined) =>
        since !== undefined && !versionAtLeast(version, since);
    if (stashesFirst(preset) && lacks([1, 17])) return { why: "items", needs: "1.17" };
    const since = needsVersion(preset);
    if (since && lacks(since)) return { why: "arena", needs: written(since) };
    if (playsInArena(preset) && lacks([1, 16])) return { why: "arena", needs: "1.16" };
    const options = preset.options as {
        loot?: (typeof LOOT_TABLES)[number];
        ores?: (typeof METEOR_ORES)[number];
        material?: GatherMaterial | "random";
    };
    if (
        (preset.kind === "supply-drop" || preset.kind === "treasure-hunt") &&
        options.loot &&
        lacks(LOOT_SINCE[options.loot])
    )
        return { why: "loot", needs: written(LOOT_SINCE[options.loot]!) };
    if (preset.kind === "meteor-shower" && options.ores && lacks(ORES_SINCE[options.ores]))
        return { why: "ores", needs: written(ORES_SINCE[options.ores]!) };
    if (
        preset.kind === "gathering" &&
        options.material &&
        options.material !== "random" &&
        lacks(MATERIAL_SINCE[options.material])
    )
        return { why: "material", needs: written(MATERIAL_SINCE[options.material]!) };
    return null;
}

/** The version a kind needs of the game itself, beyond what every event of its
 *  sort does: an acid rain's drops land on the highest block under its roof,
 *  which `spreadplayers` can only be told from 1.17. Null when none. */
export function needsVersion(preset: EventPreset): readonly number[] | null {
    return preset.kind === "acid-rain" ? [1, 17] : null;
}

/** Played in an arena until one player is left: ranked by the order they went
 *  out in, so anybody who took part at all is ranked. */
export function lastStanding(preset: EventPreset): boolean {
    return preset.kind === "hot-potato" || preset.kind === "sky-wars";
}

/**
 * Where an event is played, as the Events screen groups them: on a map built
 * for it in the sky (`sky`), at a place found on the world's own ground
 * (`world`), or wherever the players already are (`anywhere`).
 */
export const HELD_WHERE = ["sky", "world", "anywhere"] as const;
export type HeldWhere = (typeof HELD_WHERE)[number];

export function heldWhere(preset: EventPreset): HeldWhere {
    if (playsOnStage(preset) || playsInArena(preset)) return "sky";
    switch (preset.kind) {
        case "world-boss":
            return (preset.options as EventOptions<"world-boss">).arena ? "sky" : "world";
        case "supply-drop":
        case "king-of-the-hill":
        case "treasure-hunt":
        case "waves":
        case "meteor-shower":
        case "village-defense":
            return "world";
        case "explorer":
            return (preset.options as EventOptions<"explorer">).mode === "race"
                ? "world"
                : "anywhere";
        default:
            return "anywhere";
    }
}

/** A king of the hill played with fists only: by who joins, in an arena of its own. */
export function hillFistsOnly(preset: EventPreset): boolean {
    return (
        preset.kind === "king-of-the-hill" &&
        (preset.options as EventOptions<"king-of-the-hill">).fistsOnly
    );
}

/**
 * Played on something built in the sky that has to be seen: the day is held
 * still while it runs, and no phantom or other hostile reaches it
 * (`commands.DAY_RULES`). Never a blood moon, which is the night.
 */
export function keepsDay(preset: EventPreset): boolean {
    return worldNeeds(preset).time === "day";
}

/** The time of day and the weather an event needs, held for as long as it runs. */
export interface WorldNeeds {
    /** Day: what is built can be seen, nothing spawns on it, nobody plays in
     *  the dark. Night: the mobs it is about come out and do not burn. */
    readonly time: "day" | "night" | null;
    /** Clear: no lightning on an arena or a build, no thunderstorm mid-round.
     *  Rain: a blood moon's own storm. */
    readonly weather: "clear" | "rain" | null;
}

/**
 * What each kind needs of the world, written down once. Held from its start to
 * its end - the clock and the weather cycle stopped, the time and the weather
 * set - and put back after: the rules to what they were, the time of day to
 * what it was. Documented for anybody adding a kind in
 * `docs/minecraft-events.md` ("World requirements").
 */
export const WORLD_NEEDS: Readonly<Record<EventKind, WorldNeeds>> = {
    "mining-rush": { time: null, weather: null },
    "mob-hunt": { time: "night", weather: "clear" },
    "supply-drop": { time: "day", weather: "clear" },
    "blood-moon": { time: "night", weather: "rain" },
    "world-boss": { time: null, weather: "clear" },
    fishing: { time: null, weather: null },
    trivia: { time: null, weather: null },
    explorer: { time: "day", weather: "clear" },
    "happy-hour": { time: null, weather: null },
    "king-of-the-hill": { time: "day", weather: "clear" },
    "treasure-hunt": { time: "day", weather: "clear" },
    gathering: { time: "day", weather: "clear" },
    "rare-catch": { time: null, weather: null },
    "xp-boost": { time: null, weather: null },
    waves: { time: "night", weather: "clear" },
    "meteor-shower": { time: "night", weather: "clear" },
    parkour: { time: "day", weather: "clear" },
    spleef: { time: "day", weather: "clear" },
    "team-duel": { time: "day", weather: "clear" },
    "build-battle": { time: "day", weather: "clear" },
    "tnt-run": { time: "day", weather: "clear" },
    "boat-race": { time: "day", weather: "clear" },
    dropper: { time: "day", weather: "clear" },
    "capture-the-flag": { time: "day", weather: "clear" },
    "hide-and-seek": { time: "day", weather: "clear" },
    "hot-potato": { time: "day", weather: "clear" },
    "sky-wars": { time: "day", weather: "clear" },
    "village-defense": { time: "night", weather: "clear" },
    bingo: { time: null, weather: null },
    "boss-fishing": { time: null, weather: null },
    "nether-maze": { time: "day", weather: "clear" },
    // Its rain is the event's own, over its arena alone: the world's weather
    // is every player's, and is left as it is. Held in the day like every
    // stage, so the arena can be seen.
    "acid-rain": { time: "day", weather: null }
};

export function worldNeeds(preset: Pick<EventPreset, "kind">): WorldNeeds {
    return WORLD_NEEDS[preset.kind];
}

/** The least countdown an event asked to join gets, whatever the settings say:
 *  time to read the line and type the word. */
export const JOIN_SECONDS = 30;

/** How long the warning before an event is, in seconds. */
export function countdownSecondsFor(preset: EventPreset, settings: EventSettings): number {
    return takesJoiners(preset)
        ? Math.max(settings.countdownSeconds, JOIN_SECONDS)
        : settings.countdownSeconds;
}

/** How many must join for it to go ahead: the event's own minimum, and never
 *  fewer than two for what one player cannot play - a spleef, a duel, a build
 *  battle voted on by the others - or for any competition with prizes. */
/** The fewest an event that takes joiners can be played by at all. */
function joinersFloor(preset: EventPreset): number {
    return preset.kind === "build-battle" ? BUILD_BATTLE_FLOOR : 1;
}

export function joinersNeeded(preset: EventPreset): number {
    const floor =
        preset.kind === "spleef" ||
        preset.kind === "tnt-run" ||
        preset.kind === "acid-rain" ||
        playsInArena(preset) ||
        awardsPrizes(preset)
            ? PRIZE_COMPETITION_FLOOR
            : 1;
    return Math.max(
        preset.kind === "build-battle" ? BUILD_BATTLE_FLOOR : floor,
        minPlayersOf(preset)
    );
}

/** The events that bring mobs up near the players, and so hold mob griefing
 *  off while they run (`commands.GRIEF_RULES`). A world boss holds it itself,
 *  only where its fight could change a block (`holdsGriefing`). */
export function summonsMobs(preset: EventPreset): boolean {
    return (
        preset.kind === "blood-moon" || preset.kind === "waves" || preset.kind === "village-defense"
    );
}

/** The events players fight each other in, which a server with PvP off cannot run. */
export function needsPvp(preset: EventPreset): boolean {
    // Pushing is punching: with PvP off, nobody on the hill could move anybody.
    // A flag is defended, a hider found and a potato passed with a blow too.
    return (
        preset.kind === "team-duel" ||
        preset.kind === "capture-the-flag" ||
        preset.kind === "hide-and-seek" ||
        preset.kind === "hot-potato" ||
        preset.kind === "sky-wars" ||
        hillFistsOnly(preset)
    );
}

/** An item id as a player reads it: `minecraft:shulker_box` is "shulker box". */
export function itemName(id: string): string {
    return (id.split(":").pop() ?? id).replace(/_/g, " ");
}
