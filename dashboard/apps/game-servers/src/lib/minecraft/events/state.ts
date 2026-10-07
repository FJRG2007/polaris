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
    PARKOUR_SHAPES,
    presetSchema,
    rewardSchema,
    type EventPreset
} from "./catalog";
import { stashSchema } from "./kinds/stash";
import { bossStateSchema, trophySchema } from "./kinds/boss";
import { villagerSchema } from "./kinds/village-defense";
import { bingoSchema } from "./kinds/bingo";
import { fishSchema } from "./kinds/boss-fishing";
import { stageSchema, stageLeftoverSchema } from "./kinds/stage";
import { placeFromSchema, placeTrySchema, searchSummarySchema } from "./place-search";

export const TRIGGERS = ["manual", "scheduled", "random"] as const;
export type EventTrigger = (typeof TRIGGERS)[number];

const pointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof pointSchema>;

/** A treasure hunt's chest: where it is, and who opened it once somebody has. */
const chestSchema = z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
    opened: z.boolean().default(false),
    by: z.string().nullable().default(null),
    /** The small plant it took the place of, put back when it is taken away unopened. */
    was: z.string().nullable().default(null)
});
export type HiddenChest = z.infer<typeof chestSchema>;

/** A box of blocks in the Overworld, both corners included. */
export const boxSchema = z.object({
    x1: z.number().int(),
    y1: z.number().int(),
    z1: z.number().int(),
    x2: z.number().int(),
    y2: z.number().int(),
    z2: z.number().int()
});
export type Box = z.infer<typeof boxSchema>;

/**
 * What an event built: a box that was nothing but air when it was checked, and
 * every kind of block it put there. Taking it down replaces only those kinds,
 * only inside the box - so nothing that was there before, and nothing anybody
 * else put down, is touched.
 */
export const arenaSchema = z.object({ box: boxSchema, blocks: z.array(z.string()) });
export type Arena = z.infer<typeof arenaSchema>;

export const GAMEMODES = ["survival", "creative", "adventure", "spectator"] as const;

/** Somebody kept out of an arena or a stage rather than let in carrying their
 *  own things: why, and the items that could not be put away, by id. */
export const keptOutSchema = z.object({
    name: z.string(),
    why: z.enum(["unread", "untakeable", "unsaved", "unsettled"]),
    items: z.array(z.string()).default([])
});

export type KeptOut = z.infer<typeof keptOutSchema>;

/**
 * A player an event took somewhere, and everything needed to put them back:
 * where they stood, which way they faced, in which world, and the game mode
 * they played in. Written down before they are moved, and never again.
 */
export const entrantSchema = z.object({
    name: z.string(),
    /** For finding what they dropped while they were away; null when unread. */
    uuid: z.array(z.number().int()).length(4).nullable(),
    dimension: z.string(),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    yaw: z.number(),
    pitch: z.number(),
    gamemode: z.enum(GAMEMODES),
    /** Their team in a duel (0 or 1), their plot in a build battle. */
    side: z.number().int(),
    /** Moved by the event and not yet put back. */
    away: z.boolean().default(true),
    /** Carries the arena's tag while in: one who is on without it has been put
     *  back already. False for anybody taken in before the tag was given. */
    tagged: z.boolean().default(false),
    /** What they carried, kept until it is given back (`kinds/stash`). */
    stash: stashSchema.nullable().default(null)
});
export type Entrant = z.infer<typeof entrantSchema>;

/** How the items an event hands out are marked: item components from 1.20.5,
 *  a tag on the item before. */
export const MARKERS = ["components", "tag"] as const;
export type Marker = (typeof MARKERS)[number];

/**
 * A run's copy of its event is the event as it began: a parkour from before
 * shapes is read with them, so it keeps the length its course was built with
 * instead of the longer one an old saved event now reads as.
 */
function asBegun(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const { kind, options } = value as { kind?: unknown; options?: unknown };
    if (kind !== "parkour" || typeof options !== "object" || options === null) return value;
    if ("shapes" in options) return value;
    return { ...value, options: { ...options, shapes: [...PARKOUR_SHAPES] } };
}

