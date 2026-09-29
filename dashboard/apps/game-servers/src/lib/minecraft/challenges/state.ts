/**
 * What Polaris remembers about a server's challenges.
 *
 * Three stores, each sized for what it holds:
 * - the server's own state (the day's, week's and month's draws, the objectives
 *   they were given, community goals, pace) in the install's config under
 *   `challengeState`, written only by Polaris so a save from the screen never
 *   puts an old draw back;
 * - one row per player and server (`MinecraftChallengePlayer`): the challenges
 *   they were dealt and how far each has got;
 * - one row per player and season (`MinecraftChallengeLedger`): points, tier,
 *   streak - keyed by the server, or by a linked Polaris account when servers
 *   share a season.
 *
 * Every schema reads an older or damaged value as far as it can rather than
 * failing: one bad entry must not lose everybody's progress.
 */

import { z } from "zod";
import { rewardSchema } from "../events/catalog";
import { DIFFICULTIES, LAYERS } from "./catalog";

export const STATE_KEY = "challengeState";

/** A list where an unreadable entry is dropped on its own. */
function eachOf<T extends z.ZodTypeAny>(entry: T) {
    return z
        .array(z.unknown())
        .catch([])
        .transform((entries) =>
            entries.flatMap((one) => {
                const parsed = entry.safeParse(one);
                return parsed.success ? [parsed.data as z.output<T>] : [];
            })
        );
}

const numbers = z.record(z.string(), z.number()).catch({});

// ------------------------------------------------------------------ the server

/** One challenge in a period's pool. */
export const poolEntrySchema = z.object({
    template: z.string(),
    variant: z.string().nullable().default(null),
    tier: z.enum(DIFFICULTIES),
    target: z.number()
});
export type PoolEntry = z.infer<typeof poolEntrySchema>;

/** A period of one layer: what was drawn and the objectives counting it. */
export const periodSchema = z.object({
    key: z.string(),
    startedAt: z.number(),
    endsAt: z.number(),
    pool: eachOf(poolEntrySchema),
    /** Every statistic counted, by the objective it is counted in. */
    objectives: z.record(z.string(), z.string()).catch({}),
    /** Statistics this server does not have: its objective was refused. */
    refused: z.array(z.string()).catch([]),
    /** Whether the objectives were made on the server for this period. */
    applied: z.boolean().catch(false)
});
export type Period = z.infer<typeof periodSchema>;

/** A community goal as it runs: its own settings copied, and where it stands. */
export const goalStateSchema = z.object({
    id: z.string(),
    template: z.string(),
    variant: z.string().nullable().default(null),
    target: z.number(),
    startedAt: z.number(),
    endsAt: z.number(),
    minShare: z.number().default(2),
    rewards: eachOf(rewardSchema.extend({ points: z.number().int().default(0) })),
    /** Drawn by Polaris, rather than set up by the operator. */
    auto: z.boolean().default(false),
    /** Everybody's credited share, by lowercased name. */
    shares: z.record(z.string(), z.object({ name: z.string(), value: z.number() })).catch({}),
    /** The tiers reached so far, 0 to 5. */
    tier: z.number().int().default(0),
    /** Who has been paid for which tier. */
    paid: z.record(z.string(), z.number().int()).catch({}),
    finished: z.boolean().default(false)
});
export type GoalState = z.infer<typeof goalStateSchema>;

/** How a template did in one period, for pace and for the screen. */
const outcomeSchema = z.object({
    layer: z.enum(LAYERS),
    key: z.string(),
    template: z.string(),
    tier: z.enum(DIFFICULTIES),
    dealt: z.number().int(),
    done: z.number().int()
});
export type Outcome = z.infer<typeof outcomeSchema>;

export const serverStateSchema = z.object({
    /** When challenges were first switched on here: the first season's start. */
    since: z.number().nullable().catch(null),
    /** The version the server said it runs, as last read. */
    version: z.string().nullable().catch(null),
    daily: periodSchema.nullable().catch(null),
    weekly: periodSchema.nullable().catch(null),
    card: periodSchema.nullable().catch(null),
    community: periodSchema.nullable().catch(null),
    /** Templates drawn in recent periods, newest first, to keep them fresh. */
    recent: z
        .object({
            daily: z.array(z.array(z.string())).catch([]),
            weekly: z.array(z.array(z.string())).catch([]),
            card: z.array(z.array(z.string())).catch([])
        })
        .catch({ daily: [], weekly: [], card: [] }),
    /** How each template's targets have drifted with how many finish them. */
    pace: numbers,
    goals: eachOf(goalStateSchema),
    /** The last periods' results, newest first. */
    outcomes: eachOf(outcomeSchema),
    /** The season running when last looked, to tell when one ends. */
    season: z.string().nullable().catch(null),
    /** Seasons that ended, and who topped each. */
    seasons: eachOf(
        z.object({ key: z.string(), endedAt: z.number(), champions: z.array(z.string()) })
    ),
    /** Why challenges are not running, for the screen. */
    problem: z.string().nullable().catch(null)
});
export type ServerState = z.infer<typeof serverStateSchema>;

export const EMPTY_SERVER_STATE: ServerState = serverStateSchema.parse({});

