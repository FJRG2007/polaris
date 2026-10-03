/**
 * The decisions around an event, apart from the playing of it: whether one is
 * due, which one the draw picks, who counts as playing, who stands on the podium
 * and what each of them is owed.
 *
 * Pure, with the clock and the dice passed in, so each rule is asserted in a test
 * rather than hoped for on a live server.
 */

import { gameMessage } from "../../game-message";
import { parseTime, zonedMoment } from "../schedule";
import {
    activeNeeded,
    needsOverworld,
    runMinutes,
    type EventPreset,
    type EventSettings,
    type EventScheduleEntry,
    type Reward,
    type Rewards
} from "./catalog";

// ------------------------------------------------------------------ who is playing

/** What was last seen of one player, to tell somebody playing from somebody idle. */
export interface Seen {
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
    readonly pitch: number;
    /** When they were first seen this time round. */
    readonly since: number;
    /** When they last moved or turned. Null until they have been seen to. */
    readonly movedAt: number | null;
    /** Which world they are in, when that was read. */
    readonly dimension: string | null;
    /** The game's running count of damage they have taken and dealt, as last
     *  read, to tell when either went up. */
    readonly hurt: number | null;
    readonly hit: number | null;
    /** When they were last seen taking or dealing damage. */
    readonly fightingAt: number | null;
}

/** What else a look can tell about each player, by name. */
export interface Readings {
    readonly dimensions?: ReadonlyMap<string, string>;
    readonly hurt?: ReadonlyMap<string, number>;
    readonly hit?: ReadonlyMap<string, number>;
}

/** How long after the last blow somebody still counts as in a fight. */
export const FIGHT_COOLDOWN_MS = 90_000;

export const OVERWORLD = "minecraft:overworld";
const THE_END = "minecraft:the_end";

/** Less than this is standing still: a player's position wobbles a little. */
const STILL_BLOCKS = 0.3;
const STILL_DEGREES = 2;

/**
 * Everybody on the server now, with when each of them last did something.
 *
 * Somebody seen for the first time has not been seen to move yet, so they do not
 * count as active until the next look finds them somewhere else or facing
 * elsewhere. Somebody no longer on the list is forgotten, so a player who logs
 * back in is judged from then.
 */
export function observe(
    before: ReadonlyMap<string, Seen>,
    positions: readonly { name: string; x: number; y: number; z: number }[],
    facing: ReadonlyMap<string, { yaw: number; pitch: number }>,
    now: number,
    readings: Readings = {}
): Map<string, Seen> {
    const next = new Map<string, Seen>();
    for (const where of positions) {
        const key = where.name.toLowerCase();
        const turned = facing.get(where.name) ?? { yaw: 0, pitch: 0 };
        const last = before.get(key);
        const moved =
            last !== undefined &&
            (Math.hypot(where.x - last.x, where.y - last.y, where.z - last.z) > STILL_BLOCKS ||
                angleBetween(turned.yaw, last.yaw) > STILL_DEGREES ||
                Math.abs(turned.pitch - last.pitch) > STILL_DEGREES);
        next.set(key, {
            name: where.name,
            x: where.x,
            y: where.y,
            z: where.z,
            yaw: turned.yaw,
            pitch: turned.pitch,
            since: last?.since ?? now,
            movedAt: moved ? now : (last?.movedAt ?? null),
            ...fight(last, readings, where.name, now)
        });
    }
    return next;
}

/**
 * Whether the damage they dealt went up since the last look, which is what a
 * fight looks like from outside the game.
 *
 * Damage taken alone is not a fight: hunger, a fall, a cactus or a mob nibbling
 * at somebody who is busy building all raise it, and on a small island it rose
 * often enough that a drawn event waited all evening for a fight that was never
 * on. It is still read and kept, for the readers that want it.
 */
