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
 *  command in place of a selector. */
export const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** A namespaced item id, `minecraft:diamond` or a mod's own. */
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

export const rewardItemSchema = z.object({
    id: z
        .string()
        .trim()
        .toLowerCase()
        .regex(ITEM_ID, "Write the item as namespace:id, like minecraft:diamond"),
    count: z.number().int().min(1, "At least one").max(256, "At most 256")
});

export const rewardSchema = z.object({
    items: z.array(rewardItemSchema).max(6, "At most six items per reward"),
    levels: z.number().int().min(0).max(100, "At most 100 levels")
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
export const RARE_CATCHES = ["name_tag", "saddle", "nautilus_shell", "enchanted_book", "bow"] as const;
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
            message: "Choose at least one effect"
        }),
    "king-of-the-hill": z.object({
        place: placeSchema.default({ mode: "players" }),
        radius: z.number().int().min(3).max(20).default(6)
    }),
    "treasure-hunt": z.object({
        chests: z.number().int().min(1, "At least one").max(10, "At most 10").default(5),
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
            perKill: z.number().int().min(0).max(100, "At most 100").default(5),
            /** And per ore block mined. */
            perOre: z.number().int().min(0).max(100, "At most 100").default(3)
        })
        .refine((value) => value.perKill > 0 || value.perOre > 0, {
            message: "Give something for kills, ores or both"
        }),
    waves: z.object({
        place: placeSchema.default({ mode: "players" }),
        waves: z.number().int().min(3, "At least 3 waves").max(10, "At most 10 waves").default(5),
        /** Monsters in the first wave for one defender; later waves and more
         *  defenders bring more. */
        size: z.number().int().min(2, "At least 2").max(12, "At most 12").default(4),
        mix: z.enum(WAVE_MIXES).default("classic")
    }),
    "meteor-shower": z.object({
        place: placeSchema.default({ mode: "players" }),
        distance: z.number().int().min(50, "At least 50").max(1000, "At most 1000").default(150),
        meteors: z.number().int().min(2, "At least 2").max(8, "At most 8").default(4),
        /** Ore blocks in each meteor. */
        size: z.number().int().min(3, "At least 3").max(12, "At most 12").default(6),
        ores: z.enum(METEOR_ORES).default("precious")
    }),
    parkour: z.object({
        place: placeSchema.default({ mode: "players" }),
        jumps: z.number().int().min(10, "At least 10").max(40, "At most 40").default(20),
        difficulty: z.enum(PARKOUR_DIFFICULTIES).default("medium"),
        /** How far above the ground it is built. */
        height: z.number().int().min(25, "At least 25").max(40, "At most 40").default(30)
    }),
    spleef: z.object({
        place: placeSchema.default({ mode: "players" }),
        /** Blocks from the middle of the floor to its edge. */
        size: z.number().int().min(5, "At least 5").max(15, "At most 15").default(8),
        height: z.number().int().min(25, "At least 25").max(40, "At most 40").default(30)
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
                        .min(2, "At least two characters")
                        .max(40, "At most 40 characters")
                        .regex(/^[^{}&]+$/, "No braces or & in a theme")
                )
                .max(50, "At most 50 themes")
                .default([])
        })
        .refine((value) => value.themeMode === "random" || value.themes.length > 0, {
            message: "Write at least one theme",
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
    name: z.string().trim().min(1, "Give it a name").max(40, "At most 40 characters"),
    enabled: z.boolean().default(true),
    minutes: z.number().int().min(DURATION.min).max(DURATION.max).default(10),
    /** The least a player must score to be ranked at all, and to get the prize
     *  for taking part. Absent on an event saved before it existed, which then
     *  reads its kind's default (`minScoreOf`). */
    minScore: z.number().int().min(1, "At least 1").max(1_000_000).optional(),
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
    at: z.string().regex(TIME, "Write the time as HH:MM")
});

export type EventScheduleEntry = z.infer<typeof scheduleEntrySchema>;