export function readServerState(config: Record<string, unknown>): ServerState {
    const parsed = serverStateSchema.safeParse(config[STATE_KEY] ?? {});
    return parsed.success ? parsed.data : EMPTY_SERVER_STATE;
}

/** How many past period results are kept. */
export const OUTCOMES_KEPT = 200;

// ------------------------------------------------------------------ a player

/** One challenge dealt to one player, and how far it has got. */
export const instanceSchema = z.object({
    template: z.string(),
    variant: z.string().nullable().default(null),
    tier: z.enum(DIFFICULTIES),
    target: z.number(),
    /** Each statistic when it was dealt: it counts from there. */
    base: numbers,
    /** Each statistic at the last read, to tell what rose since. */
    last: numbers,
    /** The measure at the last read, before anything was held back. */
    raw: z.number().default(0),
    /** What was held back: risen while standing still, past a ceiling. */
    offset: z.number().default(0),
    /** What was carried over from an earlier day, for a backlog challenge. */
    carry: z.number().default(0),
    progress: z.number().default(0),
    dealtAt: z.number(),
    readAt: z.number().nullable().default(null),
    doneAt: z.number().nullable().default(null),
    /** Its reward was handed out (or owed): never paid twice. */
    paid: z.boolean().default(false),
    /** Lost to an Anti X-Ray catch. */
    voided: z.boolean().default(false),
    /** Advancements or criteria already earned when it was dealt. */
    had: z.array(z.string()).nullable().default(null),
    /** What Polaris measures itself: villages rung, where they were last. */
    cells: z.array(z.string()).default([]),
    at: z.object({ x: z.number(), z: z.number(), dimension: z.string() }).nullable().default(null),
    /** The day a backlog challenge was first dealt. */
    day: z.string().nullable().default(null)
});
export type Instance = z.infer<typeof instanceSchema>;

export const playerLayerSchema = z.object({
    key: z.string(),
    instances: eachOf(instanceSchema),
    rerolls: z.number().int().default(0),
    /** The bonus for finishing them all was paid. */
    swept: z.boolean().default(false),
    /** Bingo lines paid, by index, and the whole card. */
    lines: z.array(z.number().int()).default([]),
    full: z.boolean().default(false)
});
export type PlayerLayer = z.infer<typeof playerLayerSchema>;

export const playerSchema = z.object({
    name: z.string(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
    /** Minutes Polaris has seen them on this server. */
    minutes: z.number().default(0),
    daily: playerLayerSchema.nullable().catch(null),
    weekly: playerLayerSchema.nullable().catch(null),
    card: playerLayerSchema.nullable().catch(null),
    /** Unfinished dailies kept for a few days. */
    backlog: eachOf(instanceSchema),
    /** Their part of each community goal, by goal id. */
    community: z.record(z.string(), instanceSchema).catch({}),
    /** The challenge on their boss bar: `daily:1`, `card:4`. */
    tracked: z.string().nullable().catch(null),
    /** When they were last told of progress on the action bar. */
    toldAt: z.number().default(0),
    /** Newcomers they greeted, so each counts once. */
    greeted: z.array(z.string()).catch([])
});
export type PlayerRecord = z.infer<typeof playerSchema>;

export function newPlayer(name: string, now: number): PlayerRecord {
    return playerSchema.parse({ name, firstSeenAt: now, lastSeenAt: now });
}

export function readPlayer(data: string, name: string, now: number): PlayerRecord {
    try {
        const parsed = playerSchema.safeParse(JSON.parse(data));
        if (parsed.success) return parsed.data;
    } catch {
        // A row that does not read starts over rather than failing the sweep.
    }
    return newPlayer(name, now);
}

// ------------------------------------------------------------------ the season

export const ledgerSchema = z.object({
    season: z.string(),
    points: z.number().default(0),
    /** Tiers already paid. */
    paid: z.number().int().default(0),
    /** Points earned on `day`, for the daily cap. */
    day: z.string().nullable().default(null),
    dayPoints: z.number().default(0),
    streak: z
        .object({
            count: z.number().int().default(0),
            best: z.number().int().default(0),
            lastDay: z.string().nullable().default(null),
            /** The week whose freeze was used. */
            freezeWeek: z.string().nullable().default(null)
        })
        .default({}),
    /** When their last challenge was done, for the comeback bonus. */
    lastDoneAt: z.number().nullable().default(null),
    /** Challenges already done in this period on any server of a shared season. */
    done: z.array(z.string()).default([]),
    titles: z.array(z.string()).default([]),
    /** This season's champion title was given. */
    crowned: z.boolean().default(false)
});
export type Ledger = z.infer<typeof ledgerSchema>;

export function readLedger(data: string | null, season: string): Ledger {
    if (data) {
        try {
            const parsed = ledgerSchema.safeParse(JSON.parse(data));
            if (parsed.success) {
                // A new season starts from nothing, but the streak and the
                // titles are the player's, not the season's.
                if (parsed.data.season === season) return parsed.data;
                return ledgerSchema.parse({
                    season,
                    streak: parsed.data.streak,
                    lastDoneAt: parsed.data.lastDoneAt,
                    titles: parsed.data.titles
                });
            }
        } catch {
            // Starts over, below.
        }
    }
    return ledgerSchema.parse({ season });
}
