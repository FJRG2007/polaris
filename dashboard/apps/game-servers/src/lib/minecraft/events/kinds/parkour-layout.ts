/**
 * How a parkour course is laid out (design 3 on), and the rules every course
 * keeps - checked here, by the same function the tests run over thousands of
 * courses (`layoutProblems`), before a course is ever built.
 *
 * The rules:
 * - Nothing touches. Between any two platforms - their columns, ladders, the
 *   lamps under the checkpoints and a moving platform's other place included -
 *   there is at least one block of air, diagonals too, unless one is at least
 *   `HEAD_ROOM` blocks over the other.
 * - Every jump has head room: nothing but the two platforms in the space over
 *   them, up to `HEAD_ROOM` blocks over the higher one.
 * - Checkpoints are spread out: one every `CHECK_EVERY` platforms, and none
 *   within `FINISH_AFTER` jumps of the finish.
 * - A trap or a climb only on a plain jump in the middle of a row: never the
 *   start, a checkpoint, the finish or a turn, nor right before or after one,
 *   nor right after another.
 * - A slime pad only where its bounce - worked out the way the game moves a
 *   player (`bounce`) - carries whoever lands on it over the next platform: the
 *   same height as the pad, close enough to reach in the air.
 *
 * A course that breaks any of them is laid out again from the next draw of the
 * same run's seed, so a run still always gets the same course.
 */

import { seeded } from "../trivia-bank";
import type { EventOptions } from "../catalog";
import type { Platform, Role, Trap } from "./parkour";

/** How far a row runs before it turns. */
export const ROW = 22;
/** Every so many platforms, a checkpoint. */
export const CHECK_EVERY = 6;
/** The fewest jumps between the last checkpoint and the finish. */
export const FINISH_AFTER = 3;
/** Air over a platform a jump needs: feet, head and the top of the jump. */
export const HEAD_ROOM = 3;
/** How far a moving platform moves, across the row. */
export const SHIFT_STEP = 1;
/** How many times a course is drawn again before it is laid out plain. */
const DRAWS = 40;

const STEPS: Readonly<
    Record<
        EventOptions<"parkour">["difficulty"],
        { size: number; gaps: readonly number[]; shift: number; slime: number; vanish: number }
    >
> = {
    easy: { size: 2, gaps: [1, 2], shift: 0, slime: 0.1, vanish: 0 },
    medium: { size: 1, gaps: [1, 2], shift: 1, slime: 0.15, vanish: 0.2 },
    hard: { size: 1, gaps: [2, 3], shift: 1, slime: 0.2, vanish: 0.3 }
};

const CLIMB_CHANCE = 0.15;
const SHIFT_CHANCE: Readonly<Record<EventOptions<"parkour">["difficulty"], number>> = {
    easy: 0,
    medium: 0.12,
    hard: 0.18
};

// ------------------------------------------------------------------ a bounce

/** How fast a player jumps, falls and slows in the air, per game tick. */
const JUMP_SPEED = 0.42;
const GRAVITY = 0.08;
const DRAG = 0.98;
/**
 * How far a player carries across in a game tick in the air: under what a
 * running jump does, so a pad is never laid where only a perfect one makes it.
 */
const AIR_SPEED = 0.25;
/** How far over the next platform's top a bounce must carry the feet. */
const CLEARANCE = 0.5;

/**
 * A jump from a platform `drop` blocks over a slime pad's top onto the pad, and
 * the bounce off it, moved tick by tick as the game moves a player: gravity,
 * then drag, and on the pad the fall turned straight back up (Java Edition's
 * slime block; the wiki has a bounce rise in proportion to the fall and fade
 * quickly, which this reproduces). Answers how high over the pad's top the
 * feet get, and for how many ticks they stay over `rise` blocks above it.
 */
export function bounce(drop: number, rise: number): { apex: number; ticks: number } {
    let y = drop;
    let speed = JUMP_SPEED;
    let bounced = false;
    let apex = 0;
    let ticks = 0;
    for (let tick = 0; tick < 400; tick += 1) {
        const next = y + speed;
        if (!bounced && speed < 0 && next <= 0) {
            y = 0;
            speed = -speed;
            bounced = true;
        } else y = next;
        speed = (speed - GRAVITY) * DRAG;
        if (!bounced) continue;
        ticks += 1;
        apex = Math.max(apex, y);
        if (speed < 0 && y <= rise) break;
    }
    return { apex, ticks };
}

/**
 * Whether a slime pad throws whoever jumps onto it from `before` over onto
 * `after`: high enough to clear its top, and long enough in the air to get
 * across the gap from the middle of the pad.
 */
export function bounceReaches(before: Platform, pad: Platform, after: Platform): boolean {
    const rise = after.y - pad.y;
    const { apex, ticks } = bounce(before.y - pad.y, rise);
    if (apex < rise + CLEARANCE) return false;
    const gap = gapOf(footprint(pad), footprint(after));
    return gap + pad.size / 2 - 0.3 <= ticks * AIR_SPEED;
}