export const randomSchema = z
    .object({
        enabled: z.boolean().default(false),
        days: daysSchema.default([]),
        from: z.string().regex(TIME, "Write the time as HH:MM").default("18:00"),
        to: z.string().regex(TIME, "Write the time as HH:MM").default("23:00"),
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
        message: "The longest wait cannot be shorter than the shortest",
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
        presets: z.array(presetSchema).max(40, "At most 40 events"),
        schedules: z.array(scheduleEntrySchema).max(40, "At most 40 scheduled events").default([])
    })
    .superRefine((value, context) => {
        const ids = new Set(value.presets.map((preset) => preset.id));
        value.schedules.forEach((entry, index) => {
            if (!ids.has(entry.presetId)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["schedules", index, "presetId"],
                    message: "That event no longer exists"
                });
            }
        });
        value.settings.random.pool.forEach((entry, index) => {
            if (!ids.has(entry.presetId)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["settings", "random", "pool", index, "presetId"],
                    message: "That event no longer exists"
                });
            }
        });
    });

export type EventsConfig = z.infer<typeof eventsConfigSchema>;

/** What an event of each kind is, for the screen. */
export interface KindInfo {
    readonly label: string;
    readonly summary: string;
    /** What decides who wins, in the words the podium uses. */
    readonly unit: string;
    /** Whether it ends with a podium at all. */
    readonly competitive: boolean;
}

