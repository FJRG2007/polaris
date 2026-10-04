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

import { seeded, shuffled } from "../trivia-bank";
import type { EventOptions, PARKOUR_SHAPES } from "../catalog";
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
    if (one.trap === "shift")
        out.push({ ...own, z1: own.z1 - SHIFT_STEP, z2: own.z2 - SHIFT_STEP });
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
        a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2 && a.z1 <= b.z2 && b.z1 <= a.z2
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
        if (between < least)
            problems.push(`checkpoints ${marks[at - 1]} and ${marks[at]} too close`);
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
// ------------------------------------------------------------------ nothing skipped (design 4)

/**
 * How far a player carries across in one jump, as air between two platforms
 * the way `gapOf` counts it, by how much higher the landing is than the
 * take-off. What a sprint jump does in Java Edition - four blocks of air on the
 * level, three one up, none two up - and a little more falling: generous on
 * purpose, since anything a player could reach past the next platform is a
 * part of the course skipped, and erring long only spreads a course out.
 */
export function reachAcross(rise: number): number {
    if (rise >= 2) return -1;
    if (rise === 1) return 3;
    if (rise === 0) return 4;
    if (rise === -1) return 5;
    return 5 + Math.min(2, -rise - 1);
}

/** Where a platform can be stood on: a moving one at either of its places. */
function places(one: Platform): Solid[] {
    const own = footprint(one);
    return one.trap === "shift"
        ? [own, { ...own, z1: own.z1 - SHIFT_STEP, z2: own.z2 - SHIFT_STEP }]
        : [own];
}

/**
 * Whether whoever stands on `from` can land on `to` in one jump. Off a slime
 * pad (landed on from `before`) the bounce lifts them first, and carries them
 * a block further.
 */
export function reaches(from: Platform, to: Platform, before?: Platform): boolean {
    let lift = 0;
    let further = 0;
    if (from.trap === "slime" && before) {
        lift = Math.floor(bounce(before.y - from.y, 0).apex);
        further = 1;
    }
    for (const a of places(from))
        for (const b of places(to)) {
            const reach = reachAcross(b.y1 - a.y1 - lift);
            if (reach >= 0 && gapOf(a, b) <= reach + further) return true;
        }
    return false;
}

/**
 * Every platform that can be reached from one more than a step before it:
 * a part of the course that can be skipped. Empty for a course that keeps
 * every player on every platform.
 */
export function skipProblems(platforms: readonly Platform[]): string[] {
    const problems: string[] = [];
    for (let i = 0; i < platforms.length; i += 1)
        for (let j = i + 2; j < platforms.length; j += 1)
            if (reaches(platforms[i]!, platforms[j]!, platforms[i - 1]))
                problems.push(`platform ${j} can be reached from ${i}`);
    return problems;
}

/** The shapes a course can take (`PARKOUR_SHAPES`). */
export type Shape = (typeof PARKOUR_SHAPES)[number];

/** How far a tower's side runs before it turns the corner. */
export const TOWER_SIDE = 10;

type Heading = "east" | "south" | "west" | "north";

/** The heading after a tower's corner, turning the same way every time. */
const NEXT_HEADING: Readonly<Record<Heading, Heading>> = {
    east: "south",
    south: "west",
    west: "north",
    north: "east"
};

/**
 * How much higher each jump lands, drawn: a rows course climbs, levels off and
 * now and then drops a block; a tower only climbs or levels off, so each lap
 * stands clear over the one under it.
 */
const RISES: Readonly<Record<Shape, readonly number[]>> = {
    rows: [1, 1, 1, 1, 0, 0, 0, 0, -1, -1],
    tower: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0]
};

/**
 * The air a jump that is meant to be made may leave, by how much higher it
 * lands: two blocks on the level or down (three on the hard course), two going
 * a block up (one on the easy course) - well inside `reachAcross`, so every
 * jump is one a player makes without a perfect run.
 */
function doable(rise: number, difficulty: EventOptions<"parkour">["difficulty"]): number {
    if (rise >= 2) return -1;
    if (rise === 1) return difficulty === "easy" ? 1 : 2;
    return difficulty === "hard" ? 3 : 2;
}