// ------------------------------------------------------------------ what is solid

interface Solid {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
}

function footprint(one: Platform): Solid {
    return {
        x1: one.x,
        y1: one.y,
        z1: one.z,
        x2: one.x + one.size - 1,
        y2: one.y,
        z2: one.z + one.size - 1
    };
}

/** Everything a platform puts in the world: itself, a moving one's other place,
 *  a climb's column and ladder, a checkpoint's lamp, the finish's plate. */
function solidsOf(one: Platform): Solid[] {
    const own = footprint(one);
    const under = one.climb ? 2 : one.role === "checkpoint" || one.role === "finish" ? 1 : 0;
    const out: Solid[] = [{ ...own, y1: own.y1 - under }];
    if (one.trap === "shift") out.push({ ...own, z1: own.z1 - SHIFT_STEP, z2: own.z2 - SHIFT_STEP });
    if (one.climb) {
        const at = one.climb > 0 ? one.x - 1 : one.x + one.size;
        out.push({ x1: at, y1: one.y - 2, z1: own.z1, x2: at, y2: one.y, z2: own.z2 });
    }
    if (one.role === "finish") out.push({ ...own, y1: one.y + 1, y2: one.y + 1 });
    return out;
}

/** Blocks of air between two boxes along one axis: 0 touching, below 0 overlapping. */
function apart(a1: number, a2: number, b1: number, b2: number): number {
    return Math.max(a1 - b2, b1 - a2) - 1;
}

/** The air between two boxes across the ground, diagonals counted as touching. */
function gapOf(a: Solid, b: Solid): number {
    return Math.max(apart(a.x1, a.x2, b.x1, b.x2), apart(a.z1, a.z2, b.z1, b.z2));
}

function overlap(a: Solid, b: Solid): boolean {
    return (
        a.x1 <= b.x2 &&
        b.x1 <= a.x2 &&
        a.y1 <= b.y2 &&
        b.y1 <= a.y2 &&
        a.z1 <= b.z2 &&
        b.z1 <= a.z2
    );
}

/** The space a jump between two platforms passes through, head room included. */
function corridor(from: Platform, to: Platform): Solid {
    const boxes = [from, to].flatMap((one) =>
        one.trap === "shift"
            ? [footprint(one), { ...footprint(one), z1: one.z - SHIFT_STEP }]
            : [footprint(one)]
    );
    return {
        x1: Math.min(...boxes.map((one) => one.x1)),
        y1: Math.min(from.y, to.y) + 1,
        z1: Math.min(...boxes.map((one) => one.z1)),
        x2: Math.max(...boxes.map((one) => one.x2)),
        y2: Math.max(from.y, to.y) + HEAD_ROOM,
        z2: Math.max(...boxes.map((one) => one.z2))
    };
}

const special = (one: Platform | undefined) => Boolean(one?.trap || one?.climb);

/** A jump in the middle of a row with nothing special about it. */
const plainJump = (one: Platform | undefined) =>
    one !== undefined && one.role === "jump" && !one.turn && !special(one);

// ------------------------------------------------------------------ the rules

/**
 * Every rule a course breaks, one line each; empty when it keeps them all.
 * What the tests run over thousands of courses, and what a course is checked
 * against before it is used.
 */
export function layoutProblems(platforms: readonly Platform[]): string[] {
    const problems: string[] = [];
    const solids = platforms.map(solidsOf);
    for (let i = 0; i < platforms.length; i += 1)
        for (let j = i + 1; j < platforms.length; j += 1) {
            const climbing = j === i + 1 && platforms[j]!.climb;
            for (const a of solids[i]!)
                for (const [m, b] of solids[j]!.entries()) {
                    // A climb's ladder (the second of its solids) hangs in the
                    // gap it is climbed from.
                    if (climbing && m === 1) continue;
                    const level = apart(a.y1, a.y2, b.y1, b.y2);
                    if (gapOf(a, b) < 1 && level < HEAD_ROOM)
                        problems.push(`platforms ${i} and ${j} touch`);
                }
        }
    for (let i = 0; i + 1 < platforms.length; i += 1) {
        const room = corridor(platforms[i]!, platforms[i + 1]!);
        solids.forEach((boxes, k) => {
            if (k === i || k === i + 1) return;
            if (boxes.some((box) => overlap(box, room)))
                problems.push(`platform ${k} is in the way of jump ${i + 1}`);
        });
    }
    const marks = platforms.flatMap((one, index) =>
        one.role === "checkpoint" || one.role === "finish" ? [index] : []
    );
    for (let at = 1; at < marks.length; at += 1) {
        const between = marks[at]! - marks[at - 1]!;
        const least = marks[at] === platforms.length - 1 ? FINISH_AFTER : CHECK_EVERY;
        if (between < least) problems.push(`checkpoints ${marks[at - 1]} and ${marks[at]} too close`);
    }
    platforms.forEach((one, index) => {
        if (!special(one)) return;
        if (one.role !== "jump" || one.turn) problems.push(`special ${index} is not a plain jump`);
        if (!plainJump(platforms[index - 1]) || index < 2)
            problems.push(`special ${index} comes right after something else`);
        if (!plainJump(platforms[index + 1]))
            problems.push(`special ${index} comes right before something else`);
        if (one.trap === "slime") {
            const before = platforms[index - 1];
            const after = platforms[index + 1];
            if (!before || !after || !bounceReaches(before, one, after))
                problems.push(`slime pad ${index} throws nobody onto the next platform`);
        }
    });
    return problems;
}

