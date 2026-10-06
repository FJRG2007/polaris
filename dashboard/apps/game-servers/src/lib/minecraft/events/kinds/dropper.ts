/**
 * A dropper: a shaft floating over a site, walled all round, with `levels` floors
 * across it - each with one hole in it - and a pool of water at the bottom. The
 * players start on a glass lid at the top; at "Go!" the lid goes and they fall.
 * Landing on a floor sends a player back to the top; reaching the water finishes.
 * The fastest into the water wins, then whoever got deepest.
 *
 * Laid out from the run's id (`plan`), so every run is a new shaft and a restart
 * works out the same one, and checked against rules before it is built
 * (`planProblems`):
 *
 * - **Every hole can be reached from the one above, falling.** A falling player
 *   steers with the air control the game gives them, and how far they can move
 *   sideways depends on how long they fall from one floor to the next
 *   (`reachIn`, `fallTicks`). Each floor is put far enough under the last that
 *   even a cautious player - walking, never sprinting, setting off from a
 *   standstill only once their head is clear of the floor above - gets over the
 *   next hole and comes to a stop there, with a quarter of a block to spare. A
 *   player simulated tick by tick, steering that way, makes every floor of
 *   thousands of shafts (the tests).
 * - **No hole lines up with the next**: falling straight down through one always
 *   lands on the next floor, so every floor has to be steered through.
 * - **Harder means smaller holes and further to go** between two of them
 *   (`STEPS`).
 *
 * The physics, from the Minecraft Wiki ("Entity", motion of entities; "Slow
 * Falling") and the Minecraft Parkour Wiki ("Horizontal Movement Formulas"),
 * in blocks and game ticks, Java Edition:
 * - each tick the player moves by their velocity, then gravity is added, then
 *   drag: vertically `v = (v - g) * 0.98`, horizontally `v = v * 0.91`;
 * - gravity `g` is 0.08, or 0.01 with Slow Falling (terminal speed 3.92 and 0.49
 *   blocks a tick);
 * - in the air, holding a direction adds 0.02 x 0.98 = 0.0196 a tick walking
 *   (0.026 sprinting) to the horizontal velocity, before it moves;
 * - a player is 0.6 wide and 1.8 tall.
 *
 * In a free fall the player is over three blocks a tick within seven seconds, and
 * the sideways reach between two floors a few blocks apart falls to a tenth of a
 * block: holes that do not line up could not be reached in any shaft that fits
 * under the build limit (twenty floors would need over five hundred blocks). So
 * the shaft is played under Slow Falling, given to everybody inside as Resistance
 * is: the fall is a steady half a block a tick, there is time to steer, and no
 * fall can hurt anybody.
 *
 * That pace makes a fall long: twenty blocks take four seconds, and four
 * seconds in the air is what the server allows before it disconnects a player
 * for flying - every racer let go from the top was kicked at the same height,
 * twenty blocks down. So from "Go!" each racer's own gravity is brought down to
 * Slow Falling's (`stage.lightFallLines`), which leaves the fall as it is and
 * gives them thirty-two seconds; the deepest shaft is under twenty-seven (the
 * tests).
 *
 * Pure: the plan, the boxes and the lines are functions of what they are given.
 */