export const runSchema = z.object({
    id: z.string(),
    trigger: z.enum(TRIGGERS),
    /** Who pressed Run, for a manual one. */
    startedBy: z.string().nullable(),
    /** A copy, so editing the event while it runs changes the next one, not this. */
    preset: z.preprocess(asBegun, presetSchema),
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
    /** Where the place was looked for from, and what stopped each try - for the
     *  history, when nowhere would do (`place-search`). */
    placeFrom: placeFromSchema.nullable().default(null),
    placeLog: z.array(placeTrySchema).default([]),
    /** A king of the hill with no untouched ground for its circle: looking over
     *  the sea now, for a platform of its own. */
    overSea: z.boolean().default(false),
    /** King of the ring with fists only: the ring as last drawn, the round last
     *  announced, whether its double points were, and who wears the crown. */
    ring: z
        .object({
            round: z.number().int(),
            dx: z.number().int(),
            dz: z.number().int(),
            radius: z.number().int(),
            sprint: z.boolean(),
            leader: z.string().nullable()
        })
        .nullable()
        .default(null),
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
    /** Trivia: by name, how long each took to answer the rounds they took,
     *  added up in milliseconds - what breaks a tie on points (`plan.podium`). */
    answerMs: z.record(z.number().nonnegative()).default({}),
    /** Trivia: who already answered the open true-or-false round wrong, and so
     *  has no second try at it. Emptied as each round is asked. */
    triviaOut: z.array(z.string()).default([]),
    /** Somebody pressed Cancel; the loop ends it on its next tick. */
    cancelled: z.boolean().default(false),
    /** Game rules the event changed, and what each was before, so they are put
     *  back even after a restart. */
    gamerules: z.record(z.string()).default({}),
    /** A blood moon's: the time of day before it, for a server whose clock
     *  stands still. */
    timeBefore: z.number().nullable().default(null),
    /** Everybody seen in creative or spectator while it ran. */
    offMode: z.array(z.string()).default([]),
    /** Everybody kept out because what they carried could not all be put away
     *  safely, and why (`stash-service`). */
    keptOut: z.array(keptOutSchema).default([]),
    /** Its results are being handed out; never played again from here. */
    finishing: z.boolean().default(false),
    /** Treasure hunt: every chest it put down, and who opened each. Kept so the
     *  ones still unopened are taken away, and their chunks let go of, even
     *  after a restart. */
    chests: z.array(chestSchema).default([]),
    /** Treasure hunt: the columns kept loaded for the chests. */
    held: z.array(z.object({ x: z.number(), z: z.number() })).default([]),
    /** Treasure hunt: every chest there will be is down. */
    hidden: z.boolean().default(false),
    /** Treasure hunt: where the players were when the chests were hidden, which
     *  the first clue is told from. */
    origin: z.object({ x: z.number(), z: z.number() }).nullable().default(null),
    /** Gathering: the material of the round being played, drawn as it began;
     *  its number is `round` (from 0), and it ends at `roundEndsAt`. */
    material: z.string().nullable().default(null),
    /** Gathering: every round's material so far, so no two rounds ask for the same. */
    materials: z.array(z.string()).default([]),
    /** Horde defense: the waves each player was at the point for when they
     *  ended, by name. The wave itself is `round` (from 0), open until
     *  `roundEndsAt`, and the last one closed at `closedAt`. */
    survived: z.record(z.number()).default({}),
    /** Every chunk that was held loaded before the event touched any, as `x,z`
     *  chunk keys - somebody else's, never let go of by the event. Null when the
     *  server would not say, or the run is older than this. */
    keepForced: z.array(z.string()).nullable().default(null),
    /** Chunks the event holds loaded besides its place's own - by chunk
     *  coordinates, only ones nobody held before it - let go at the end. */
    chunks: z.array(z.object({ x: z.number().int(), z: z.number().int() })).default([]),
    /** Meteor shower: every meteor that landed, with each ore block of it the
     *  event placed into air and that is still there as far as it knows - the
     *  only blocks the end may take away. */
    meteors: z
        .array(
            pointSchema.extend({
                blocks: z.array(pointSchema.extend({ block: z.string() })).default([])
            })
        )
        .default([]),
    /** Meteor shower: how many of its meteors have come down, or been given up on. */
    landings: z.number().int().default(0),
    /** Parkour and spleef: who joined, what was built and where everybody was. */
    stage: stageSchema.nullable().default(null),
    /** An event players join: who typed `join`, in the order they did - and,
     *  once `enrolled`, who of them is taking part, their order their side. */
    joined: z.array(z.string()).default([]),
    enrolled: z.boolean().default(false),
    /** The ground kept loaded under an arena being put up, before it is built. */
    site: boxSchema.nullable().default(null),
    /** What it built, once it has. */
    arena: arenaSchema.nullable().default(null),
    /** Who it moved, and where each came from. */
    entrants: z.array(entrantSchema).default([]),
    /** Taken from and then kept out (`keptOut`), and not yet put back or given
     *  back their things: never played, only sent home at the end. */
    sentOut: z.array(entrantSchema).default([]),
    /** How the kit it handed out is marked, and which items it was. */
    marker: z.enum(MARKERS).nullable().default(null),
    kit: z.array(z.string()).default([]),
    /** When everybody was in place and the playing itself began. */
    readyAt: z.number().nullable().default(null),
    /** A team duel's points by team (`0`, `1`). */
    tally: z.record(z.number()).default({}),
    /** A build battle's votes: who voted, for whose plot. */
    votes: z.record(z.string()).default({}),
    /** A build battle's theme, in the players' language. */
    theme: z.string().nullable().default(null),
    /** A trivia game: the bank's questions the server asked lately, as it
     *  started - asked after the others (`trivia-bank.ordered`). */
    triviaSkip: z.array(z.string()).default([]),
    /** A build battle: the building is over and the vote is on. */
    voting: z.boolean().default(false),
    /** A build battle: the [Done] button has been offered to the builders. */
    doneOffered: z.boolean().default(false),
    /** A build battle: the builders who pressed [Done] and have not taken it back. */
    done: z.array(z.string()).default([]),
    /** A build battle: when the building ended early, everybody done - its own
     *  time otherwise (`readyAt` and the minutes). */
    buildEndsAt: z.number().nullable().default(null),
    /** An arena kind played through `ArenaGame` (`kinds/arena-game.ts`): its own
     *  state - flags, who is out, who holds the potato - read with that kind's
     *  own schema, so a run saved by an older Polaris still reads. */
    game: z.record(z.unknown()).nullable().default(null),
    /** A world boss: which one was drawn, and how its fight stands. */
    boss: bossStateSchema.nullable().default(null),
    /** A villager defense: its villager, written down before it is summoned. */
    villager: villagerSchema.nullable().default(null),
    /** A horde or villager defense whose kills the events data pack counts -
     *  only the monsters it summoned (`waves.wavesSetup`) - rather than the
     *  game's own statistics, which count the night's own too. Chosen as it
     *  begins; a run saved before it reads as the statistics. */
    killsByPack: z.boolean().default(false),
    /** A bingo rush: its card, drawn as it began, and who has marked what. */
    bingo: bingoSchema.nullable().default(null),
    /** A boss fishing: the fish's strength, who it was sized for, and the catches. */
    fish: fishSchema.nullable().default(null)
});