/** The problems a course has that involve its last platform: the rules, checked as it is laid. */
function problemsOfLast(platforms: readonly Platform[]): boolean {
    const last = platforms.length - 1;
    const one = platforms[last]!;
    const mine = solidsOf(one);
    for (let i = 0; i < last; i += 1) {
        const climbing = i === last - 1 && one.climb;
        for (const a of solidsOf(platforms[i]!))
            for (const [m, b] of mine.entries()) {
                if (climbing && m === 1) continue;
                if (gapOf(a, b) < 1 && apart(a.y1, a.y2, b.y1, b.y2) < HEAD_ROOM) return true;
            }
    }
    // Nothing in the way of the new jump, and nothing new in the way of an old one.
    if (last >= 1) {
        const room = corridor(platforms[last - 1]!, one);
        for (let k = 0; k < last - 1; k += 1)
            if (solidsOf(platforms[k]!).some((box) => overlap(box, room))) return true;
    }
    for (let i = 0; i + 1 < last; i += 1) {
        const room = corridor(platforms[i]!, platforms[i + 1]!);
        if (mine.some((box) => overlap(box, room))) return true;
    }
    // Out of reach from everything but the platform before it.
    for (let i = 0; i < last - 1; i += 1)
        if (reaches(platforms[i]!, one, platforms[i - 1])) return true;
    // Thrown onto by the slime pad before it, when there is one.
    const pad = platforms[last - 1];
    if (pad?.trap === "slime" && !bounceReaches(platforms[last - 2]!, pad, one)) return true;
    return false;
}

/**
 * A course laid out the way design 4 does it, a jump at a time: each jump
 * tried at every gap, rise and step aside the difficulty allows, in an order
 * drawn from the seed, and kept only where it breaks no rule - nothing
 * touches, nothing in the way, nothing but the next platform within a jump of
 * any platform. A jump with nowhere to go takes back the one before and tries
 * that one's next place (a corner or a turn often needs the jump before it to
 * have climbed), within a budget; past it, the course is drawn again.
 */
export function walked(options: EventOptions<"parkour">, seed: string, shape: Shape): Platform[] {
    for (let draw = 0; draw < WALK_DRAWS; draw += 1) {
        const platforms = walk(options, draw === 0 ? seed : `${seed}#${draw}`, shape, true);
        if (platforms && keepsEveryRule(platforms, options.jumps)) return platforms;
    }
    return staircase(options, seed, shape);
}

/** Whether a whole course keeps the layout rules and leaves nothing to skip. */
function keepsEveryRule(platforms: readonly Platform[], jumps: number): boolean {
    return (
        platforms.length === jumps + 1 &&
        layoutProblems(platforms).length === 0 &&
        skipProblems(platforms).length === 0
    );
}

/** How many times a course is drawn again before it is laid out as a staircase. */
const WALK_DRAWS = 8;
/** How many places a draw may try in all before it is given up. */
const WALK_BUDGET = 20_000;

/**
 * The course nothing can go wrong with, for a seed that never draws one: every
 * jump a block up, so the platform after next is always two up - out of
 * anybody's reach. Laid out as design 3 did, should even that break a rule.
 */
export function staircase(
    options: EventOptions<"parkour">,
    seed: string,
    shape: Shape
): Platform[] {
    const plain = { ...options, difficulty: "easy" as const };
    const stairs = walk(plain, "staircase", shape, false, [1]);
    return stairs && keepsEveryRule(stairs, options.jumps) ? stairs : laidOut(options, seed);
}

/** The line each side of a tower runs along: z going east or west, x going south or north. */
const TOWER_LINE: Readonly<Record<Heading, number>> = {
    east: 0,
    south: TOWER_SIDE,
    west: TOWER_SIDE,
    north: 0
};

/** Where the walk stands before a jump: which way it goes, and what it must do next. */
interface WalkState {
    readonly heading: Heading;
    /** A rows course: the z its row runs along, and which way the row runs. */
    readonly rowLine: number;
    readonly row: "east" | "west";
    /** A rows course: the steps of its turn still to take. */
    readonly turnLeft: number;
    /** The special jump just laid, which the next one must follow plainly. */
    readonly after: Platform | null;
}

interface Candidate {
    readonly platform: Platform;
    readonly next: WalkState;
}

