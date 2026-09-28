/**
 * What Polaris remembers about a server's events: the one running now, what the
 * last ones came to, the prizes still owed, and when the next automatic one is.
 *
 * Kept apart from the settings (`EVENTS_KEY`) because the screen writes those and
 * only Polaris writes this - a save from a screen opened an hour ago must never
 * put back a finished event, or forget a prize somebody is still owed.
 */

import { z } from "zod";
import {
    EVENT_KINDS,
    EVENT_STATE_KEY,
    presetSchema,
    rewardSchema,
    type EventPreset
} from "./catalog";

export const TRIGGERS = ["manual", "scheduled", "random"] as const;
export type EventTrigger = (typeof TRIGGERS)[number];

const pointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof pointSchema>;

export const runSchema = z.object({
    id: z.string(),
    trigger: z.enum(TRIGGERS),
    /** Who pressed Run, for a manual one. */
    startedBy: z.string().nullable(),
    /** A copy, so editing the event while it runs changes the next one, not this. */
    preset: presetSchema,
    phase: z.enum(["countdown", "running"]),
    createdAt: z.number(),
    startsAt: z.number(),
    endsAt: z.number(),
    /** Everybody seen on the server while it ran, as the game spells them. */
    participants: z.array(z.string()).default([]),
    /** The chest, the boss's lair, the circle or the finish line, once placed. */
    place: pointSchema.nullable().default(null),
    /** The column being tried for a place, its chunk kept loaded until released. */
    target: z.object({ x: z.number(), z: z.number() }).nullable().default(null),
    /** How many times a place was looked for and not found. */
    placeTries: z.number().int().default(0),
    /** How much of a supply drop's position has been told. */
    reveals: z.number().int().default(0),
    /** Trivia: the round being played, from 0. */
    round: z.number().int().default(-1),
    roundEndsAt: z.number().nullable().default(null),
    /** Trivia: the points so far, by name. The scoreboard shows them too, but it
     *  is this that is read at the end. */
    points: z.record(z.number()).default({}),
    /** Who opened the chest, reached the finish or landed the last blow. */
    decidedBy: z.string().nullable().default(null),
    /** Blood moon: when the last wave rose. */
    lastWaveAt: z.number().default(0),
    /** Trivia: when the last round closed, for the breath before the next. */
    closedAt: z.number().default(0),
    /** Somebody pressed Cancel; the loop ends it on its next tick. */
    cancelled: z.boolean().default(false),
    /** Its results are being handed out; never played again from here. */
    finishing: z.boolean().default(false)
});

export type EventRun = z.infer<typeof runSchema> & { preset: EventPreset };

export const OUTCOMES = ["finished", "cancelled", "skipped", "failed"] as const;
export type EventOutcome = (typeof OUTCOMES)[number];

const historySchema = z.object({
    id: z.string(),
    presetId: z.string(),
    kind: z.enum(EVENT_KINDS),
    name: z.string(),
    trigger: z.enum(TRIGGERS),
    outcome: z.enum(OUTCOMES),
    /** One sentence about how it ended, for the history on the screen. */
    note: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    participants: z.number().int(),
    podium: z
        .array(z.object({ place: z.number().int(), name: z.string(), score: z.number() }))
        .default([]),
    disqualified: z.array(z.string()).default([])
});

export type EventHistoryEntry = z.infer<typeof historySchema>;

const pendingSchema = z.object({
    id: z.string(),
    player: z.string(),
    reward: rewardSchema,
    /** The event it is for, which is what the player is told when it arrives. */
    event: z.string(),
    createdAt: z.number()
});

export type PendingReward = z.infer<typeof pendingSchema>;

export const eventStateSchema = z.object({
    run: runSchema.nullable().default(null),
    history: z.array(historySchema).default([]),
    pending: z.array(pendingSchema).default([]),
    /** When the next automatic event may come. Null until the draw first runs. */
    nextRandomAt: z.number().nullable().default(null),
    /** Why the one that was due has not started, for the screen. */
    waiting: z.string().nullable().default(null),
    /** The kind the last one was, so two of the same do not come back to back. */
    lastKind: z.enum(EVENT_KINDS).nullable().default(null),
    /** When each scheduled entry last fired, by entry id. */
    scheduleRuns: z.record(z.number()).default({})
});

export type EventState = z.infer<typeof eventStateSchema> & { run: EventRun | null };

/** How many past events are kept. */
export const HISTORY_KEPT = 30;
/** How long a prize waits for somebody who has not come back. */
export const PENDING_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** How many prizes may wait at once, so a server nobody plays cannot grow it forever. */
export const PENDING_MAX = 200;

export const EMPTY_EVENT_STATE: EventState = {
    run: null,
    history: [],
    pending: [],
    nextRandomAt: null,
    waiting: null,
    lastKind: null,
    scheduleRuns: {}
};

export function readEventState(config: Record<string, unknown>): EventState {
    const parsed = eventStateSchema.safeParse(config[EVENT_STATE_KEY]);
    return parsed.success ? (parsed.data as EventState) : EMPTY_EVENT_STATE;
}

/** A finished event, first in the history, which keeps its last few. */
export function withHistory(state: EventState, entry: EventHistoryEntry): EventState {
    return { ...state, history: [entry, ...state.history].slice(0, HISTORY_KEPT) };
}

/** Prizes still owed, minus the ones too old to keep waiting for. */
export function livePending(pending: readonly PendingReward[], now: number): PendingReward[] {
    return pending.filter((one) => now - one.createdAt < PENDING_KEPT_MS).slice(-PENDING_MAX);
}