export type EventRun = z.infer<typeof runSchema> & { preset: EventPreset };

export const OUTCOMES = ["finished", "cancelled", "skipped", "failed"] as const;
export type EventOutcome = (typeof OUTCOMES)[number];

/** One player's prize as it reached them. */
export const deliveredSchema = z.object({
    name: z.string(),
    items: z
        .array(
            z.object({
                id: z.string(),
                count: z.number().int(),
                dropped: z.number().int().default(0)
            })
        )
        .default([]),
    levels: z.number().int().default(0)
});

export type DeliveredPrize = z.infer<typeof deliveredSchema>;

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
    disqualified: z.array(z.string()).default([]),
    /** What each player was handed, and how much of it fell at their feet for
     *  want of room: what `give` answers cannot tell. */
    delivered: z.array(deliveredSchema).default([]),
    /** Where it looked for its place and what stopped it, when nowhere would do. */
    search: searchSummarySchema.nullable().default(null),
    /** Who was kept out to keep their things safe, and why. */
    keptOut: z.array(keptOutSchema).default([])
});

export type EventHistoryEntry = z.infer<typeof historySchema>;

const pendingSchema = z.object({
    id: z.string(),
    player: z.string(),
    reward: rewardSchema,
    /** The event it is for, which is what the player is told when it arrives. */
    event: z.string(),
    createdAt: z.number(),
    /** A world boss's trophy owed besides the reward, rebuilt when it is handed over. */
    trophy: trophySchema.nullable().default(null)
});