// ------------------------------------------------------------------ laying it out

/** The course laid out around 0 0 0, the rows running between x 0 and `ROW`. */
export function laidOut(options: EventOptions<"parkour">, seed: string): Platform[] {
    for (let draw = 0; draw < DRAWS; draw += 1) {
        const platforms = drawn(options, draw === 0 ? seed : `${seed}#${draw}`, true);
        if (platforms.length === options.jumps + 1 && layoutProblems(platforms).length === 0)
            return platforms;
    }
    // Never seen to happen; a course with nothing special on it keeps every rule.
    return drawn(options, seed, false);
}

function drawn(options: EventOptions<"parkour">, seed: string, specials: boolean): Platform[] {
    const random = seeded(`parkour-${seed}`);
    const step = STEPS[options.difficulty];
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const total = options.jumps;
    const roleOf = (index: number): Role => {
        if (index === total) return "finish";
        if (index % CHECK_EVERY === 0 && index <= total - FINISH_AFTER) return "checkpoint";
        return "jump";
    };
    const sizeOf = (role: Role) => (role === "jump" ? step.size : 3);
    const widest = Math.max(...step.gaps);

    // The start sits before the rows begin, so no row ever passes over it.
    const platforms: Platform[] = [{ x: -6, y: 0, z: 0, size: 5, role: "start" }];
    let direction: 1 | -1 = 1;
    let track = 2;
    let turning = 0;
    /** After a special jump, the next one is plain and stays in the row. */
    let after: Platform | null = null;
    for (let index = 1; index <= total; index += 1) {
        const current = platforms[platforms.length - 1]!;
        const role = roleOf(index);
        const size = sizeOf(role);
        if (turning > 0) {
            // A turn: two steps along +z, one block up each, lined up with the
            // end of the row - then the next row runs back the other way.
            platforms.push({
                x: direction > 0 ? current.x + current.size - size : current.x,
                y: current.y + 1,
                z: current.z + current.size + 1,
                size,
                role,
                turn: true
            });
            turning -= 1;
            if (turning === 0) {
                direction = direction > 0 ? -1 : 1;
                track = platforms[platforms.length - 1]!.z + Math.floor(size / 2);
            }
            continue;
        }
        const xFor = (gap: number) =>
            direction > 0 ? current.x + current.size + gap : current.x - gap - size;
        const fits = (x: number, width = size) => x >= 0 && x + width - 1 <= ROW;
        // A special jump only with a plain one before it and room after it for
        // another plain one in the same row - never next to a turn.
        const roomAfter = (gap: number) => {
            const x = xFor(gap);
            const next = direction > 0 ? x + size + widest : x - widest - step.size;
            return fits(next, step.size);
        };
        const mayBeSpecial =
            specials &&
            after === null &&
            role === "jump" &&
            index >= 2 &&
            plainJump(current) &&
            index + 1 < total &&
            roleOf(index + 1) === "jump";
        const climbing = mayBeSpecial && random() < CLIMB_CHANCE;
        let gap = climbing ? 1 : pick(step.gaps);
        // After a slime pad: as far as its bounce carries, at its height.
        if (after?.trap === "slime") gap = 1;
        const shift =
            !climbing && after === null && role === "jump" && step.shift > 0 && gap < 3
                ? pick([-1, 0, 1])
                : 0;
        const roll = random();
        const x = xFor(gap);
        if (!fits(x)) {
            if (after !== null) return platforms; // broken: drawn again
            turning = 2;
            index -= 1;
            continue;
        }
        const z = track - Math.floor(size / 2);
        if (climbing && roomAfter(gap)) {
            const climb = direction > 0 ? 1 : -1;
            platforms.push({ x, y: current.y + 3, z, size, role, climb });
            after = platforms[platforms.length - 1]!;
            continue;
        }
        const shifting = SHIFT_CHANCE[options.difficulty];
        const trap: Trap | undefined =
            !mayBeSpecial || climbing || !roomAfter(gap)
                ? undefined
                : roll < step.vanish
                  ? "vanish"
                  : roll < step.vanish + step.slime
                    ? "slime"
                    : roll < step.vanish + step.slime + shifting
                      ? "shift"
                      : undefined;
        platforms.push({
            x,
            y: current.y,
            z: z + (trap === "shift" ? 0 : shift),
            size,
            role,
            ...(trap ? { trap } : {})
        });
        after = trap ? platforms[platforms.length - 1]! : null;
    }
    return platforms;
}