function walk(
    options: EventOptions<"parkour">,
    seed: string,
    shape: Shape,
    specials: boolean,
    rises: readonly number[] = RISES[shape]
): Platform[] | null {
    const random = seeded(`parkour-${shape}-${seed}`);
    const step = STEPS[options.difficulty];
    const total = options.jumps;
    const roleOf = (index: number): Role => {
        if (index === total) return "finish";
        if (index % CHECK_EVERY === 0 && index <= total - FINISH_AFTER) return "checkpoint";
        return "jump";
    };
    const sizeOf = (role: Role) => (role === "jump" ? step.size : 3);
    const once = <T>(list: readonly T[]): T[] =>
        shuffled(list, random).filter((one, at, all) => all.indexOf(one) === at);
    const gaps = [...new Set([...step.gaps, 1, 2])].filter((gap) => gap <= 3);

    const lineOf = (state: WalkState, way: Heading) =>
        shape === "tower" ? TOWER_LINE[way] : state.rowLine;
    const along = (
        current: Platform,
        state: WalkState,
        size: number,
        role: Role,
        gap: number,
        rise: number,
        aside: number,
        way: Heading
    ): Platform => {
        const y = current.y + rise;
        const cross = lineOf(state, way) - Math.floor(size / 2) + aside;
        if (way === "east") return { x: current.x + current.size + gap, y, z: cross, size, role };
        if (way === "west") return { x: current.x - gap - size, y, z: cross, size, role };
        if (way === "south") return { x: cross, y, z: current.z + current.size + gap, size, role };
        return { x: cross, y, z: current.z - gap - size, size, role };
    };
    const inside = (one: Platform, way: Heading): boolean => {
        if (shape === "rows") return one.x >= 0 && one.x + one.size - 1 <= ROW;
        if (way === "east") return one.x + one.size - 1 <= TOWER_SIDE;
        if (way === "south") return one.z + one.size - 1 <= TOWER_SIDE;
        if (way === "west") return one.x >= 0;
        return one.z >= 0;
    };
    /** Far enough along its row or side to turn: never a row of a jump or two. */
    const farAlong = (current: Platform, state: WalkState): boolean => {
        const half = (shape === "rows" ? ROW : TOWER_SIDE) / 2;
        if (state.heading === "east") return current.x + current.size >= half;
        if (state.heading === "west") return current.x <= half;
        if (state.heading === "south") return current.z + current.size >= half;
        return current.z <= half;
    };

    /** A step of a rows course's turn: along +z, lined up with the end of the row. */
    const turnSteps = (current: Platform, state: WalkState, size: number, role: Role) => {
        const out: Candidate[] = [];
        const left = state.turnLeft > 0 ? state.turnLeft : 2;
        for (const rise of once([1, 1, 0].filter((one) => rises.includes(one))))
            for (const gap of once([1, 2])) {
                if (gap > doable(rise, options.difficulty)) continue;
                const platform: Platform = {
                    x: state.row === "east" ? current.x + current.size - size : current.x,
                    y: current.y + rise,
                    z: current.z + current.size + gap,
                    size,
                    role,
                    turn: true
                };
                const done = left === 1;
                const row = done ? (state.row === "east" ? "west" : "east") : state.row;
                out.push({
                    platform,
                    next: {
                        heading: done ? row : "south",
                        row,
                        rowLine: done ? platform.z + Math.floor(size / 2) : state.rowLine,
                        turnLeft: left - 1,
                        after: null
                    }
                });
            }
        return out;
    };

    const candidatesFor = (index: number, current: Platform, state: WalkState): Candidate[] => {
        const role = roleOf(index);
        const size = sizeOf(role);
        if (shape === "rows" && state.turnLeft > 0) return turnSteps(current, state, size, role);
        const slimeAfter = state.after?.trap === "slime";
        const plain: Candidate[] = [];
        // After a slime pad: where its bounce carries, level with it or a block down.
        const tryRises = slimeAfter ? once([0, -1]) : once(rises);
        const tryGaps = slimeAfter ? once([1, 2]) : once(gaps);
        const asides =
            state.after === null && role === "jump" && step.shift > 0 && shape === "rows"
                ? once([0, 0, -1, 1])
                : [0];
        const next: WalkState = { ...state, after: null };
        for (const rise of tryRises)
            for (const gap of tryGaps) {
                if (!slimeAfter && gap > doable(rise, options.difficulty)) continue;
                for (const aside of asides) {
                    const one = along(current, state, size, role, gap, rise, aside, state.heading);
                    if (inside(one, state.heading)) plain.push({ platform: one, next });
                }
            }
        // A special jump keeps a plain one after it, in its row.
        const turns: Candidate[] = [];
        if (state.after === null && (plain.length === 0 || farAlong(current, state))) {
            if (shape === "rows") turns.push(...turnSteps(current, state, size, role));
            else {
                const way = NEXT_HEADING[state.heading];
                for (const rise of once(rises))
                    for (const gap of once(gaps)) {
                        if (gap > doable(rise, options.difficulty)) continue;
                        const one = along(current, state, size, role, gap, rise, 0, way);
                        if (inside(one, way))
                            turns.push({
                                platform: { ...one, turn: true },
                                next: { ...next, heading: way }
                            });
                    }
            }
        }
        // Now and then a plain jump in the middle of a row is more than a jump:
        // tried first, the plain ones after.
        const mayBeSpecial =
            specials &&
            state.after === null &&
            role === "jump" &&
            index >= 2 &&
            plainJump(current) &&
            index + 1 < total &&
            roleOf(index + 1) === "jump";
        const special: Candidate[] = [];
        if (mayBeSpecial && plain.length > 0) {
            const sideways =
                shape === "rows" && (state.heading === "east" || state.heading === "west");
            const roll = random();
            if (sideways && roll < CLIMB_CHANCE) {
                const up: Platform = {
                    ...along(current, state, size, role, 1, 3, 0, state.heading),
                    climb: state.heading === "east" ? 1 : -1
                };
                if (inside(up, state.heading))
                    special.push({ platform: up, next: { ...next, after: up } });
            } else {
                const pick = random();
                const shifting = sideways ? SHIFT_CHANCE[options.difficulty] : 0;
                const trap: Trap | undefined =
                    pick < step.vanish
                        ? "vanish"
                        : pick < step.vanish + step.slime
                          ? "slime"
                          : pick < step.vanish + step.slime + shifting
                            ? "shift"
                            : undefined;
                if (trap)
                    for (const one of plain) {
                        const base = one.platform;
                        // A pad level with the jump before it would leave the
                        // platform after it in reach from there: one a block up.
                        if (trap === "slime" && base.y - current.y !== 1) continue;
                        if (
                            trap === "shift" &&
                            base.z !== lineOf(state, state.heading) - Math.floor(size / 2)
                        )
                            continue;
                        const changed: Platform = { ...base, trap };
                        special.push({ platform: changed, next: { ...next, after: changed } });
                    }
            }
        }
        return [...special, ...plain, ...turns];
    };

    const platforms: Platform[] = [
        shape === "tower"
            ? { x: -6, y: 0, z: -2, size: 5, role: "start" }
            : { x: -6, y: 0, z: 0, size: 5, role: "start" }
    ];
    const states: WalkState[] = [
        {
            heading: "east",
            row: "east",
            rowLine: shape === "tower" ? 0 : 2,
            turnLeft: 0,
            after: null
        }
    ];
    const levels: ({ list: Candidate[]; at: number } | undefined)[] = [];
    let budget = WALK_BUDGET;
    let index = 1;
    while (index <= total) {
        const current = platforms[index - 1]!;
        const level = (levels[index] ??= {
            list: candidatesFor(index, current, states[index - 1]!),
            at: 0
        });
        let placed = false;
        while (level.at < level.list.length) {
            budget -= 1;
            if (budget < 0) return null;
            const candidate = level.list[level.at]!;
            level.at += 1;
            platforms.push(candidate.platform);
            if (!problemsOfLast(platforms)) {
                states[index] = candidate.next;
                placed = true;
                break;
            }
            platforms.pop();
        }
        if (placed) {
            index += 1;
            continue;
        }
        // Nowhere to go from here: the jump before takes its next place.
        levels[index] = undefined;
        if (index === 1) return null;
        platforms.pop();
        index -= 1;
    }
    return platforms;
}