import type { EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";
import { seeded, shuffled } from "../trivia-bank";

export type Difficulty = EventOptions<"dropper">["difficulty"];

/** How shafts are laid out now, written onto the stage when one is built. */
export const DESIGN = 1;

/** Blocks from the middle of the shaft to its inside wall: the inside is 11 by 11. */
export const HALF = 5;
const INNER = 2 * HALF + 1;
/** Blocks of floor kept between a hole and the wall: room for the hole's light ring. */
const MARGIN = 1;
/** The fewest blocks from one floor to the next: room to fall, and head room. */
export const LEAST_GAP = 5;
/** Air between the last floor and the water, and the water's depth. */
const LAST_GAP = 4;
const POOL_DEPTH = 3;
/** How high the wall rises over the lid. */
const RAIL = 3;
/** How far over the ground the bottom of the shaft is put. */
export const LIFT = 6;

/**
 * Each difficulty: the size of its holes, and how far a player has to move
 * sideways from where they passed one hole to where they pass the next, in
 * blocks (`Level.need`).
 */
export const STEPS: Readonly<Record<Difficulty, { hole: number; least: number; most: number }>> = {
    easy: { hole: 3, least: 0.6, most: 1.0 },
    medium: { hole: 2, least: 0.9, most: 1.3 },
    hard: { hole: 1, least: 1.0, most: 1.45 }
};

/** How much further than needed the cautious reach must go: a margin for a late start. */
const SPARE = 0.25;
/** How far inside a hole's edge a careful player passes it, besides their own
 *  half width: room for an aim a little off. */
const ROOM = 0.15;
/** Below this a player is taken as still. */
const STILL = 0.02;

// ------------------------------------------------------------------ physics

/** Player physics, in blocks and ticks (see the module's notes). */
export const PHYSICS = {
    /** Gravity under Slow Falling. */
    gravity: 0.01,
    verticalDrag: 0.98,
    horizontalDrag: 0.91,
    /** Walking, in the air, holding one direction: 0.02 x 0.98. */
    airAcceleration: 0.0196,
    width: 0.6,
    height: 1.8
} as const;

/** One tick of sideways motion: the push (1 forward, -1 back, or between), then
 *  the move, then the drag. Answers the new speed and how far it moved. */
export function airTick(speed: number, push: number): { speed: number; moved: number } {
    const next = speed + push * PHYSICS.airAcceleration;
    return { speed: next * PHYSICS.horizontalDrag, moved: next };
}

const reaches = new Map<string, number>();

/**
 * How far sideways a player gets in `ticks` from a standstill, walking in the
 * air, and still again by the end - pushing forward for a while, then back:
 * the best such split. Still, because a player who is still moving as they
 * reach a hole drifts on while passing through it, and a small one leaves no
 * room for that.
 */
export function reachIn(ticks: number): number {
    const key = String(ticks);
    const kept = reaches.get(key);
    if (kept !== undefined) return kept;
    let best = 0;
    for (let forward = 0; forward <= ticks; forward += 1) {
        let speed = 0;
        let moved = 0;
        for (let tick = 0; tick < ticks; tick += 1) {
            // Back only as hard as it takes to stop, never past it.
            const push = tick < forward ? 1 : -Math.min(1, speed / PHYSICS.airAcceleration);
            const step = airTick(speed, push);
            speed = step.speed;
            moved += step.moved;
        }
        if (speed <= STILL) best = Math.max(best, moved);
    }
    reaches.set(key, best);
    return best;
}

/** A fall followed tick by tick: feet height and downward speed (negative). */
export interface Fall {
    y: number;
    velocity: number;
}

export function fallTick(fall: Fall): Fall {
    return {
        y: fall.y + fall.velocity,
        velocity: (fall.velocity - PHYSICS.gravity) * PHYSICS.verticalDrag
    };
}

/**
 * The ticks a player has to steer between leaving one floor and meeting the
 * next: from when their head is under the floor above (`clear`: they cannot
 * move outside its hole before) to when their feet reach the next floor's top
 * (`land`). Answers the ticks, and the fall as it is at `land`.
 */
export function fallTicks(from: Fall, clear: number, land: number): { ticks: number; fall: Fall } {
    let fall = from;
    let steps = 0;
    let free = 0;
    while (fall.y > land && steps < 10_000) {
        if (fall.y + PHYSICS.height <= clear) free += 1;
        fall = fallTick(fall);
        steps += 1;
    }
    return { ticks: free, fall };
}

// ------------------------------------------------------------------ the plan

/** A hole, by its lowest corner inside the shaft (0 to 10 each way) and its size. */
export interface Hole {
    readonly x: number;
    readonly z: number;
    readonly size: number;
}

/** A point inside the shaft, in blocks from its inside corner. */
export interface Point {
    readonly x: number;
    readonly z: number;
}

/** One floor: how far under the one above it is (the lid for the first), and its hole. */
export interface Level {
    readonly drop: number;
    readonly hole: Hole;
    /** Where a careful player passes the hole: its nearest point, with room all
     *  round, to where they passed the one above. */
    readonly through: Point;
    /** How far that is, sideways, from where they passed the one above. */
    readonly need: number;
    /** How far the cautious fall reaches over its drop. */
    readonly reach: number;
}

export interface Plan {
    readonly difficulty: Difficulty;
    readonly levels: readonly Level[];
    /** From the lid down to the pool's floor. */
    readonly depth: number;
}

/** Where a player is let fall from: the middle of the shaft. */
export const SPAWN: Point = { x: HALF + 0.5, z: HALF + 0.5 };

/** Where a player's middle can be, passing through a hole without touching it,
 *  with `ROOM` to spare all round - for a hole of one, its very middle. */
export function passable(hole: Hole): { x1: number; x2: number; z1: number; z2: number } {
    const room = Math.min(PHYSICS.width / 2 + ROOM, hole.size / 2);
    return {
        x1: hole.x + room,
        x2: hole.x + hole.size - room,
        z1: hole.z + room,
        z2: hole.z + hole.size - room
    };
}

/** The nearest point of a hole's passable area to `from`. */
function nearest(from: Point, hole: Hole): Point {
    const area = passable(hole);
    return {
        x: Math.min(area.x2, Math.max(area.x1, from.x)),
        z: Math.min(area.z2, Math.max(area.z1, from.z))
    };
}

function needFrom(from: Point, hole: Hole): number {
    const to = nearest(from, hole);
    return Math.hypot(to.x - from.x, to.z - from.z);
}

/** Two holes overlap, looked at from above. */
function overlaps(a: Hole, b: Hole): boolean {
    return a.x < b.x + b.size && b.x < a.x + a.size && a.z < b.z + b.size && b.z < a.z + a.size;
}

/** A hole is inside the floor, with room for its ring round it. */
function fits(hole: Hole): boolean {
    return (
        hole.x >= MARGIN &&
        hole.z >= MARGIN &&
        hole.x + hole.size <= INNER - MARGIN &&
        hole.z + hole.size <= INNER - MARGIN
    );
}

/** Lines up with the one before: some way down through both without steering.
 *  For the first floor, whether falling straight from the spawn goes through. */
function linesUp(before: Hole | null, hole: Hole): boolean {
    if (before) return overlaps(before, hole);
    const half = PHYSICS.width / 2;
    return (
        SPAWN.x - half >= hole.x &&
        SPAWN.x + half <= hole.x + hole.size &&
        SPAWN.z - half >= hole.z &&
        SPAWN.z + half <= hole.z + hole.size
    );
}

/**
 * The fewest blocks under the floor above (or the lid) a floor can be for its
 * hole to be reached by the cautious fall, given how the fall is going when it
 * leaves the floor above. Answers the drop, the reach over it, and the fall as
 * it meets the new floor.
 */
function dropFor(
    fall: Fall,
    above: number,
    need: number
): { drop: number; reach: number; fall: Fall } {
    for (let drop = LEAST_GAP; ; drop += 1) {
        // The floor above's underside is at `above`; the new floor's top is
        // `drop - 1` under that.
        const passed = fallTicks(fall, above, above - drop + 1);
        const reach = reachIn(passed.ticks);
        if (reach >= need + SPARE || drop > 200) return { drop, reach, fall: passed.fall };
    }
}

/**
 * The shaft for a run: its holes drawn from the run's id, each where it keeps
 * the rules from the one above, and each floor as far down as its hole needs.
 * Heights are counted from the lid, downward negative.
 */
export function plan(
    options: Pick<EventOptions<"dropper">, "levels" | "difficulty">,
    seed: string
): Plan {
    const step = STEPS[options.difficulty];
    const random = seeded(`dropper-${seed}`);
    const spots: Hole[] = [];
    for (let x = 0; x < INNER; x += 1)
        for (let z = 0; z < INNER; z += 1) {
            const hole = { x, z, size: step.hole };
            if (fits(hole)) spots.push(hole);
        }
    const levels: Level[] = [];
    // A player let go standing on the lid (0), still. The lid is gone by then,
    // but they are counted as steering only once their head is under where it
    // was, as under every floor after it.
    let fall: Fall = { y: 1, velocity: 0 };
    let above = 0;
    let before: Hole | null = null;
    let from = SPAWN;
    for (let index = 0; index < options.levels; index += 1) {
        const choices = shuffled(spots, random).filter((hole) => {
            if (linesUp(before, hole)) return false;
            const need = needFrom(from, hole);
            return need >= step.least && need <= step.most;
        });
        // Never empty in an 11 by 11 shaft (measured over thousands of runs);
        // the nearest that does not line up, should it ever be.
        const hole =
            choices[0] ??
            spots
                .filter((one) => !linesUp(before, one))
                .sort((a, b) => needFrom(from, a) - needFrom(from, b))[0]!;
        const through = nearest(from, hole);
        const need = needFrom(from, hole);
        const found = dropFor(fall, above, need);
        levels.push({ drop: found.drop, hole, through, need, reach: found.reach });
        fall = found.fall;
        above -= found.drop;
        before = hole;
        from = through;
    }
    const depth = levels.reduce((sum, one) => sum + one.drop, 0) + LAST_GAP + POOL_DEPTH + 1;
    return { difficulty: options.difficulty, levels, depth };
}

/**
 * What is wrong with a plan, as sentences: nothing when it keeps every rule. The
 * way through and the reach are worked out again here from the holes and the
 * floors' heights, not taken from the plan.
 */
export function planProblems(shaft: Plan): string[] {
    const problems: string[] = [];
    const step = STEPS[shaft.difficulty];
    let fall: Fall = { y: 1, velocity: 0 };
    let above = 0;
    let before: Hole | null = null;
    let from = SPAWN;
    shaft.levels.forEach((level, index) => {
        const where = `floor ${index + 1}`;
        if (level.hole.size !== step.hole) problems.push(`${where}: a hole of ${level.hole.size}`);
        if (!fits(level.hole)) problems.push(`${where}: its hole is not inside the floor`);
        if (linesUp(before, level.hole)) problems.push(`${where}: its hole lines up with the last`);
        const need = needFrom(from, level.hole);
        if (need < step.least - 1e-9 || need > step.most + 1e-9)
            problems.push(`${where}: ${need.toFixed(2)} blocks to move`);
        if (level.drop < LEAST_GAP) problems.push(`${where}: only ${level.drop} under the last`);
        const passed = fallTicks(fall, above, above - level.drop + 1);
        const reach = reachIn(passed.ticks);
        if (reach < need + SPARE - 1e-9)
            problems.push(`${where}: reaches ${reach.toFixed(2)} of ${need.toFixed(2)}`);
        fall = passed.fall;
        above -= level.drop;
        before = level.hole;
        from = nearest(from, level.hole);
    });
    return problems;
}
// ------------------------------------------------------------------ the shaft

/** The floors' colors, top first, one after another down the shaft: the band each
 *  floor makes round the outside, and a way to tell how deep you are. */
const COLORS: readonly Box["block"][] = [
    "minecraft:red_concrete",
    "minecraft:orange_concrete",
    "minecraft:yellow_concrete",
    "minecraft:lime_concrete",
    "minecraft:green_concrete",
    "minecraft:cyan_concrete",
    "minecraft:light_blue_concrete",
    "minecraft:blue_concrete",
    "minecraft:purple_concrete",
    "minecraft:magenta_concrete",
    "minecraft:pink_concrete"
];
const WALL: Box["block"] = "minecraft:white_concrete";
const LID: Box["block"] = "minecraft:glass";
/** A ring of light round every hole: it lights the floor, and shows the way down. */
const RING: Box["block"] = "minecraft:sea_lantern";
const POOL_FLOOR: Box["block"] = "minecraft:light_blue_concrete";
export const WATER: Box["block"] = "minecraft:water";

export interface Shaft {
    readonly plan: Plan;
    readonly center: { readonly x: number; readonly z: number };
    /** The lid's height: players stand on it until "Go!". */
    readonly top: number;
    /** Each floor's height, top first. */
    readonly floors: readonly number[];
    /** The water's surface: a player whose feet are under it is in. */
    readonly water: number;
    /** The pool's floor: the lowest block. */
    readonly bottom: number;
    /** Each floor's hole, as world blocks. */
    readonly holes: readonly { x1: number; z1: number; x2: number; z2: number }[];
    /** The lid's box, taken out at "Go!". */
    readonly lid: Box;
    /** What is built, in order: what holds something up before it. */
    readonly boxes: readonly Box[];
    readonly volume: Volume;
    readonly reach: number;
}

/** A floor of `block` over a square, but for the square `cut` out of it: four strips. */
function around(
    square: { x1: number; z1: number; x2: number; z2: number },
    cut: { x1: number; z1: number; x2: number; z2: number },
    y: number,
    block: Box["block"]
): Box[] {
    const strips: Box[] = [
        { x1: square.x1, y1: y, z1: square.z1, x2: square.x2, y2: y, z2: cut.z1 - 1, block },
        { x1: square.x1, y1: y, z1: cut.z2 + 1, x2: square.x2, y2: y, z2: square.z2, block },
        { x1: square.x1, y1: y, z1: cut.z1, x2: cut.x1 - 1, y2: y, z2: cut.z2, block },
        { x1: cut.x2 + 1, y1: y, z1: cut.z1, x2: square.x2, y2: y, z2: cut.z2, block }
    ];
    return strips.filter((box) => box.x1 <= box.x2 && box.z1 <= box.z2);
}

/** The four sides of the wall, a block outside the inside square, from `from` to `to` high. */
function walls(x: number, z: number, from: number, to: number, block: Box["block"]): Box[] {
    const outer = HALF + 1;
    if (from > to) return [];
    return [
        { x1: x - outer, y1: from, z1: z - outer, x2: x + outer, y2: to, z2: z - outer, block },
        { x1: x - outer, y1: from, z1: z + outer, x2: x + outer, y2: to, z2: z + outer, block },
        { x1: x - outer, y1: from, z1: z - HALF, x2: x - outer, y2: to, z2: z + HALF, block },
        { x1: x + outer, y1: from, z1: z - HALF, x2: x + outer, y2: to, z2: z + HALF, block }
    ];
}

/**
 * The shaft over a site, its pool's floor at `y`. Every floor reaches out under
 * the wall, so it shows round the outside as a band of its color; the wall
 * stands between them, a light ring round each hole, glass over the top. Built
 * from the bottom up, the water last - so what holds it in is there first, and,
 * taken out latest first, the water goes before anything that holds it.
 */
export function shaft(
    options: Pick<EventOptions<"dropper">, "levels" | "difficulty">,
    seed: string,
    site: { x: number; z: number },
    y: number
): Shaft {
    const laid = plannedOnce(options, seed);
    const { x, z } = site;
    const outer = HALF + 1;
    const top = y + laid.depth;
    const floors: number[] = [];
    let at = top;
    for (const level of laid.levels) {
        at -= level.drop;
        floors.push(at);
    }
    const water = y + POOL_DEPTH;
    const whole = { x1: x - outer, z1: z - outer, x2: x + outer, z2: z + outer };
    const inside = { x1: x - HALF, z1: z - HALF, x2: x + HALF, z2: z + HALF };
    const holes = laid.levels.map(({ hole }) => ({
        x1: x - HALF + hole.x,
        z1: z - HALF + hole.z,
        x2: x - HALF + hole.x + hole.size - 1,
        z2: z - HALF + hole.z + hole.size - 1
    }));
    const boxes: Box[] = [{ ...whole, y1: y, y2: y, block: POOL_FLOOR }];
    // The wall from the pool up to the lowest floor, then between each two.
    const heights = [...floors].reverse();
    boxes.push(...walls(x, z, y + 1, heights[0]! - 1, WALL));
    heights.forEach((floor, index) => {
        const level = floors.length - 1 - index;
        const hole = holes[level]!;
        const ring = { x1: hole.x1 - 1, z1: hole.z1 - 1, x2: hole.x2 + 1, z2: hole.z2 + 1 };
        boxes.push(
            ...around(whole, ring, floor, COLORS[level % COLORS.length]!),
            ...around(ring, hole, floor, RING),
            ...walls(x, z, floor + 1, (heights[index + 1] ?? top) - 1, WALL)
        );
    });
    // The lid reaches under the wall too; the rail stands on it.
    const lid: Box = { ...inside, y1: top, y2: top, block: LID };
    boxes.push(
        ...around(whole, { ...inside }, top, WALL),
        lid,
        ...walls(x, z, top + 1, top + RAIL, WALL),
        ...[
            [x - outer, z - outer],
            [x + outer, z - outer],
            [x - outer, z + outer],
            [x + outer, z + outer]
        ].map(([cx, cz]) => ({
            x1: cx!,
            y1: top + RAIL + 1,
            z1: cz!,
            x2: cx!,
            y2: top + RAIL + 1,
            z2: cz!,
            block: RING
        })),
        { ...inside, y1: y + 1, y2: water, block: WATER }
    );
    return {
        plan: laid,
        center: { x, z },
        top,
        floors,
        water,
        bottom: y,
        holes,
        lid,
        boxes,
        volume: { ...whole, y1: y, y2: top + RAIL + 2 },
        reach: Math.ceil(Math.SQRT2 * outer)
    };
}

/** How many plans are kept: a run, its preview and a few others asked about. */
const PLANS_KEPT = 16;
const plans = new Map<string, Plan>();

function plannedOnce(
    options: Pick<EventOptions<"dropper">, "levels" | "difficulty">,
    seed: string
): Plan {
    const key = JSON.stringify([seed, options.levels, options.difficulty]);
    const kept = plans.get(key);
    if (kept) return kept;
    const laid = plan(options, seed);
    plans.set(key, laid);
    if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
    return laid;
}

/** Where a player is let fall from: over the middle of the shaft, a block over the lid. */
export function spawn(shaft: Shaft): Spot {
    return { x: shaft.center.x + 0.5, y: shaft.top + 1, z: shaft.center.z + 0.5, yaw: 0 };
}

/** Where each of `count` players waits on the lid for "Go!": round its middle. */
export function spots(shaft: Shaft, count: number): Spot[] {
    const ring = 3;
    return Array.from({ length: count }, (_, index) => {
        const angle = (index / Math.max(1, count)) * Math.PI * 2;
        const dx = Math.round(Math.cos(angle) * ring);
        const dz = Math.round(Math.sin(angle) * ring);
        return {
            x: shaft.center.x + dx + 0.5,
            y: shaft.top + 1,
            z: shaft.center.z + dz + 0.5,
            yaw: Math.round((Math.atan2(dx, -dz) * 180) / Math.PI)
        };
    });
}

/** Standing on the lid (or jumping on it), inside the rail. */
export function onLid(shaft: Shaft, at: { x: number; y: number; z: number }): boolean {
    return (
        at.y >= shaft.top + 0.5 &&
        at.y <= shaft.top + 3 &&
        Math.abs(at.x - (shaft.center.x + 0.5)) <= HALF + 1 &&
        Math.abs(at.z - (shaft.center.z + 0.5)) <= HALF + 1
    );
}

/** How many floors a player whose feet got down to `lowest` has fallen through. */
export function floorsPassed(shaft: Shaft, lowest: number): number {
    return shaft.floors.filter((floor) => lowest < floor).length;
}

// ------------------------------------------------------------------ in the game

/**
 * Each racer's own scores: the game tick they reached the water (0 while they
 * have not), the lowest their feet have been (in 64ths of a block), and how
 * often the pack has sent them back to the top since the last look.
 */
export const FINISH_SCORE = "pe_drop";
export const LOWEST_SCORE = "pe_low";
export const BACK_SCORE = "pe_back";
/** The pack's own switch and boxes. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_drop";
/** The invisible stand over the middle of the shaft that a landed racer is sent to. */
export const TOP_TAG = "polaris_drop_top";
/**
 * A racer sent to the top whom the server has not yet seen in the air. Until
 * the player's game answers the teleport the server keeps the `OnGround` it
 * had on the floor, so without it the next tick sent them up again, and the
 * next: the player hung at the top, re-teleported every tick, until the
 * server's own check kicked them for flying ("Flying is not enabled on this
 * server", logged as "kicked for floating too long").
 */
export const SENT_TAG = "polaris_drop_sent";
const SCALE = 64;

export const SCORES_ADDED = [FINISH_SCORE, LOWEST_SCORE, BACK_SCORE, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);

export const SCORES_REMOVED = [FINISH_SCORE, LOWEST_SCORE, BACK_SCORE].map(
    (name) => `scoreboard objectives remove ${name}`
);

/** A racer coming in, or let go again from the top: not finished, nowhere yet. */
export function racerScores(name: string, shaft: Shaft): string[] {
    return [
        `scoreboard players set ${name} ${FINISH_SCORE} 0`,
        `scoreboard players set ${name} ${LOWEST_SCORE} ${(shaft.top + 1) * SCALE}`,
        `scoreboard players set ${name} ${BACK_SCORE} 0`,
        `tag ${name} remove ${SENT_TAG}`
    ];
}

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** The `if score` tests that `#px`/`#py`/`#pz` lie inside a box of the pack's. */
function within(box: string): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`p${axis}`)} >= ${score(`${box}${axis}1`)} if score ${score(`p${axis}`)} <= ${score(`${box}${axis}2`)}`
        )
        .join(" ");
}

/**
 * The functions, by name under `polaris:dropper/`. A landing has to be caught
 * the tick it happens: a racer who stood on a floor for a moment, or only on
 * the rim of its hole, could take their time over the next hole from there.
 * So the pack, every tick, sends anybody racing who is on the ground anywhere
 * over the floors back to the top, notes the lowest each racer has been, and
 * the tick each one reached the water. A racer it sent up is sent once: not
 * again until the server has seen them off the ground (`SENT_TAG`).
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @a[tag=pe_in,distance=0..] run function polaris:dropper/player`
    ],
    player: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        `execute if entity @s[scores={${FINISH_SCORE}=0}] ${within("s")} run function polaris:dropper/racer`
    ],
    racer: [
        `scoreboard players operation @s ${LOWEST_SCORE} < ${score("py")}`,
        `tag @s[tag=${SENT_TAG},nbt={OnGround:0b}] remove ${SENT_TAG}`,
        `execute if entity @s[tag=!${SENT_TAG},nbt={OnGround:1b}] ${within("f")} run function polaris:dropper/back`,
        `execute if score ${score("py")} <= ${score("wy")} run function polaris:dropper/done`
    ],
    back: [
        `tp @s @e[type=minecraft:armor_stand,tag=${TOP_TAG},limit=1]`,
        `tag @s add ${SENT_TAG}`,
        `scoreboard players add @s ${BACK_SCORE} 1`,
        "playsound minecraft:block.note_block.bass master @s ~ ~ ~ 1 0.5"
    ],
    done: [
        `execute store result score @s ${FINISH_SCORE} run time query gametime`,
        "playsound minecraft:entity.player.splash master @s ~ ~ ~ 1 1"
    ]
};