function fight(
    last: Seen | undefined,
    readings: Readings,
    name: string,
    now: number
): Pick<Seen, "dimension" | "hurt" | "hit" | "fightingAt"> {
    const hurt = readings.hurt?.get(name) ?? null;
    const hit = readings.hit?.get(name) ?? null;
    const rose = last !== undefined && hit !== null && last.hit !== null && hit > last.hit;
    return {
        dimension: readings.dimensions?.get(name) ?? last?.dimension ?? null,
        hurt,
        hit,
        fightingAt: rose ? now : (last?.fightingAt ?? null)
    };
}

/**
 * Whether somebody is in the middle of something an event should not land on:
 * a fight (damage dealt) in the last minute and a half, or the End, where the
 * one thing to do is fight the dragon.
 */
export function busy(one: Seen, now: number): boolean {
    if (one.dimension === THE_END) return true;
    return one.fightingAt !== null && now - one.fightingAt <= FIGHT_COOLDOWN_MS;
}

/**
 * The players who did nothing at all from `since` on: never seen to move or turn
 * after it. Fighting does not count, since mobs walk into a player at a farm who
 * never touches the keyboard. Only players this process has actually watched -
 * somebody it knows nothing about is not accused of anything.
 */
export function idleThroughout(seen: ReadonlyMap<string, Seen> | null, since: number): string[] {
    if (!seen) return [];
    return [...seen.values()]
        .filter((one) => (one.movedAt ?? 0) < since && one.since <= since)
        .map((one) => one.name);
}

/** The players who can take part in this event: active, and in the Overworld
 *  when it happens there. Somebody whose world was not read is not held back. */
export function playersFor(
    preset: EventPreset,
    seen: ReadonlyMap<string, Seen>,
    afkMinutes: number,
    now: number
): Seen[] {
    const active = activePlayers(seen, afkMinutes, now);
    if (!needsOverworld(preset)) return active;
    return active.filter((one) => one.dimension === null || one.dimension === OVERWORLD);
}

/** Why an automatic event should wait: the active players who are busy, carried
 *  as a catalog key (`lib/game-message`) for whoever reads it. */
export function busyReason(
    seen: ReadonlyMap<string, Seen>,
    afkMinutes: number,
    now: number
): string | null {
    const names = activePlayers(seen, afkMinutes, now)
        .filter((one) => busy(one, now))
        .map((one) => one.name);
    if (names.length === 0) return null;
    const shown = names.slice(0, 3).join(", ");
    return names.length > 3
        ? gameMessage("minecraft", "events.waiting.busyMore", { names: shown })
        : gameMessage("minecraft", "events.waiting.busy", { names: shown, count: names.length });
}

function angleBetween(left: number, right: number): number {
    const difference = Math.abs(left - right) % 360;
    return difference > 180 ? 360 - difference : difference;
}

/** The players who moved within the last `afkMinutes`. */
export function activePlayers(
    seen: ReadonlyMap<string, Seen>,
    afkMinutes: number,
    now: number
): Seen[] {
    return [...seen.values()].filter(
        (one) => one.movedAt !== null && now - one.movedAt <= afkMinutes * 60_000
    );
}

// ------------------------------------------------------------------ when

/** The minute-grained clock an automatic event is read against. */
function localNow(settings: EventSettings, now: number): { day: number; minutes: number } {
    try {
        return zonedMoment(new Date(now), settings.timezone);
    } catch {
        return zonedMoment(new Date(now), "UTC");
    }
}

/**
 * The scheduled entries due right now: their minute has come, within a few of
 * it, on one of their days, and they have not fired for this occurrence. A
 * minute that passed long ago - Polaris was down - is let go rather than run
 * late, the same rule scheduled routines follow.
 */
export function schedulesDue(
    settings: EventSettings,
    schedules: readonly EventScheduleEntry[],
    fired: Readonly<Record<string, number>>,
    now: number,
    graceMinutes = 5
): EventScheduleEntry[] {
    const { day, minutes } = localNow(settings, now);
    return schedules.filter((entry) => {
        if (!entry.enabled) return false;
        if (entry.days.length > 0 && !entry.days.includes(day)) return false;
        const wanted = parseTime(entry.at);
        if (wanted === null) return false;
        const late = minutes - wanted;
        if (late < 0 || late > graceMinutes) return false;
        const last = fired[entry.id];
        // Fired inside this same window: the sweep came round again in it.
        return last === undefined || now - last > (graceMinutes + 1) * 60_000;
    });
}