export const KIND_INFO: Readonly<Record<EventKind, KindInfo>> = {
    "mining-rush": {
        label: "Mining rush",
        summary:
            "Most ore mined in the time wins. Any ore scores by its rarity, or pick diamonds or ancient debris only. Players caught by Anti X-Ray or the anti-cheat during it are left off the podium.",
        unit: "points",
        competitive: true
    },
    "mob-hunt": {
        label: "Mob hunt",
        summary:
            "Most hostile mobs killed wins, the rare and dangerous ones worth more, or a single kind of mob.",
        unit: "points",
        competitive: true
    },
    "supply-drop": {
        label: "Supply drop",
        summary:
            "A chest of loot lands somewhere in the Overworld. Where is revealed in three steps, a beam of light marks it, and the first player to open it keeps what is inside.",
        unit: "",
        competitive: true
    },
    "blood-moon": {
        label: "Blood moon",
        summary:
            "Night falls with a thunderstorm and waves of mobs rise around every player on the surface. Survive to dawn without dying; the podium goes to the most kills.",
        unit: "kills",
        competitive: true
    },
    "world-boss": {
        label: "World boss",
        summary:
            "A boss with a health bar everybody sees appears near the players. Damage dealt close to it is counted; if it falls, the podium goes by damage and everybody who hit it is rewarded.",
        unit: "damage",
        competitive: true
    },
    fishing: {
        label: "Fishing contest",
        summary: "Most catches with a fishing rod wins.",
        unit: "catches",
        competitive: true
    },
    trivia: {
        label: "Trivia",
        summary:
            "Questions about Minecraft, or a scrambled word, in the chat. The first right answer takes the round. Add questions of your own.",
        unit: "rounds",
        competitive: true
    },
    explorer: {
        label: "Explorer",
        summary:
            "Travel the farthest on foot, swimming, riding or gliding - or race to a set of coordinates announced at the start.",
        unit: "metres",
        competitive: true
    },
    "happy-hour": {
        label: "Happy hour",
        summary:
            "Haste, luck and other effects for everybody for a while. No winner - a good filler between competitions.",
        unit: "",
        competitive: false
    },
    "king-of-the-hill": {
        label: "King of the hill",
        summary:
            "A marked circle appears. The longest time spent inside it wins - so it is worth defending.",
        unit: "seconds",
        competitive: true
    },
    "treasure-hunt": {
        label: "Treasure hunt",
        summary:
            "Loot chests are hidden on open ground around the players, told in clues that get sharper as it goes. Whoever opens the most wins, and keeps what is inside.",
        unit: "chests",
        competitive: true
    },
    gathering: {
        label: "Gathering",
        summary:
            "One material is announced - wheat, logs, cobblestone, iron... Whoever gathers the most of it wins. Nothing is taken from anybody.",
        unit: "items",
        competitive: true
    },
    "rare-catch": {
        label: "Rare catch",
        summary:
            "A fishing race for one treasure - a name tag, a saddle, an enchanted book... The first to fish it up wins, and keeps it.",
        unit: "",
        competitive: true
    },
    "xp-boost": {
        label: "Experience boost",
        summary:
            "Extra experience for every mob killed and every ore mined, for everybody, for a while. No winner - a good filler between competitions.",
        unit: "",
        competitive: false
    },
    waves: {
        label: "Horde defence",
        summary:
            "A defence point is marked away from every home and waves of monsters come for it, each bigger and stronger than the last. Everybody who holds the point is rewarded; the podium goes to the most kills.",
        unit: "kills",
        competitive: true
    },
    "meteor-shower": {
        label: "Meteor shower",
        summary:
            "Meteors of ore fall one after another on open ground away from every home, each marked by a beam of light. Whoever mines the most meteor blocks wins.",
        unit: "blocks",
        competitive: true
    },
    parkour: {
        label: "Parkour race",
        summary:
            "A jump course is built high in the air. Players type join in the chat to take part and are taken to the start; the fastest to the finish wins, and a fall only sends you back to your last checkpoint.",
        unit: "jumps",
        competitive: true
    },
    spleef: {
        label: "Spleef",
        summary:
            "The floor is lava: a snow floor is built high in the air and players who type join get a shovel that only breaks that snow. Dig it out from under the others - whoever falls through is out and sent back - and the last one standing wins.",
        unit: "points",
        competitive: true
    },
    "team-duel": {
        label: "Team duel",
        summary:
            "Players who type join are split into two teams in an arena built in the sky, each given the same sword and shield. The team with more eliminations wins; the podium goes by each player's own. Nobody loses anything: a player low on health is sent back to their side, and inventories are kept whatever happens.",
        unit: "eliminations",
        competitive: true
    },
    "build-battle": {
        label: "Build battle",
        summary:
            "Players who type join each get a plot in the sky, a theme and a kit of coloured glass. When the time is up everybody tours the plots and votes for the best in the chat. Only the kit can be built with; nothing of anybody's is used or taken.",
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
export function newPreset(kind: EventKind, id: string): EventPreset {
    const options = optionsSchemas[kind].parse({}) as EventOptions<EventKind>;
    return {
        id,
        kind,
        name: KIND_INFO[kind].label,
        enabled: true,
        minutes:
            kind === "happy-hour" || kind === "xp-boost" || kind === "rare-catch"
                ? 20
                : kind === "trivia"
                  ? 5
                  : 10,
        minScore: DEFAULT_MIN_SCORE[kind],
        options,
        rewards: KIND_INFO[kind].competitive
            ? DEFAULT_REWARDS
            : { first: NO_REWARD, second: NO_REWARD, third: NO_REWARD, everyone: NO_REWARD }
    };
}

/** Every kind once, which is what a server that never opened this screen has. */
export function defaultEventsConfig(): EventsConfig {
    return {
        settings: settingsSchema.parse({}),
        presets: EVENT_KINDS.map((kind) => newPreset(kind, `default-${kind}`)),
        schedules: []
    };
}

/**
 * The stored settings, whole.
 *
 * A preset that no longer reads - a kind this version dropped, a field written
 * by hand - is left out rather than failing the whole list, and a server that has
 * none gets one of each kind so the screen opens on something to run.
 */
export function readEventsConfig(config: Record<string, unknown>, timezone = "UTC"): EventsConfig {
    const raw = config[EVENTS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        const fresh = defaultEventsConfig();
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
    return awardsPrizes(preset)
        ? Math.max(settings.minActive, PRIZE_COMPETITION_FLOOR)
        : settings.minActive;
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

/** The least countdown an event asked to join gets, whatever the settings say:
 *  time to read the line and type the word. */
export const JOIN_SECONDS = 30;

/** How long the warning before an event is, in seconds. */
export function countdownSecondsFor(preset: EventPreset, settings: EventSettings): number {
    return takesJoiners(preset)
        ? Math.max(settings.countdownSeconds, JOIN_SECONDS)
        : settings.countdownSeconds;
}

/** How many must join for it to go ahead: two for what one player cannot play -
 *  a spleef, a duel, a build battle voted on by the others - and for any
 *  competition with prizes. */
export function joinersNeeded(preset: EventPreset): number {
    return preset.kind === "spleef" || playsInArena(preset) || awardsPrizes(preset)
        ? PRIZE_COMPETITION_FLOOR
        : 1;
}

/** The events players fight each other in, which a server with PvP off cannot run. */
export function needsPvp(preset: EventPreset): boolean {
    return preset.kind === "team-duel";
}