/**
 * Switched on for one shaft, at "Go!": the shaft's inside from the pool's floor
 * to over the rail (`s`), the part of it over the floors where standing is
 * landing (`f`: from on the lowest floor to over the lid), and the water's
 * surface (`wy`), all in 64ths; a fresh stand at the top to send the landed to;
 * and the switch last, so the pack never runs against half a box.
 */
export function armLines(shaft: Shaft): string[] {
    const { x, z } = shaft.center;
    const from = (block: number) => block * SCALE;
    const to = (block: number) => (block + 1) * SCALE - 1;
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const lowest = shaft.floors.at(-1) ?? shaft.top;
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("sx1", from(x - HALF)),
        set("sx2", to(x + HALF)),
        set("sy1", from(shaft.bottom)),
        set("sy2", to(shaft.top + RAIL)),
        set("sz1", from(z - HALF)),
        set("sz2", to(z + HALF)),
        set("fx1", from(x - HALF)),
        set("fx2", to(x + HALF)),
        // Feet on the lowest floor are a block over it; a little under that,
        // for a server that reads a standing player a hair low.
        set("fy1", from(lowest + 1) - SCALE / 4),
        // Up to just under the spot a racer is let fall from (`spawn`, the
        // stand): `tp` leaves its target on the ground, so with that spot
        // inside, every racer put there - at "Go!", and each time they were
        // sent back - counted as landed on the next tick and was put there
        // again, held in mid-air every tick until the server kicked them for
        // floating. Nothing can be stood on up there once the lid is gone.
        set("fy2", from(shaft.top + 1) - 1),
        set("fz1", from(z - HALF)),
        set("fz2", to(z + HALF)),
        set("wy", from(shaft.water + 1)),
        `kill @e[type=minecraft:armor_stand,tag=${TOP_TAG}]`,
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x + 0.5} ${shaft.top + 1} ${z + 0.5} {Tags:["${TOP_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,Rotation:[0f,0f]}`,
        set("on", 1)
    ];
}