/** Whether the draw's hours are open now. A window that ends before it starts
 *  runs past midnight. */
export function randomWindowOpen(settings: EventSettings, now: number): boolean {
    const { random } = settings;
    const { day, minutes } = localNow(settings, now);
    const from = parseTime(random.from);
    const to = parseTime(random.to);
    if (from === null || to === null) return false;
    if (from === to) return random.days.length === 0 || random.days.includes(day);
    if (from < to) {
        return (
            (random.days.length === 0 || random.days.includes(day)) &&
            minutes >= from &&
            minutes < to
        );
    }
    // Past midnight: the late part belongs to the day it started on.
    if (minutes >= from) return random.days.length === 0 || random.days.includes(day);
    if (minutes < to) return random.days.length === 0 || random.days.includes((day + 6) % 7);
    return false;
}

/** The wait before the next automatic event, in milliseconds. */
export function nextGap(settings: EventSettings, random: () => number): number {
    const { minGap, maxGap } = settings.random;
    return Math.round((minGap + random() * Math.max(0, maxGap - minGap)) * 60_000);
}

/** Why one event of the draw cannot be picked now, for the screen. */
export interface Skipped {
    readonly presetId: string;
    readonly name: string;
    /** A catalog key (`lib/game-message`). */
    readonly reason: string;
}

/**
 * What the draw can pick from right now: every event in its pool that is
 * switched on and has the players it needs (in the Overworld, for the ones
 * that happen there), weighted - and every one it cannot, with why. The same
 * kind as last time is left out while there is anything else to pick.
 */
export function drawable(input: {
    settings: EventSettings;
    presets: readonly EventPreset[];
    lastKind: string | null;
    activeFor: (preset: EventPreset) => number;
}): { choices: { preset: EventPreset; weight: number }[]; skipped: Skipped[] } {
    const skipped: Skipped[] = [];
    const startable: { preset: EventPreset; weight: number }[] = [];
    for (const entry of input.settings.random.pool) {
        const preset = input.presets.find((one) => one.id === entry.presetId);
        if (!preset) continue;
        if (!preset.enabled) {
            skipped.push({
                presetId: preset.id,
                name: preset.name,
                reason: gameMessage("minecraft", "events.skipped.switchedOff")
            });
            continue;
        }
        const needed = activeNeeded(preset, input.settings);
        const have = input.activeFor(preset);
        if (have < needed) {
            skipped.push({
                presetId: preset.id,
                name: preset.name,
                reason: gameMessage("minecraft", "events.waiting.players", {
                    needed,
                    have,
                    overworld: needsOverworld(preset) ? "yes" : "no"
                })
            });
            continue;
        }
        startable.push({ preset, weight: entry.weight });
    }
    const fresh = startable.filter((entry) => entry.preset.kind !== input.lastKind);
    if (fresh.length > 0 && fresh.length < startable.length) {
        for (const entry of startable)
            if (entry.preset.kind === input.lastKind)
                skipped.push({
                    presetId: entry.preset.id,
                    name: entry.preset.name,
                    reason: gameMessage("minecraft", "events.skipped.sameAsLast")
                });
    }
    return { choices: fresh.length > 0 ? fresh : startable, skipped };
}

/** One of the choices, by weight. */
export function pickWeighted(
    choices: readonly { preset: EventPreset; weight: number }[],
    random: () => number
): EventPreset | null {
    if (choices.length === 0) return null;
    const total = choices.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = random() * total;
    for (const entry of choices) {
        roll -= entry.weight;
        if (roll < 0) return entry.preset;
    }
    return choices[choices.length - 1]!.preset;
}