export type PendingReward = z.infer<typeof pendingSchema>;

/**
 * Lines an event's end owes one player who was not on when it ended - a
 * minimap's radar given back after hide and seek - sent when they are next
 * seen, and dropped once `until` has passed. One per player and reason.
 */
const owedLinesSchema = z.object({
    player: z.string(),
    /** What they put right, so a second end owing the same replaces the first. */
    reason: z.string(),
    lines: z.array(z.string()),
    until: z.number()
});

export type OwedLines = z.infer<typeof owedLinesSchema>;

/**
 * An arena an event has ended with and not yet been able to take down, because
 * somebody who was in it is not online to be taken back: logging in, they are
 * in it, enclosed and safe, rather than in the air where it was. The sweep puts
 * them back when they are on, and takes it down once nobody is left in it.
 */
const arenaLeftoverSchema = z.object({
    id: z.string(),
    kind: z.enum(EVENT_KINDS),
    arena: arenaSchema.nullable(),
    site: boxSchema.nullable().default(null),
    marker: z.enum(MARKERS).nullable(),
    kit: z.array(z.string()),
    entrants: z.array(entrantSchema),
    /** Game rules still to put back, when the server was not answering at the end. */
    gamerules: z.record(z.string()).default({}),
    /** The chunks held before the event, which letting its own go must spare. */
    keepForced: z.array(z.string()).nullable().default(null),
    createdAt: z.number()
});

export type ArenaLeftover = z.infer<typeof arenaLeftoverSchema>;

export const eventStateSchema = z.object({
    run: runSchema.nullable().default(null),
    history: z.array(historySchema).default([]),
    pending: z.array(pendingSchema).default([]),
    /** Lines owed to players who were not on when an event ended. */
    owedLines: z.array(owedLinesSchema).default([]),
    /** When the next automatic event may come. Null until the draw first runs. */
    nextRandomAt: z.number().nullable().default(null),
    /** Why the one that was due has not started, for the screen. */
    waiting: z.string().nullable().default(null),
    /** Whether a drawn event that fell due is held back for want of players,
     *  and when they were first seen there since, while it settles
     *  (`plan.SETTLE_MS`). */
    short: z.boolean().default(false),
    readySince: z.number().nullable().default(null),
    /** The kind the last one was, so two of the same do not come back to back. */
    lastKind: z.enum(EVENT_KINDS).nullable().default(null),
    /** When each scheduled entry last fired, by entry id. */
    scheduleRuns: z.record(z.number()).default({}),
    /** The bank's trivia questions asked lately, oldest first. */
    triviaSeen: z.array(z.string()).default([]),
    /** Events won, by lowercased player name - kept apart from the history,
     *  which forgets. Null on a server that has not finished one since this was
     *  kept, where the history is counted instead. */
    wins: z
        .record(z.object({ name: z.string(), count: z.number().int() }))
        .nullable()
        .default(null),
    /** What a parkour or spleef left to undo when it ended - blocks still up,
     *  players still owed their trip back - settled by the sweep. */
    stageLeftovers: z.array(stageLeftoverSchema).default([]),
    /** Arenas still standing for somebody to be taken back from. */
    arenaLeftovers: z.array(arenaLeftoverSchema).default([])
});

export type EventState = z.infer<typeof eventStateSchema> & { run: EventRun | null };

/** How many past events are kept. */
export const HISTORY_KEPT = 30;
/** How long a prize waits for somebody who has not come back. */
export const PENDING_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** How many prizes may wait at once, so a server nobody plays cannot grow it forever. */
export const PENDING_MAX = 200;