/**
 * Switched off, and its stand taken away - only while the switch is still this
 * shaft's (`boxes` holds its water), so ending an old shaft never stops a
 * newer one. Safe when it was never on.
 */
export function stopLines(boxes: readonly Pick<Box, "x1" | "z1" | "block">[]): string[] {
    const water = boxes.filter((one) => one.block === WATER);
    if (water.length === 0) return [];
    const x = Math.min(...water.map((one) => one.x1));
    const z = Math.min(...water.map((one) => one.z1));
    const ours = `if score ${score("sx1")} matches ${x * SCALE} if score ${score("sz1")} matches ${z * SCALE}`;
    return [
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${TOP_TAG}]`,
        `execute ${ours} run tag @a remove ${SENT_TAG}`,
        `execute ${ours} run scoreboard players set ${score("on")} 0`
    ];
}

/** Every racer's lowest point and finish tick, and who was sent back, as the
 *  game has them. */
export const READ_LOWEST = `execute as @a[tag=pe_in,scores={${LOWEST_SCORE}=..2147483647}] run scoreboard players get @s ${LOWEST_SCORE}`;
export const READ_FINISHED = `execute as @a[tag=pe_in,scores={${FINISH_SCORE}=1..}] run scoreboard players get @s ${FINISH_SCORE}`;
/** The lowest point as the game keeps it, in blocks. */
export function lowestOf(score: number): number {
    return score / SCALE;
}

/** Whoever the pack sent back to the top since the last look: told `json`
 *  (a text component), and let be until the next time. */
export function backLines(json: string): string[] {
    const selector = `@a[tag=pe_in,scores={${BACK_SCORE}=1..}]`;
    return [
        `execute as ${selector} run tellraw @s ${json}`,
        `scoreboard players set ${selector} ${BACK_SCORE} 0`
    ];
}

/** Slow Falling for everybody inside, given again every tick like Resistance:
 *  the shaft is played at its pace (see the notes at the top). */
export const SLOW_INSIDE = "effect give @a[tag=pe_in] minecraft:slow_falling 10 0 true";

/** The lid taken away at "Go!" - only where it is still its glass. */
export function lidGone(shaft: Shaft): string {
    const lid = shaft.lid;
    return `execute in minecraft:overworld run fill ${lid.x1} ${lid.y1} ${lid.z1} ${lid.x2} ${lid.y2} ${lid.z2} minecraft:air replace ${lid.block}`;
}