/**
 * How long the conditions must have held before a draw that was kept waiting
 * starts: an event that lands the instant a second player joins starts on
 * somebody still loading in, so it waits for one more look.
 */
export const SETTLE_MS = 90_000;

export type RandomDecision =
    | { readonly start: EventPreset; readonly nextRandomAt: number; readonly waiting: null }
    | {
          readonly start: null;
          readonly nextRandomAt: number | null;
          readonly waiting: string | null;
          /** Whether it is held back for want of players, and since when they
           *  have been there while it settles - carried to the next look. */
          readonly short?: boolean;
          readonly readySince?: number | null;
      };

/**
 * Whether the draw starts an event now, and when it looks again.
 *
 * - Off, or nothing to draw from: nothing, and nothing pending.
 * - Never armed: armed for one gap from now, so turning it on does not start
 *   one on the spot.
 * - Due but outside its hours, with an event already on, or short of players
 *   who are actually playing: it waits, and says which.
 * - Otherwise one is drawn by weight - not the same kind as last time when
 *   there is anything else to choose - and the next is a gap after this one ends.
 */
export function decideRandom(input: {
    settings: EventSettings;
    presets: readonly EventPreset[];
    nextRandomAt: number | null;
    lastKind: string | null;
    running: boolean;
    active: number;
    /** How many can take part in one event, when that differs by event -
     *  the ones that happen in the Overworld count only who is there. */
    activeFor?: (preset: EventPreset) => number;
    /** Why now is a bad moment - somebody in a fight - or null. */
    busy?: string | null;
    /** Whether the last look held it back for want of players, and when the
     *  players it needs were first seen there since. */
    short?: boolean;
    readySince?: number | null;
    now: number;
    random: () => number;
}): RandomDecision {
    const { settings, presets, now, random } = input;
    const pool = settings.random.pool.flatMap((entry) => {
        const preset = presets.find((one) => one.id === entry.presetId && one.enabled);
        return preset ? [{ preset, weight: entry.weight }] : [];
    });
    if (!settings.random.enabled || pool.length === 0) {
        return { start: null, nextRandomAt: null, waiting: null };
    }
    if (input.nextRandomAt === null) {
        return { start: null, nextRandomAt: now + nextGap(settings, random), waiting: null };
    }
    if (now < input.nextRandomAt)
        return { start: null, nextRandomAt: input.nextRandomAt, waiting: null };
    if (!randomWindowOpen(settings, now)) {
        return {
            start: null,
            nextRandomAt: input.nextRandomAt,
            waiting: gameMessage("minecraft", "events.waiting.outsideHours")
        };
    }
    if (input.running) {
        return {
            start: null,
            nextRandomAt: input.nextRandomAt,
            waiting: gameMessage("minecraft", "events.waiting.anotherOn")
        };
    }
    // Only what this many players can start: a competition with prizes needs
    // two at least, so one player alone can still get a happy hour but never a
    // podium to themselves.
    if (input.busy) {
        return {
            start: null,
            nextRandomAt: input.nextRandomAt,
            waiting: gameMessage("minecraft", "events.waiting.busyNow", { reason: input.busy })
        };
    }
    const count = input.activeFor ?? (() => input.active);
    const { choices } = drawable({
        settings,
        presets,
        lastKind: input.lastKind,
        activeFor: count
    });
    if (choices.length === 0) {
        // Said for the event closest to starting: what it needs, where, and
        // how many of those there are.
        const nearest = pool
            .map((entry) => ({
                needed: activeNeeded(entry.preset, settings),
                have: count(entry.preset),
                overworld: needsOverworld(entry.preset) ? "yes" : "no"
            }))
            .sort((left, right) => left.needed - left.have - (right.needed - right.have))[0]!;
        return {
            start: null,
            nextRandomAt: input.nextRandomAt,
            waiting: gameMessage("minecraft", "events.waiting.players", nearest),
            short: true,
            readySince: null
        };
    }
    // Held back for want of players who have now come: one more look first, so
    // it does not land on somebody who has only just joined.
    if (input.short) {
        const readySince = input.readySince ?? now;
        if (now - readySince < SETTLE_MS)
            return {
                start: null,
                nextRandomAt: input.nextRandomAt,
                waiting: gameMessage("minecraft", "events.waiting.settling"),
                short: true,
                readySince
            };
    }
    const chosen = pickWeighted(choices, random)!;
    return {
        start: chosen,
        nextRandomAt: now + runMinutes(chosen) * 60_000 + nextGap(settings, random),
        waiting: null
    };
}