/** How many players may be owed lines at once, the oldest let go first. */
export const OWED_LINES_MAX = 200;

/** Owed lines still in time, `added` replacing any owed the same player for the same reason. */
export function withOwedLines(
    owed: readonly OwedLines[],
    added: readonly OwedLines[],
    now: number
): OwedLines[] {
    const key = (one: OwedLines) => `${one.player.toLowerCase()} ${one.reason}`;
    const replaced = new Set(added.map(key));
    return [...owed.filter((one) => !replaced.has(key(one))), ...added]
        .filter((one) => one.until > now)
        .slice(-OWED_LINES_MAX);
}

export const EMPTY_EVENT_STATE: EventState = {
    run: null,
    history: [],
    pending: [],
    owedLines: [],
    nextRandomAt: null,
    waiting: null,
    short: false,
    readySince: null,
    lastKind: null,
    scheduleRuns: {},
    triviaSeen: [],
    wins: null,
    stageLeftovers: [],
    arenaLeftovers: []
};

export function readEventState(config: Record<string, unknown>): EventState {
    const parsed = eventStateSchema.safeParse(config[EVENT_STATE_KEY]);
    return parsed.success ? (parsed.data as EventState) : EMPTY_EVENT_STATE;
}

/** A finished event, first in the history, which keeps its last few - and its
 *  winners counted for good. */
export function withHistory(state: EventState, entry: EventHistoryEntry): EventState {
    return {
        ...state,
        history: [entry, ...state.history].slice(0, HISTORY_KEPT),
        wins: counted(winsSoFar(state), entry)
    };
}

type Wins = NonNullable<EventState["wins"]>;

/** Whoever came first in it: a tie for first is a win for each. */
function counted(wins: Wins, entry: EventHistoryEntry): Wins {
    if (entry.outcome !== "finished") return wins;
    const next = { ...wins };
    for (const one of entry.podium.filter((place) => place.place === 1)) {
        const key = one.name.toLowerCase();
        next[key] = { name: one.name, count: (next[key]?.count ?? 0) + 1 };
    }
    return next;
}

function winsSoFar(state: EventState): Wins {
    return state.wins ?? [...state.history].reverse().reduce<Wins>(counted, {});
}

/** How many events each player has won on this server, most first. */
export function eventWins(state: EventState): { name: string; value: number }[] {
    return Object.values(winsSoFar(state)).map((one) => ({ name: one.name, value: one.count }));
}

/**
 * Who, in lower case, is still owed a trip back from an earlier stage or arena
 * - logged out inside it - and so is not taken anywhere else until they are
 * back where they started.
 */
export function owedNames(
    state: Pick<EventState, "arenaLeftovers" | "stageLeftovers">
): Set<string> {
    return new Set([
        ...state.arenaLeftovers
            .flatMap((one) => one.entrants)
            .filter((one) => one.away)
            .map((one) => one.name.toLowerCase()),
        ...state.stageLeftovers.flatMap((one) => one.saved.map((saved) => saved.name.toLowerCase()))
    ]);
}

/**
 * Who, in lower case, an event still holds: their own things put away, or a
 * trip back still owed - in the run on now, or in an arena or a stage one left
 * behind. Nothing is handed to them until it lets them go: a prize given while
 * their own things are away lands in an empty slot - the slot one of their own
 * stacks goes back into, which then falls at their feet - and never joins the
 * stack of the same item they get back.
 */
export function heldNames(
    state: Pick<EventState, "run" | "arenaLeftovers" | "stageLeftovers">
): Set<string> {
    const entrants = [...(state.run?.entrants ?? []), ...(state.run?.sentOut ?? [])];
    return new Set([
        ...owedNames(state),
        ...entrants.filter((one) => one.away).map((one) => one.name.toLowerCase()),
        ...(state.run?.stage?.saved ?? []).map((saved) => saved.name.toLowerCase())
    ]);
}

/** Prizes still owed, minus the ones too old to keep waiting for. */
export function livePending(pending: readonly PendingReward[], now: number): PendingReward[] {
    return pending.filter((one) => now - one.createdAt < PENDING_KEPT_MS).slice(-PENDING_MAX);
}
