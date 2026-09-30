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
import type { GameKey } from "../../../../messages";
import { gameMessage } from "../../game-message";

/** A schema's complaint, carried as its catalog key until a reader's language is
 *  known (`lib/game-message`): the screen and the actions write it out. */
type ProblemKey = GameKey<"minecraft"> extends infer K
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
    "build-battle"
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
    id: z
        .string()
        .trim()
        .toLowerCase()
        .regex(ITEM_ID, problem("itemId")),
    count: z
        .number()
        .int()
        .min(1, problem("atLeast", { count: 1 }))
        .max(256, problem("atMost", { count: 256 }))
});

export const rewardSchema = z.object({
    items: z.array(rewardItemSchema).max(6, problem("itemsPerReward", { count: 6 })),
    levels: z.number().int().min(0).max(100, problem("levelsAtMost", { count: 100 }))
});

export type Reward = z.infer<typeof rewardSchema>;
export type RewardItem = z.infer<typeof rewardItemSchema>;

export const rewardsSchema = z.object({
    first: rewardSchema,
    second: rewardSchema,
    third: rewardSchema,
    /** For everybody who took part - scored at all, and on a blood moon survived the night. */
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
export const LOOT_TABLES = ["treasure", "dungeon", "bastion", "end-city", "ancient-city"] as const;
export const BOSS_KINDS = ["wither-skeleton", "ravager", "vindicator", "husk"] as const;
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
/** Which monsters a horde defence sends: only ones that cannot break a block. */
export const WAVE_MIXES = ["classic", "undead", "mixed"] as const;
/** What a meteor is made of. */
export const METEOR_ORES = ["common", "precious", "diamond", "debris"] as const;
export const PARKOUR_DIFFICULTIES = ["easy", "medium", "hard"] as const;
/** The sword a team duel hands everybody, alike for all. */
export const DUEL_KITS = ["wood", "stone", "iron"] as const;
/** Where a build battle's theme comes from: the built-in list or the operator's. */
export const THEME_MODES = ["random", "mine"] as const;

export type Language = (typeof LANGUAGES)[number];

const triviaQuestionSchema = z.object({
    question: z.string().trim().min(3).max(200),
    answers: z.array(z.string().trim().min(1).max(60)).min(1).max(6)
});

export type TriviaQuestion = z.infer<typeof triviaQuestionSchema>;

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
    "world-boss": z.object({
        boss: z.enum(BOSS_KINDS).default("wither-skeleton"),
        health: z.number().int().min(100).max(1024).default(400),
        place: placeSchema.default({ mode: "players" })
    }),
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
        radius: z.number().int().min(3).max(20).default(6)
    }),
    "treasure-hunt": z.object({
        chests: z
            .number()
            .int()
            .min(1, problem("atLeast", { count: 1 }))
            .max(10, problem("atMost", { count: 10 }))
            .default(5),
        /** How far from the players the chests are hidden, at most. */
        distance: z.number().int().min(50).max(1000).default(300),
        loot: z.enum(LOOT_TABLES).default("dungeon")
    }),
    gathering: z.object({
        /** Drawn when the event is set off, from the list, when `random`. */
        material: z.enum([...GATHER_MATERIALS, "random"]).default("random")
    }),
    "rare-catch": z.object({
        treasure: z.enum([...RARE_CATCHES, "any"]).default("any")
    }),
    "xp-boost": z
        .object({
            /** Experience points on top of the game's own, per mob killed. */
            perKill: z.number().int().min(0).max(100, problem("atMost", { count: 100 })).default(5),
            /** And per ore block mined. */
            perOre: z.number().int().min(0).max(100, problem("atMost", { count: 100 })).default(3)
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
        mix: z.enum(WAVE_MIXES).default("classic")
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
            .max(8, problem("atMost", { count: 8 }))
            .default(4),
        /** Ore blocks in each meteor. */
        size: z
            .number()
            .int()
            .min(3, problem("atLeast", { count: 3 }))
            .max(12, problem("atMost", { count: 12 }))
            .default(6),
        ores: z.enum(METEOR_ORES).default("precious")
    }),
    parkour: z.object({
        place: placeSchema.default({ mode: "players" }),
        jumps: z
            .number()
            .int()
            .min(10, problem("atLeast", { count: 10 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(20),
        difficulty: z.enum(PARKOUR_DIFFICULTIES).default("medium"),
        /** How far above the ground it is built. */
        height: z
            .number()
            .int()
            .min(25, problem("atLeast", { count: 25 }))
            .max(40, problem("atMost", { count: 40 }))
            .default(30)
    }),
    spleef: z.object({
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
            .default(30)
    }),
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
    minScore: z.number().int().min(1, problem("atLeast", { count: 1 })).max(1_000_000).optional(),
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
        })
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

export const randomSchema = z
    .object({
        enabled: z.boolean().default(false),
        days: daysSchema.default([]),
        from: z.string().regex(TIME, problem("timeFormat")).default("18:00"),
        to: z.string().regex(TIME, problem("timeFormat")).default("23:00"),
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
            .max(50)
            .default([])
    })
    .refine((value) => value.maxGap >= value.minGap, {
        message: problem("gapOrder"),
        path: ["maxGap"]
    });

export type RandomEvents = z.infer<typeof randomSchema>;

export const settingsSchema = z.object({
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
        presets: z.array(presetSchema).max(40, problem("eventsAtMost", { count: 40 })),
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
    "king-of-the-hill": { en: "King of the hill", es: "Rey de la colina" },
    "treasure-hunt": { en: "Treasure hunt", es: "Búsqueda del tesoro" },
    gathering: { en: "Gathering", es: "Recolección" },
    "rare-catch": { en: "Rare catch", es: "Pesca rara" },
    "xp-boost": { en: "Experience boost", es: "Experiencia extra" },
    waves: { en: "Horde defence", es: "Oleadas" },
    "meteor-shower": { en: "Meteor shower", es: "Lluvia de meteoritos" },
    parkour: { en: "Parkour race", es: "Carrera de parkour" },
    spleef: { en: "Spleef", es: "El suelo es lava" },
    "team-duel": { en: "Team duel", es: "Duelo por equipos" },
    "build-battle": { en: "Build battle", es: "Construcción rápida" }
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
        unit: "metres",
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
        unit: "items",
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
    }
};

/** Rewards a new event starts with: something worth playing for, easy to change. */
export const DEFAULT_REWARDS: Rewards = {
    first: { items: [{ id: "minecraft:diamond", count: 5 }], levels: 15 },
    second: { items: [{ id: "minecraft:diamond", count: 3 }], levels: 10 },
    third: { items: [{ id: "minecraft:diamond", count: 1 }], levels: 5 },
    everyone: { items: [{ id: "minecraft:experience_bottle", count: 8 }], levels: 0 }
};

/** A new event of one kind, as the screen adds it. */
export function newPreset(kind: EventKind, id: string, name = KIND_NAMES[kind].en): EventPreset {
    const options = optionsSchemas[kind].parse({}) as EventOptions<EventKind>;
    return {
        id,
        kind,
        name,
        enabled: true,
        minutes:
            kind === "happy-hour" || kind === "xp-boost" || kind === "rare-catch"
                ? 20
                : kind === "trivia"
                  ? 5
                  : 10,
        minScore: DEFAULT_MIN_SCORE[kind],
        minPlayers: defaultMinPlayers(kind),
        options,
        rewards: KIND_INFO[kind].competitive
            ? DEFAULT_REWARDS
            : { first: NO_REWARD, second: NO_REWARD, third: NO_REWARD, everyone: NO_REWARD }
    };
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
 * The stored settings, whole.
 *
 * A preset that no longer reads - a kind this version dropped, a field written
 * by hand - is left out rather than failing the whole list, and a server that has
 * none gets one of each kind, named in `language`, so the screen opens on something
 * to run.
 */
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
    const presets = (Array.isArray(value.presets) ? value.presets : []).flatMap((entry) => {
        const parsed = presetSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
    const ids = new Set(presets.map((preset) => preset.id));
    const schedules = (Array.isArray(value.schedules) ? value.schedules : []).flatMap((entry) => {
        const parsed = scheduleEntrySchema.safeParse(entry);
        return parsed.success && ids.has(parsed.data.presetId) ? [parsed.data] : [];
    });
    const settings = settingsSchema.safeParse(value.settings);
    const read = settings.success ? settings.data : settingsSchema.parse({ timezone });
    return {
        settings: {
            ...read,
            random: {
                ...read.random,
                pool: read.random.pool.filter((entry) => ids.has(entry.presetId))
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
    const floor = Math.max(settings.minActive, minPlayersOf(preset));
    return awardsPrizes(preset) ? Math.max(floor, PRIZE_COMPETITION_FLOOR) : floor;
}

/** The fewest players an event goes ahead with (`minPlayers`): two for a
 *  competition, one for the rest, unless the operator chose otherwise. */
export function minPlayersOf(preset: EventPreset): number {
    return preset.minPlayers ?? defaultMinPlayers(preset.kind);
}

export function defaultMinPlayers(kind: EventKind): number {
    return KIND_INFO[kind].competitive ? 2 : 1;
}

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
    "build-battle": 1
};

/** Whether the minimum is something an operator can set for this event. A
 *  supply drop, a rare catch and a race have one winner and nothing to count. */
export function hasMinScore(preset: EventPreset): boolean {
    if (!KIND_INFO[preset.kind].competitive) return false;
    if (preset.kind === "supply-drop" || preset.kind === "rare-catch") return false;
    // Ranked by the finish and by who is left standing: anybody who took part at all is.
    if (playsOnStage(preset)) return false;
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
        preset.kind === "waves"
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
    readonly meteors: readonly unknown[];
    readonly round: number;
    readonly stage: { readonly racers: readonly unknown[] } | null;
    readonly readyAt: number | null;
}): boolean {
    const { preset } = run;
    switch (preset.kind) {
        case "supply-drop":
        case "world-boss":
        case "king-of-the-hill":
        case "waves":
            return run.place !== null;
        case "explorer":
            return (preset.options as EventOptions<"explorer">).mode !== "race" || run.place !== null;
        case "treasure-hunt":
            return run.hidden;
        case "meteor-shower":
            return run.meteors.length > 0;
        case "trivia":
            return run.round >= 0;
        case "parkour":
        case "spleef":
            return (run.stage?.racers.length ?? 0) > 0;
        case "team-duel":
        case "build-battle":
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
    if (preset.kind === "waves") {
        // Time to reach the point, every wave fought to its limit with the
        // breath after it, and a minute to find the place.
        const options = preset.options as EventOptions<"waves">;
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
    return preset.minutes;
}

/** A horde defence's clock: how long before the first wave, how long a wave
 *  may last before it is called over, and the breath between two. */
export const WAVE_TIMING = { firstSeconds: 45, limitSeconds: 120, pauseSeconds: 20 } as const;

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
 *  course, a spleef floor (`kinds/stage-service.ts`). */
export function playsOnStage(preset: EventPreset): boolean {
    return preset.kind === "parkour" || preset.kind === "spleef";
}

/** Played in an arena built in the sky, by sides - two teams, a plot each - with
 *  a marked kit (`kinds/arena-service.ts`). */
export function playsInArena(preset: EventPreset): boolean {
    return preset.kind === "team-duel" || preset.kind === "build-battle";
}

/**
 * Played on something built in the sky that has to be seen: the day is held
 * still while it runs, and no phantom or other hostile reaches it
 * (`commands.DAY_RULES`). Never a blood moon, which is the night.
 */
export function keepsDay(preset: EventPreset): boolean {
    return playsInArena(preset) || playsOnStage(preset);
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
export function joinersNeeded(preset: EventPreset): number {
    const floor =
        preset.kind === "spleef" || playsInArena(preset) || awardsPrizes(preset)
            ? PRIZE_COMPETITION_FLOOR
            : 1;
    return Math.max(floor, minPlayersOf(preset));
}

/** The events players fight each other in, which a server with PvP off cannot run. */
export function needsPvp(preset: EventPreset): boolean {
    return preset.kind === "team-duel";
}
