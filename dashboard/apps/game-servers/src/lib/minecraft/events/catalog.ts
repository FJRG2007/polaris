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
    "king-of-the-hill"
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
    /** For everybody who took part - scored at all, or survived the night. */
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
    readonly options: EventOptions<K>;
    readonly rewards: Rewards;
}

export const DURATION = { min: 3, max: 60 } as const;

const presetBase = z.object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1, "Give it a name").max(40, "At most 40 characters"),
    enabled: z.boolean().default(true),
    minutes: z.number().int().min(DURATION.min).max(DURATION.max).default(10),
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
        minutes: kind === "happy-hour" ? 20 : kind === "trivia" ? 5 : 10,
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
    return [first, second, third, everyone].some((reward) => reward.items.length > 0 || reward.levels > 0);
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
    return awardsPrizes(preset) ? Math.max(settings.minActive, PRIZE_COMPETITION_FLOOR) : settings.minActive;
}

export function runMinutes(preset: EventPreset): number {
    if (preset.kind === "trivia") {
        const options = preset.options as EventOptions<"trivia">;
        return Math.ceil((options.rounds * (options.seconds + ROUND_PAUSE_SECONDS)) / 60);
    }
    return preset.minutes;
}

/** The breath between one trivia round and the next. */
export const ROUND_PAUSE_SECONDS = 6;