// ------------------------------------------------------------------ the podium

export interface Placed {
    readonly place: number;
    readonly name: string;
    readonly score: number;
}

/**
 * Who goes first of two: the higher score, then - when `took` is given - the
 * one who took less time over it, then the name, so the order is the same
 * every time it is worked out. A name missing from `took` counts as slowest.
 */
export function ranking(
    took?: Readonly<Record<string, number>>
): (left: readonly [string, number], right: readonly [string, number]) => number {
    const time = (name: string) => took?.[name] ?? Number.MAX_SAFE_INTEGER;
    return (left, right) =>
        right[1] - left[1] || time(left[0]) - time(right[0]) || left[0].localeCompare(right[0]);
}

/**
 * The top three by score, ties sharing a place (two firsts, then a third).
 * Nobody with nothing to show stands on it, and nobody disqualified does.
 *
 * `took` breaks a tie on score: a trivia game passes how long each player took
 * to answer the rounds they won, added up (`EventRun.answerMs`). Tied on
 * points, they took the same number of rounds, so the least time added up is
 * also the fastest on average - and only the same score in the same time
 * still shares a place.
 */
export function podium(
    scores: ReadonlyMap<string, number>,
    disqualified: ReadonlySet<string>,
    /** The least that ranks at all - see `minScoreOf`. */
    minScore = 1,
    took?: Readonly<Record<string, number>>
): Placed[] {
    const ranked = [...scores.entries()]
        .filter(
            ([name, score]) =>
                score >= Math.max(1, minScore) && !disqualified.has(name.toLowerCase())
        )
        .sort(ranking(took));
    const time = (name: string) => took?.[name] ?? Number.MAX_SAFE_INTEGER;
    const placed: Placed[] = [];
    ranked.forEach(([name, score], index) => {
        const previous = placed[index - 1];
        const tied =
            previous !== undefined &&
            previous.score === score &&
            (took === undefined || time(previous.name) === time(name));
        const place = tied ? previous.place : index + 1;
        if (place <= 3) placed.push({ place, name, score });
    });
    return placed;
}

/**
 * What each player is owed: their place's prize on the podium, and the prize
 * for taking part for everybody else who took part - never both. A place with
 * no prize of its own counts as off the podium, so nobody placed is left with
 * less than those below them. `took` is everybody who took part, as the event
 * defines it. Empty prizes are left out, so nobody is sent nothing.
 */
export function prizes(
    placed: readonly Placed[],
    took: readonly string[],
    rewards: Rewards,
    disqualified: ReadonlySet<string>
): { name: string; reward: Reward }[] {
    const byPlace: Readonly<Record<number, Reward>> = {
        1: rewards.first,
        2: rewards.second,
        3: rewards.third
    };
    const owed = new Map<string, Reward>();
    const add = (name: string, reward: Reward | undefined) => {
        if (!reward || (reward.items.length === 0 && reward.levels === 0)) return;
        const held = owed.get(name) ?? { items: [], levels: 0 };
        owed.set(name, {
            items: [...held.items, ...reward.items],
            levels: held.levels + reward.levels
        });
    };
    for (const one of placed) add(one.name, byPlace[one.place]);
    const paid = new Set([...owed.keys()].map((name) => name.toLowerCase()));
    for (const name of took) {
        const key = name.toLowerCase();
        if (!disqualified.has(key) && !paid.has(key)) add(name, rewards.everyone);
    }
    return [...owed.entries()].map(([name, reward]) => ({ name, reward }));
}
