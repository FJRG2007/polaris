/**
 * The decisions around an event, apart from the playing of it: whether one is
 * due, which one the draw picks, who counts as playing, who stands on the podium
 * and what each of them is owed.
 *
 * Pure, with the clock and the dice passed in, so each rule is asserted in a test
 * rather than hoped for on a live server.
 */

import { parseTime, zonedMoment } from "../schedule";
import {
    activeNeeded,
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
}

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
    now: number
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
            movedAt: moved ? now : (last?.movedAt ?? null)
        });
    }
    return next;
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

export type RandomDecision =
    | { readonly start: EventPreset; readonly nextRandomAt: number; readonly waiting: null }
    | {
          readonly start: null;
          readonly nextRandomAt: number | null;
          readonly waiting: string | null;
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
            waiting: "Outside the hours events are drawn in"
        };
    }
    if (input.running) {
        return { start: null, nextRandomAt: input.nextRandomAt, waiting: "Another event is on" };
    }
    // Only what this many players can start: a competition with prizes needs
    // two at least, so one player alone can still get a happy hour but never a
    // podium to themselves.
    const startable = pool.filter((entry) => input.active >= activeNeeded(entry.preset, settings));
    if (startable.length === 0) {
        const needed = Math.min(...pool.map((entry) => activeNeeded(entry.preset, settings)));
        return {
            start: null,
            nextRandomAt: input.nextRandomAt,
            waiting: `Waiting for ${needed} active ${needed === 1 ? "player" : "players"} (${input.active} now)`
        };
    }
    const fresh = startable.filter((entry) => entry.preset.kind !== input.lastKind);
    const choices = fresh.length > 0 ? fresh : startable;
    const total = choices.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = random() * total;
    let chosen = choices[choices.length - 1]!.preset;
    for (const entry of choices) {
        roll -= entry.weight;
        if (roll < 0) {
            chosen = entry.preset;
            break;
        }
    }
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
 * The top three by score, ties sharing a place (two firsts, then a third).
 * Nobody with nothing to show stands on it, and nobody disqualified does.
 */
export function podium(
    scores: ReadonlyMap<string, number>,
    disqualified: ReadonlySet<string>
): Placed[] {
    const ranked = [...scores.entries()]
        .filter(([name, score]) => score > 0 && !disqualified.has(name.toLowerCase()))
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const placed: Placed[] = [];
    ranked.forEach(([name, score], index) => {
        const previous = placed[index - 1];
        const place = previous && previous.score === score ? previous.place : index + 1;
        if (place <= 3) placed.push({ place, name, score });
    });
    return placed;
}

/**
 * What each player is owed: their place's prize, and the prize for taking part
 * on top of it. `took` is everybody who took part, as the event defines it.
 * Empty prizes are left out, so nobody is sent nothing.
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
    const add = (name: string, reward: Reward) => {
        if (reward.items.length === 0 && reward.levels === 0) return;
        const held = owed.get(name) ?? { items: [], levels: 0 };
        owed.set(name, {
            items: [...held.items, ...reward.items],
            levels: held.levels + reward.levels
        });
    };
    for (const one of placed) add(one.name, byPlace[one.place] ?? { items: [], levels: 0 });
    for (const name of took) if (!disqualified.has(name.toLowerCase())) add(name, rewards.everyone);
    return [...owed.entries()].map(([name, reward]) => ({ name, reward }));
}
