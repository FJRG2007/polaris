/**
 * An ice boat race: a walled track of packed ice floating over a site, one closed
 * loop with turns, gates (checkpoints) along it to pass in order, `laps` times
 * round. Every racer gets a boat at "Go!"; falling off or losing the boat puts
 * them back at the last gate they passed, in a new one.
 *
 * The track is laid out from the run's id (`track`), so every run has a new one
 * and a restart works out the same, and checked against rules before it is
 * built (`trackProblems`):
 *
 * - **A loop that never touches itself.** It is the outline of a shape of
 *   squares grown at random - no holes in it, no two squares meeting only at a
 *   corner - drawn at twice its size, so two parts of the track are always at
 *   least `STEP` x 2 blocks apart, middle to middle, with open air between their
 *   walls.
 * - **The same width all the way** (`WIDTH`, at least 3), **a wall on both sides
 *   with no gap**, two blocks over the ice: a boat cannot climb one, and a player
 *   out of their boat cannot jump one.
 * - **Turns a boat on ice can take**: every turn a right angle, and at least
 *   `STEP` x 2 blocks of straight between two - the outline of a shape drawn at
 *   twice its size never turns twice in a row.
 * - **Nothing can be skipped**: a gate spans the track from wall to wall, and
 *   taking every gate's box out of the track leaves it in as many pieces as
 *   there are gates, each running from one gate to the next. In the game a
 *   gate counts only straight after the one before it, and a racer seen in any
 *   other but the last they passed is sent back to it ("No shortcuts").
 *
 * Gates are passed inside the game, by the events data pack (`FUNCTIONS`): a
 * boat on packed ice covers two blocks a tick, and the quickest look over RCON
 * comes round every eight.
 *
 * Boats by version: a boat is its own entity per wood from 1.21.2
 * (`minecraft:oak_boat`), one `minecraft:boat` with a `Type` before; a player
 * can be put in one (`ride`) from 1.19.4. Before that each racer is handed a
 * marked boat to put down themselves, topped up whenever they have none.
 *
 * Pure: the track, the boxes and the lines are functions of what they are given.
 */

import type { EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";
import { seeded } from "../trivia-bank";

/** How tracks are laid out now, written onto the stage when one is built. */
export const DESIGN = 1;

/** Blocks of ice across the track. */
export const WIDTH = 5;
const HALF = (WIDTH - 1) / 2;
/** Blocks from one point of the outline to the next, middle to middle. */
export const STEP = 8;
/** How many squares the shape is grown to, and the most it may spread each way. */
const CELLS = { least: 8, most: 14 } as const;
const SPREAD = 6;
/** The fewest turns a track has: a plain rectangle has four. */
export const LEAST_TURNS = 8;
/** A lap's length, in blocks along the middle of the track. */
export const LAP = { least: 256, most: 448 } as const;
/** Gates on a lap, the start line included. */
export const GATES = { least: 4, most: 10 } as const;
/** How far along the track a gate's box reaches each way from its line. */
const GATE_DEPTH = 3;
/** How high the walls stand over the ice, and the gates' arches over that. */
const WALL_HEIGHT = 2;
const ARCH = 5;
/** How far under the ice the net is. */
const NET_DROP = 4;
/** How often a light is set into the wall, in blocks. */
const LIGHT_EVERY = 12;

const ICE: Box["block"] = "minecraft:packed_ice";
/** Each gate's line across the ice. */
const LINE: Box["block"] = "minecraft:blue_ice";
const WALL: Box["block"] = "minecraft:white_concrete";
const RAIL: Box["block"] = "minecraft:light_blue_stained_glass";
const LIGHT: Box["block"] = "minecraft:sea_lantern";
const POST: Box["block"] = "minecraft:quartz_block";
const BEAM: Box["block"] = "minecraft:lime_concrete";
const NET: Box["block"] = "minecraft:white_stained_glass";
/** The start and finish: a chequered beam. */
const CHEQUER: readonly Box["block"][] = ["minecraft:black_concrete", "minecraft:white_concrete"];

// ------------------------------------------------------------------ the shape

/** A point of the outline, in steps. */
export interface Point {
    readonly u: number;
    readonly v: number;
}

const key = (u: number, v: number) => `${u},${v}`;

/**
 * A shape of `count` squares grown from one, each added beside one already in it,
 * never leaving a hole or two squares meeting only at a corner, and never wider
 * or deeper than `SPREAD`.
 */
function grown(random: () => number, count: number): Set<string> {
    const cells = new Set<string>([key(0, 0)]);
    const has = (u: number, v: number) => cells.has(key(u, v));
    let low = { u: 0, v: 0 };
    let high = { u: 0, v: 0 };
    for (let tries = 0; cells.size < count && tries < 400; tries += 1) {
        const frontier: Point[] = [];
        for (const one of cells) {
            const [u, v] = one.split(",").map(Number) as [number, number];
            for (const [du, dv] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ] as const)
                if (!has(u + du, v + dv)) frontier.push({ u: u + du, v: v + dv });
        }
        const next = frontier[Math.floor(random() * frontier.length)]!;
        if (Math.max(high.u, next.u) - Math.min(low.u, next.u) >= SPREAD) continue;
        if (Math.max(high.v, next.v) - Math.min(low.v, next.v) >= SPREAD) continue;
        // Two squares meeting only at a corner pinch the outline into touching itself.
        const pinches = [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1]
        ].some(
            ([du, dv]) =>
                has(next.u + du!, next.v + dv!) &&
                !has(next.u + du!, next.v) &&
                !has(next.u, next.v + dv!)
        );
        if (pinches) continue;
        cells.add(key(next.u, next.v));
        if (enclosesAir(cells)) {
            cells.delete(key(next.u, next.v));
            continue;
        }
        low = { u: Math.min(low.u, next.u), v: Math.min(low.v, next.v) };
        high = { u: Math.max(high.u, next.u), v: Math.max(high.v, next.v) };
    }
    return cells;
}

/** Whether the shape closes round some empty square: the outline would be two loops. */
function enclosesAir(cells: ReadonlySet<string>): boolean {
    const points = [...cells].map((one) => one.split(",").map(Number) as [number, number]);
    const lowU = Math.min(...points.map(([u]) => u)) - 1;
    const highU = Math.max(...points.map(([u]) => u)) + 1;
    const lowV = Math.min(...points.map(([, v]) => v)) - 1;
    const highV = Math.max(...points.map(([, v]) => v)) + 1;
    const seen = new Set<string>([key(lowU, lowV)]);
    const queue: [number, number][] = [[lowU, lowV]];
    while (queue.length > 0) {
        const [u, v] = queue.pop()!;
        for (const [du, dv] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const nu = u + du;
            const nv = v + dv;
            if (nu < lowU || nu > highU || nv < lowV || nv > highV) continue;
            const at = key(nu, nv);
            if (seen.has(at) || cells.has(at)) continue;
            seen.add(at);
            queue.push([nu, nv]);
        }
    }
    const outside = (highU - lowU + 1) * (highV - lowV + 1) - cells.size;
    return seen.size !== outside;
}

/**
 * The shape's outline, once round, as points a step apart at twice its size -
 * so a side of one square is two steps, and the outline never turns at two
 * points in a row. Null when the edges do not make one loop.
 */
function outline(cells: ReadonlySet<string>): Point[] | null {
    const has = (u: number, v: number) => cells.has(key(u, v));
    // Each edge of a square with no square beyond it, going round anticlockwise.
    const next = new Map<string, Point>();
    for (const one of cells) {
        const [u, v] = one.split(",").map(Number) as [number, number];
        if (!has(u, v - 1)) next.set(key(u, v), { u: u + 1, v });
        if (!has(u + 1, v)) next.set(key(u + 1, v), { u: u + 1, v: v + 1 });
        if (!has(u, v + 1)) next.set(key(u + 1, v + 1), { u, v: v + 1 });
        if (!has(u - 1, v)) next.set(key(u, v + 1), { u, v });
    }
    const first = next.keys().next().value;
    if (first === undefined) return null;
    const corners: Point[] = [];
    let at = first;
    for (let guard = 0; guard <= next.size; guard += 1) {
        const [u, v] = at.split(",").map(Number) as [number, number];
        corners.push({ u, v });
        const to = next.get(at);
        if (!to) return null;
        at = key(to.u, to.v);
        if (at === first) break;
    }
    if (corners.length !== next.size) return null;
    // Twice the size, a point at every step.
    const points: Point[] = [];
    corners.forEach((one, index) => {
        const to = corners[(index + 1) % corners.length]!;
        points.push({ u: one.u * 2, v: one.v * 2 }, { u: one.u + to.u, v: one.v + to.v });
    });
    return points;
}

// ------------------------------------------------------------------ the track

/** One gate: the point of the outline it stands at, and the way the track runs there. */
export interface Gate {
    readonly at: number;
    readonly du: number;
    readonly dv: number;
}

export interface Layout {
    /** The outline, a step apart, in the order it is raced. */
    readonly points: readonly Point[];
    /** The gates in the order they are passed, the start and finish first. */
    readonly gates: readonly Gate[];
    /** Whether the drawn shape was given up for the plain one (`FALLBACK`). */
    readonly fallback: boolean;
}

/** A shape that always keeps the rules, should a run's draws all fail them: an
 *  L of three by three squares with a corner of two taken out. */
const FALLBACK = ["0,0", "1,0", "2,0", "0,1", "1,1", "2,1", "0,2", "1,2", "2,3", "1,3", "0,3"];

/** Where the track turns: the points whose step in differs from their step out. */
export function turnsOf(points: readonly Point[]): number[] {
    const turns: number[] = [];
    points.forEach((one, index) => {
        const before = points[(index - 1 + points.length) % points.length]!;
        const after = points[(index + 1) % points.length]!;
        if (one.u - before.u !== after.u - one.u || one.v - before.v !== after.v - one.v)
            turns.push(index);
    });
    return turns;
}

/** The gates for an outline: the start at the middle of its longest straight,
 *  then one about every `spacing` points, each on a straight. */
function gatesFor(points: readonly Point[]): Gate[] {
    const turns = new Set(turnsOf(points));
    const count = points.length;
    // The longest straight: the most points between two turns.
    let start = 0;
    let longest = -1;
    const sorted = [...turns].sort((a, b) => a - b);
    sorted.forEach((turn, index) => {
        const next = sorted[(index + 1) % sorted.length]!;
        const length = (next - turn + count) % count || count;
        if (length > longest) {
            longest = length;
            start = (turn + Math.floor(length / 2)) % count;
        }
    });
    const gates = Math.max(GATES.least, Math.min(GATES.most, Math.round(count / 6)));
    const at: number[] = [start];
    for (let index = 1; index < gates; index += 1) {
        const wanted = Math.round(start + (index * count) / gates) % count;
        // The nearest straight point to where it falls, never next to another gate.
        const choices = Array.from({ length: count }, (_, offset) => offset)
            .flatMap((offset) => [(wanted + offset) % count, (wanted - offset + count) % count])
            .filter((one) => !turns.has(one));
        const pick = choices.find((one) =>
            at.every(
                (other) =>
                    Math.min((one - other + count) % count, (other - one + count) % count) >= 3
            )
        );
        if (pick !== undefined) at.push(pick);
    }
    // In the order the track runs from the start.
    at.sort((a, b) => ((a - start + count) % count) - ((b - start + count) % count));
    return at.map((index) => {
        const one = points[index]!;
        const after = points[(index + 1) % count]!;
        return { at: index, du: after.u - one.u, dv: after.v - one.v };
    });
}

/** The plain track (`FALLBACK`): what a run gets should none of its draws keep
 *  the rules. */
export function plainLayout(): Layout {
    const points = outline(new Set(FALLBACK))!;
    return { points, gates: gatesFor(points), fallback: true };
}

/** How many layouts are kept: a race, its preview and a few run ids. */
const LAYOUTS_KEPT = 16;
const layouts = new Map<string, Layout>();

/**
 * The track for a run: shapes grown from the run's id until one's outline keeps
 * every rule (`trackProblems`) - the first that does - or, should none in many
 * tries, the plain fallback.
 */
export function laidOut(seed: string): Layout {
    const kept = layouts.get(seed);
    if (kept) return kept;
    const random = seeded(`boat-race-${seed}`);
    let found: Layout | null = null;
    for (let tries = 0; tries < 200 && !found; tries += 1) {
        const count = CELLS.least + Math.floor(random() * (CELLS.most - CELLS.least + 1));
        const points = outline(grown(random, count));
        if (!points) continue;
        // The quick rules first: most shapes that fail, fail on these.
        const lap = points.length * STEP;
        if (lap < LAP.least || lap > LAP.most) continue;
        if (turnsOf(points).length < LEAST_TURNS) continue;
        const layout = { points, gates: gatesFor(points), fallback: false };
        if (trackProblems(layout).length === 0) found = layout;
    }
    found ??= plainLayout();
    layouts.set(seed, found);
    if (layouts.size > LAYOUTS_KEPT) layouts.delete(layouts.keys().next().value!);
    return found;
}

// ------------------------------------------------------------------ the blocks

/** The ice of the track, block by block, by `x,z` from the outline's own origin:
 *  each point a square of `WIDTH`, and each step between two filled in. */
export function roadCells(points: readonly Point[]): Map<string, number[]> {
    const cells = new Map<string, number[]>();
    const add = (x: number, z: number, segment: number) => {
        const at = key(x, z);
        const list = cells.get(at);
        if (list) {
            if (!list.includes(segment)) list.push(segment);
        } else cells.set(at, [segment]);
    };
    points.forEach((one, index) => {
        const to = points[(index + 1) % points.length]!;
        const x1 = Math.min(one.u, to.u) * STEP - HALF;
        const x2 = Math.max(one.u, to.u) * STEP + HALF;
        const z1 = Math.min(one.v, to.v) * STEP - HALF;
        const z2 = Math.max(one.v, to.v) * STEP + HALF;
        for (let x = x1; x <= x2; x += 1) for (let z = z1; z <= z2; z += 1) add(x, z, index);
    });
    return cells;
}

/** Every block beside the ice that is not ice: where the wall stands. */
export function wallCells(road: ReadonlyMap<string, unknown>): Set<string> {
    const walls = new Set<string>();
    for (const at of road.keys()) {
        const [x, z] = at.split(",").map(Number) as [number, number];
        for (let dx = -1; dx <= 1; dx += 1)
            for (let dz = -1; dz <= 1; dz += 1) {
                const near = key(x + dx, z + dz);
                if (!road.has(near)) walls.add(near);
            }
    }
    return walls;
}

/** A gate's line across the track and its box, in the outline's own blocks. */
export function gateArea(
    points: readonly Point[],
    gate: Gate
): {
    line: { x1: number; z1: number; x2: number; z2: number };
    box: { x1: number; z1: number; x2: number; z2: number };
} {
    const one = points[gate.at]!;
    const x = one.u * STEP;
    const z = one.v * STEP;
    const along = gate.du !== 0;
    return {
        line: along
            ? { x1: x, z1: z - HALF, x2: x, z2: z + HALF }
            : { x1: x - HALF, z1: z, x2: x + HALF, z2: z },
        box: along
            ? { x1: x - GATE_DEPTH, z1: z - HALF, x2: x + GATE_DEPTH, z2: z + HALF }
            : { x1: x - HALF, z1: z - GATE_DEPTH, x2: x + HALF, z2: z + GATE_DEPTH }
    };
}

/** Cells in a set, as the fewest-ish boxes that hold them and nothing else:
 *  runs along x, stacked along z where they match. */
function rectangles(
    cells: ReadonlySet<string>
): { x1: number; z1: number; x2: number; z2: number }[] {
    const byRow = new Map<number, number[]>();
    for (const at of cells) {
        const [x, z] = at.split(",").map(Number) as [number, number];
        (byRow.get(z) ?? byRow.set(z, []).get(z)!).push(x);
    }
    const open = new Map<string, { x1: number; z1: number; x2: number; z2: number }>();
    const done: { x1: number; z1: number; x2: number; z2: number }[] = [];
    for (const z of [...byRow.keys()].sort((a, b) => a - b)) {
        const xs = byRow.get(z)!.sort((a, b) => a - b);
        const runs: [number, number][] = [];
        for (const x of xs) {
            const last = runs[runs.length - 1];
            if (last && last[1] === x - 1) last[1] = x;
            else runs.push([x, x]);
        }
        const still = new Map<string, { x1: number; z1: number; x2: number; z2: number }>();
        for (const [x1, x2] of runs) {
            const span = `${x1}:${x2}`;
            const going = open.get(span);
            if (going && going.z2 === z - 1) still.set(span, { ...going, z2: z });
            else still.set(span, { x1, z1: z, x2, z2: z });
        }
        for (const [span, box] of open) if (still.get(span)?.z1 !== box.z1) done.push(box);
        open.clear();
        for (const [span, box] of still) open.set(span, box);
    }
    done.push(...open.values());
    return done;
}

export interface Track {
    readonly layout: Layout;
    readonly laps: number;
    /** The ice's height: a boat sits on top of it, a block up. */
    readonly floor: number;
    /** What is built, in order: the net, the ice, the lines, the walls, the arches. */
    readonly boxes: readonly Box[];
    /** Each gate's box in world blocks, in the order they are passed. */
    readonly gates: readonly { x1: number; z1: number; x2: number; z2: number }[];
    /** Where a racer is put back at each gate: on its line, facing on. */
    readonly respawns: readonly Spot[];
    readonly volume: Volume;
    readonly reach: number;
    /** How the outline maps to the world: its point (0, 0) in blocks. */
    readonly origin: { readonly x: number; readonly z: number };
    /** A lap, in blocks along the middle of the track. */
    readonly lap: number;
}

/**
 * The track over a site: its middle over the column, its ice at `y`. The same run
 * gives the same track wherever it is put.
 */
export function track(
    options: Pick<EventOptions<"boat-race">, "laps">,
    seed: string,
    site: { x: number; z: number },
    y: number
): Track {
    const layout = laidOut(seed);
    const road = roadCells(layout.points);
    const walls = wallCells(road);
    const all = [...road.keys(), ...walls].map(
        (at) => at.split(",").map(Number) as [number, number]
    );
    const lowX = Math.min(...all.map(([x]) => x));
    const highX = Math.max(...all.map(([x]) => x));
    const lowZ = Math.min(...all.map(([, z]) => z));
    const highZ = Math.max(...all.map(([, z]) => z));
    const dx = site.x - Math.round((lowX + highX) / 2);
    const dz = site.z - Math.round((lowZ + highZ) / 2);
    const world = <T extends { x1: number; z1: number; x2: number; z2: number }>(box: T): T => ({
        ...box,
        x1: box.x1 + dx,
        x2: box.x2 + dx,
        z1: box.z1 + dz,
        z2: box.z2 + dz
    });
    const areas = layout.gates.map((gate) => gateArea(layout.points, gate));
    const lines = new Set<string>();
    for (const { line } of areas)
        for (let x = line.x1; x <= line.x2; x += 1)
            for (let z = line.z1; z <= line.z2; z += 1) lines.add(key(x, z));
    const ice = new Set([...road.keys()].filter((at) => !lines.has(at)));
    const layer = (cells: ReadonlySet<string>, at: number, block: Box["block"]): Box[] =>
        rectangles(cells).map((one) => world({ ...one, y1: at, y2: at, block }));
    // The wall's middle row has a light every so often along it.
    const lights = new Set(
        [...walls].filter((at) => {
            const [x, z] = at.split(",").map(Number) as [number, number];
            return (((x + z) % LIGHT_EVERY) + LIGHT_EVERY) % LIGHT_EVERY === 0;
        })
    );
    const plain = new Set([...walls].filter((at) => !lights.has(at)));
    // Each gate an arch: a post on the wall at each side, a beam across over the ice.
    const arches: Box[] = areas.flatMap(({ line }, index) => {
        const across = line.x1 === line.x2;
        const posts = across
            ? [
                  { x1: line.x1, z1: line.z1 - 1, x2: line.x1, z2: line.z1 - 1 },
                  { x1: line.x1, z1: line.z2 + 1, x2: line.x1, z2: line.z2 + 1 }
              ]
            : [
                  { x1: line.x1 - 1, z1: line.z1, x2: line.x1 - 1, z2: line.z1 },
                  { x1: line.x2 + 1, z1: line.z1, x2: line.x2 + 1, z2: line.z1 }
              ];
        const beam = Array.from({ length: WIDTH }, (_, step) => {
            const at = across
                ? { x1: line.x1, z1: line.z1 + step, x2: line.x1, z2: line.z1 + step }
                : { x1: line.x1 + step, z1: line.z1, x2: line.x1 + step, z2: line.z1 };
            const block =
                index === 0 ? CHEQUER[step % CHEQUER.length]! : step === HALF ? LIGHT : BEAM;
            return world({ ...at, y1: y + ARCH, y2: y + ARCH, block });
        });
        return [
            ...posts.map((post) =>
                world({ ...post, y1: y + WALL_HEIGHT + 1, y2: y + ARCH, block: POST })
            ),
            ...beam
        ];
    });
    const net = world({
        x1: lowX,
        z1: lowZ,
        x2: highX,
        z2: highZ,
        y1: y - NET_DROP,
        y2: y - NET_DROP,
        block: NET
    });
    const boxes: Box[] = [
        net,
        ...layer(ice, y, ICE),
        ...layer(lines, y, LINE),
        ...layer(walls, y, WALL),
        ...layer(plain, y + 1, WALL),
        ...layer(lights, y + 1, LIGHT),
        ...layer(walls, y + 2, RAIL),
        ...arches
    ];
    const respawns = layout.gates.map((gate) => {
        const one = layout.points[gate.at]!;
        return {
            x: one.u * STEP + dx + 0.5,
            y: y + 1,
            z: one.v * STEP + dz + 0.5,
            yaw: yawOf(gate.du, gate.dv)
        };
    });
    return {
        layout,
        laps: options.laps,
        floor: y,
        boxes,
        gates: areas.map(({ box }) => world(box)),
        respawns,
        volume: {
            x1: lowX + dx,
            y1: y - NET_DROP,
            z1: lowZ + dz,
            x2: highX + dx,
            y2: y + ARCH + 2,
            z2: highZ + dz
        },
        reach: Math.ceil(Math.hypot(highX - lowX, highZ - lowZ) / 2) + 1,
        origin: { x: dx, z: dz },
        lap: layout.points.length * STEP
    };
}

/** The game's yaw for a heading: 0 is south (+z), 90 west (-x). */
function yawOf(du: number, dv: number): number {
    return Math.round((Math.atan2(-du, dv) * 180) / Math.PI);
}

/**
 * Where each of `count` racers starts: two abreast, three blocks a row, along
 * the middle of the track back from the start line, facing it - round a corner
 * too, for a crowd.
 */
export function grid(track: Track, count: number): Spot[] {
    const { points } = track.layout;
    const start = track.layout.gates[0]!;
    const spots: Spot[] = [];
    // Walk back along the outline from the start line, a block at a time.
    const back = (distance: number) => {
        let index = start.at;
        let left = distance;
        let at = { x: points[index]!.u * STEP, z: points[index]!.v * STEP };
        for (;;) {
            const before = points[(index - 1 + points.length) % points.length]!;
            const from = { x: before.u * STEP, z: before.v * STEP };
            const length = Math.abs(at.x - from.x) + Math.abs(at.z - from.z);
            if (left <= length) {
                const ux = Math.sign(at.x - from.x);
                const uz = Math.sign(at.z - from.z);
                return { x: at.x - ux * left, z: at.z - uz * left, ux, uz };
            }
            left -= length;
            at = from;
            index = (index - 1 + points.length) % points.length;
        }
    };
    for (let index = 0; index < count; index += 1) {
        const row = Math.floor(index / 2);
        const where = back(GATE_DEPTH + 2 + row * 3);
        const side = index % 2 === 0 ? -1.25 : 1.25;
        spots.push({
            x: where.x + track.origin.x + 0.5 + -where.uz * side,
            y: track.floor + 1,
            z: where.z + track.origin.z + 0.5 + where.ux * side,
            yaw: yawOf(where.ux, where.uz)
        });
    }
    return spots;
}

/** On the start grid's stretch, at the ice's height: where a racer waits for "Go!". */
export function onGrid(track: Track, at: { x: number; y: number; z: number }): boolean {
    return at.y >= track.floor + 0.5 && at.y <= track.floor + 3 && onIce(track, at);
}

/** Over the track's ice. */
function onIce(track: Track, at: { x: number; z: number }): boolean {
    const road = roadCells(track.layout.points);
    return road.has(key(Math.floor(at.x) - track.origin.x, Math.floor(at.z) - track.origin.z));
}

// ------------------------------------------------------------------ the rules

/**
 * What is wrong with a layout, as sentences: nothing when it keeps every rule.
 * Worked out from the blocks, not from how the layout was made.
 */
export function trackProblems(layout: Layout): string[] {
    const problems: string[] = [];
    const { points, gates } = layout;
    const count = points.length;
    // One closed loop, a step at a time, never through a point twice.
    const seen = new Set<string>();
    points.forEach((one, index) => {
        const to = points[(index + 1) % count]!;
        if (Math.abs(to.u - one.u) + Math.abs(to.v - one.v) !== 1)
            problems.push(`not a step from point ${index}`);
        if (seen.has(key(one.u, one.v))) problems.push(`point ${index} twice`);
        seen.add(key(one.u, one.v));
    });
    // A lap of the length asked for, with turns, and never two turns too close.
    const lap = count * STEP;
    if (lap < LAP.least || lap > LAP.most) problems.push(`a lap of ${lap}`);
    const turns = turnsOf(points);
    if (turns.length < LEAST_TURNS) problems.push(`only ${turns.length} turns`);
    turns.forEach((turn, index) => {
        const next = turns[(index + 1) % turns.length]!;
        if ((next - turn + count) % count < 2) problems.push(`turns at ${turn} and ${next}`);
    });
    // Never touching itself: the ice of two parts of the loop more than three
    // steps apart is never within three blocks - ice, wall, air, wall at the
    // least. Each step's ice is one rectangle (`roadCells`), so it is enough to
    // hold every two of those rectangles apart.
    const spans = points.map((one, index) => {
        const to = points[(index + 1) % count]!;
        return {
            x1: Math.min(one.u, to.u) * STEP - HALF,
            x2: Math.max(one.u, to.u) * STEP + HALF,
            z1: Math.min(one.v, to.v) * STEP - HALF,
            z2: Math.max(one.v, to.v) * STEP + HALF
        };
    });
    spans.forEach((a, i) =>
        spans.forEach((b, j) => {
            if (j <= i || Math.min(j - i, count - (j - i)) <= 3) return;
            const apart = Math.max(b.x1 - a.x2, a.x1 - b.x2, b.z1 - a.z2, a.z1 - b.z2) - 1;
            if (apart < 3) problems.push(`steps ${i} and ${j} are ${apart} blocks apart`);
        })
    );
    const road = roadCells(points);
    // The same width all the way: across every straight block, exactly WIDTH of ice.
    points.forEach((one, index) => {
        const to = points[(index + 1) % count]!;
        const along = to.u !== one.u;
        for (let step = HALF + 1; step < STEP - HALF; step += 1) {
            const x = one.u * STEP + (to.u - one.u) * step;
            const z = one.v * STEP + (to.v - one.v) * step;
            let width = 0;
            for (let side = -WIDTH; side <= WIDTH; side += 1)
                if (road.has(along ? key(x, z + side) : key(x + side, z))) width += 1;
            if (width !== WIDTH) problems.push(`${width} wide at ${x},${z}`);
        }
    });
    // A wall all round: every block beside the ice is ice or wall.
    const walls = wallCells(road);
    for (const at of road.keys()) {
        const [x, z] = at.split(",").map(Number) as [number, number];
        for (let dx = -1; dx <= 1; dx += 1)
            for (let dz = -1; dz <= 1; dz += 1) {
                const near = key(x + dx, z + dz);
                if (!road.has(near) && !walls.has(near))
                    problems.push(`a gap in the wall at ${near}`);
            }
    }
    // Gates: as many as a lap asks for, on straights, apart, in order round it.
    if (gates.length < GATES.least || gates.length > GATES.most)
        problems.push(`${gates.length} gates`);
    const turning = new Set(turns);
    gates.forEach((gate, index) => {
        if (turning.has(gate.at)) problems.push(`gate ${index} on a turn`);
        const next = gates[(index + 1) % gates.length]!;
        if ((next.at - gate.at + count) % count < 3)
            problems.push(`gates ${index} and ${index + 1} too close`);
    });
    // Nothing skipped: with every gate's box out, the ice falls into one piece
    // per stretch between two gates, each touching only those two.
    const boxes = gates.map((gate) => gateArea(points, gate).box);
    const inBox = (x: number, z: number) =>
        boxes.findIndex((box) => x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2);
    const left = new Set(
        [...road.keys()].filter((at) => {
            const [x, z] = at.split(",").map(Number) as [number, number];
            return inBox(x, z) === -1;
        })
    );
    const pieces: Set<number>[] = [];
    const done = new Set<string>();
    for (const at of left) {
        if (done.has(at)) continue;
        const touches = new Set<number>();
        const queue = [at];
        done.add(at);
        while (queue.length > 0) {
            const [x, z] = queue.pop()!.split(",").map(Number) as [number, number];
            for (const [dx, dz] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ] as const) {
                const near = key(x + dx, z + dz);
                const gate = inBox(x + dx, z + dz);
                if (gate !== -1 && road.has(near)) touches.add(gate);
                if (!left.has(near) || done.has(near)) continue;
                done.add(near);
                queue.push(near);
            }
        }
        pieces.push(touches);
    }
    if (pieces.length !== gates.length)
        problems.push(`${pieces.length} stretches for ${gates.length} gates`);
    for (const touches of pieces) {
        const ids = [...touches].sort((a, b) => a - b);
        const consecutive =
            ids.length === 2 &&
            (ids[1]! - ids[0]! === 1 || (ids[0] === 0 && ids[1] === gates.length - 1));
        if (!consecutive) problems.push(`a stretch between gates ${ids.join(" and ")}`);
    }
    return problems;
}

// ------------------------------------------------------------------ boats

/**
 * How this server's version hands out a boat: summoned and ridden from 1.19.4
 * (`ride`), as its own `oak_boat` entity from 1.21.2 or a `boat` of type oak
 * before; before 1.19.4, or on a version that could not be read, a marked boat
 * item each racer puts down themselves - written with item components from
 * 1.20.5 (`item_components`), with NBT before.
 */
export type BoatWay = "oak_boat" | "boat" | "item" | "item_components";

/** Whether racers are put in their boats (`ride`), rather than handed one. */
export function rides(way: BoatWay): way is "oak_boat" | "boat" {
    return way === "oak_boat" || way === "boat";
}

/** The marked boat, as this version writes an item. */
function markedBoat(way: "item" | "item_components"): string {
    return way === "item_components"
        ? "minecraft:oak_boat[minecraft:custom_data={polaris_event:1b}]"
        : "minecraft:oak_boat{polaris_event:1b}";
}

/** The tag on every boat the race summons, and on the one just summoned. */
export const BOAT_TAG = "polaris_boat";
const NEW_TAG = "polaris_boat_new";

function boatEntity(way: "oak_boat" | "boat"): string {
    return way === "oak_boat" ? "minecraft:oak_boat" : "minecraft:boat";
}

/**
 * A new boat for the one player `selector` finds, put in it - or, before
 * `ride`, a marked boat in their hands. Summoned where they stand, turned the
 * way they face, and unbreakable. One player at a time: two summoned together
 * on one spot could both be ridden into the same boat, which seats two.
 */
export function boatLines(selector: string, way: BoatWay): string[] {
    if (!rides(way)) return [`give ${selector} ${markedBoat(way)} 1`];
    const type = boatEntity(way);
    const kind = way === "boat" ? `,Type:"oak"` : "";
    const data = `{Tags:["${BOAT_TAG}","${NEW_TAG}"],Invulnerable:1b${kind}}`;
    return [
        `execute as ${selector} at @s run summon ${type} ~ ~ ~ ${data}`,
        `execute as ${selector} at @s rotated as @s run tp @e[type=${type},tag=${NEW_TAG},limit=1,sort=nearest] ~ ~ ~ ~ 0`,
        `execute as ${selector} at @s run ride @s mount @e[type=${type},tag=${NEW_TAG},limit=1,sort=nearest]`,
        `tag @e[type=${type},tag=${NEW_TAG}] remove ${NEW_TAG}`
    ];
}

/** Every boat the race left on its track - summoned or put down - and any boat
 *  lying there as an item, taken away; under both of a boat's names, so
 *  whichever this version does not know is only refused. */
export function boatsGone(volume: Volume): string[] {
    const x = Math.min(volume.x1, volume.x2);
    const y = Math.min(volume.y1, volume.y2);
    const z = Math.min(volume.z1, volume.z2);
    const box = `x=${x},y=${y},z=${z},dx=${Math.abs(volume.x2 - volume.x1)},dy=${Math.abs(volume.y2 - volume.y1)},dz=${Math.abs(volume.z2 - volume.z1)}`;
    return [
        `execute in minecraft:overworld run kill @e[type=minecraft:oak_boat,${box}]`,
        `execute in minecraft:overworld run kill @e[type=minecraft:boat,${box}]`,
        `execute in minecraft:overworld run kill @e[type=minecraft:item,${box},nbt={Item:{id:"minecraft:oak_boat"}}]`
    ];
}

// ------------------------------------------------------------------ in the game

/**
 * Each racer's own scores: the gates passed so far (the start line included),
 * the gate to pass next and the last one passed (-1 before the start), the
 * game tick they finished at (0 while racing), and a mark the pack sets when
 * they are seen at a gate out of turn.
 */
export const PASSED_SCORE = "pe_gate";
export const NEXT_SCORE = "pe_next";
export const LAST_SCORE = "pe_last";
export const FINISH_SCORE = "pe_fin";
export const CUT_SCORE = "pe_cut";
/** The pack's own switch and boxes. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_boat";
const SCALE = 64;

const OWN = [PASSED_SCORE, NEXT_SCORE, LAST_SCORE, FINISH_SCORE, CUT_SCORE];

export const SCORES_ADDED = [...OWN, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);
export const SCORES_REMOVED = OWN.map((name) => `scoreboard objectives remove ${name}`);

/**
 * A racer coming in: at the start, nothing passed - or, coming back to a race
 * they left, the `passed` passes they had made over a track of `gates`, the
 * last of them their last gate and the one after it their next.
 */
export function racerScores(name: string, passed = 0, gates = 1): string[] {
    return [
        `scoreboard players set ${name} ${PASSED_SCORE} ${passed}`,
        `scoreboard players set ${name} ${NEXT_SCORE} ${passed % gates}`,
        `scoreboard players set ${name} ${LAST_SCORE} ${passed > 0 ? (passed - 1) % gates : -1}`,
        `scoreboard players set ${name} ${FINISH_SCORE} 0`,
        `scoreboard players set ${name} ${CUT_SCORE} 0`
    ];
}

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** The `if score` tests that `#px`/`#py`/`#pz` lie inside gate `index`'s box. */
function inGate(index: number): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`p${axis}`)} >= ${score(`g${index}${axis}1`)} if score ${score(`p${axis}`)} <= ${score(`g${index}${axis}2`)}`
        )
        .join(" ");
}

/**
 * The functions, by name under `polaris:boat/`. Every tick, for every racer
 * still racing: at the gate they are to pass next, it counts - their next gate
 * moves on, and the finish is noted to the tick; at any other gate but the last
 * they passed, once over the start line, they are marked for the quick look to
 * send back. Gates past the track's own count are never looked at.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @a[tag=pe_in,scores={${FINISH_SCORE}=0},distance=0..] run function polaris:boat/racer`
    ],
    racer: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        ...Array.from({ length: GATES.most }, (_, index) => [
            `execute if score ${score("gates")} matches ${index + 1}.. if score @s ${NEXT_SCORE} matches ${index} ${inGate(index)} run function polaris:boat/pass`,
            `execute if score ${score("gates")} matches ${index + 1}.. if score @s ${PASSED_SCORE} matches 1.. unless score @s ${NEXT_SCORE} matches ${index} unless score @s ${LAST_SCORE} matches ${index} ${inGate(index)} run scoreboard players set @s ${CUT_SCORE} 1`
        ]).flat()
    ],
    pass: [
        `scoreboard players add @s ${PASSED_SCORE} 1`,
        `scoreboard players operation @s ${LAST_SCORE} = @s ${NEXT_SCORE}`,
        `scoreboard players add @s ${NEXT_SCORE} 1`,
        `execute if score @s ${NEXT_SCORE} >= ${score("gates")} run scoreboard players set @s ${NEXT_SCORE} 0`,
        "playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1.5",
        `execute if score @s ${PASSED_SCORE} >= ${score("total")} store result score @s ${FINISH_SCORE} run time query gametime`
    ]
};

/**
 * Switched on for one track, at "Go!": how many gates, and how many passes make
 * the race (the start line, then every gate of every lap), each gate's box in
 * 64ths from a block under the ice to three over it, and the switch last.
 */
export function armLines(track: Track): string[] {
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const from = (block: number) => block * SCALE;
    const to = (block: number) => (block + 1) * SCALE - 1;
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("tx", cornerOf(track.boxes)!.x),
        set("tz", cornerOf(track.boxes)!.z),
        set("gates", track.gates.length),
        set("total", track.laps * track.gates.length + 1),
        ...track.gates.flatMap((gate, index) => [
            set(`g${index}x1`, from(gate.x1)),
            set(`g${index}x2`, to(gate.x2)),
            set(`g${index}y1`, from(track.floor - 1)),
            set(`g${index}y2`, to(track.floor + 3)),
            set(`g${index}z1`, from(gate.z1)),
            set(`g${index}z2`, to(gate.z2))
        ]),
        set("on", 1)
    ];
}

/** The corner of a track's gate lines: what names the track the pack is armed for. */
function cornerOf(
    boxes: readonly Pick<Box, "x1" | "z1" | "block">[]
): { x: number; z: number } | null {
    const lines = boxes.filter((one) => one.block === LINE);
    if (lines.length === 0) return null;
    return {
        x: Math.min(...lines.map((one) => one.x1)),
        z: Math.min(...lines.map((one) => one.z1))
    };
}

/**
 * Switched off - only while the switch is still this track's (`boxes` holds its
 * gate lines), so ending an old track never stops a newer one. Safe when it was
 * never on.
 */
export function stopLines(boxes: readonly Pick<Box, "x1" | "z1" | "block">[]): string[] {
    const corner = cornerOf(boxes);
    if (!corner) return [];
    return [
        `execute if score ${score("tx")} matches ${corner.x} if score ${score("tz")} matches ${corner.z} run scoreboard players set ${score("on")} 0`
    ];
}

/** Whether boxes are a boat race's: its gates' lines of blue ice. */
export function isTrack(boxes: readonly Pick<Box, "block">[]): boolean {
    return boxes.some((one) => one.block === LINE);
}

/** Every racer's gates passed and finish tick, as the game has them. */
export const READ_PASSED = `execute as @a[tag=pe_in,scores={${PASSED_SCORE}=0..}] run scoreboard players get @s ${PASSED_SCORE}`;
export const READ_FINISHED = `execute as @a[tag=pe_in,scores={${FINISH_SCORE}=1..}] run scoreboard players get @s ${FINISH_SCORE}`;

/** Marks, for one quick look, who is to be put back, and the one being put in
 *  a boat. */
const RESET_TAG = "pe_reset";
const MOUNT_TAG = "pe_mount";
/** For one quick look: a race boat somebody sits in, and a racer in no race boat. */
const HELD_TAG = "pe_held";
const AFOOT_TAG = "pe_afoot";
/** Put back on the last look but past the boats it had room for: already
 *  told why, and in a boat on this one without being told they left theirs. */
const WAIT_TAG = "pe_bwait";
/** Racers put in a new boat in one quick look. */
const MOUNTS_PER_LOOK = 4;

/**
 * The quick look at a race, with selectors alone: whoever is racing and has
 * fallen under the ice, was seen at a gate out of turn, or (with `ride`) is
 * out of their boat, is told why and put back on the last gate they passed -
 * the start grid's first spot before the start line - in a new boat, and the
 * boats nobody is in any more are taken away. Before 1.19.4, whoever racing is
 * in no boat and has none in hand is handed one.
 */
export function quickLines(
    track: Track,
    way: BoatWay,
    told: { fell: string; cut: string; lost: string }
): string[] {
    const volume = track.volume;
    const x = Math.min(volume.x1, volume.x2) - 4;
    const z = Math.min(volume.z1, volume.z2) - 4;
    const y = Math.min(volume.y1, volume.y2) - 64;
    const under = `x=${x},y=${y},z=${z},dx=${Math.abs(volume.x2 - volume.x1) + 8},dy=${track.floor - 1 - y},dz=${Math.abs(volume.z2 - volume.z1) + 8}`;
    const racing = `tag=pe_in,scores={${FINISH_SCORE}=0}`;
    const world = "execute in minecraft:overworld";
    const lines: string[] = [];
    // Who sits in which boat, asked of the boats themselves (`execute on`, from
    // 1.19.4 like `ride`). Never their saved data: a player is never written
    // into a vehicle's `Passengers`, so every boat with a racer in it read as
    // empty, was taken away, and its racer put back in a new one - on every
    // look, a loop of teleports.
    if (rides(way)) {
        const boats = `@e[type=${boatEntity(way)},tag=${BOAT_TAG}]`;
        lines.push(
            `tag @a[${racing}] add ${AFOOT_TAG}`,
            `${world} as ${boats} on passengers run tag @s remove ${AFOOT_TAG}`,
            `${world} as ${boats} on passengers on vehicle run tag @s add ${HELD_TAG}`,
            `${world} run kill @e[type=${boatEntity(way)},tag=${BOAT_TAG},tag=!${HELD_TAG}]`,
            `${world} run tag @e[type=${boatEntity(way)},tag=${HELD_TAG}] remove ${HELD_TAG}`
        );
    }
    lines.push(
        `${world} as @a[${racing},${under}] run tellraw @s ${told.fell}`,
        `${world} run tag @a[${racing},${under}] add ${RESET_TAG}`,
        `execute as @a[tag=pe_in,tag=!${RESET_TAG},scores={${CUT_SCORE}=1}] run tellraw @s ${told.cut}`,
        `tag @a[tag=pe_in,scores={${CUT_SCORE}=1}] add ${RESET_TAG}`
    );
    if (rides(way))
        lines.push(
            `execute as @a[${racing},tag=!${RESET_TAG},tag=!${WAIT_TAG},tag=${AFOOT_TAG}] run tellraw @s ${told.lost}`,
            `tag @a[${racing},tag=${AFOOT_TAG}] add ${RESET_TAG}`,
            `tag @a remove ${AFOOT_TAG}`,
            `tag @a remove ${WAIT_TAG}`
        );
    const back = [grid(track, 1)[0]!, ...track.respawns];
    back.forEach((spot, index) =>
        lines.push(
            `${world} run tp @a[tag=${RESET_TAG},scores={${LAST_SCORE}=${index - 1}}] ${spot.x.toFixed(3)} ${spot.y.toFixed(3)} ${spot.z.toFixed(3)} ${spot.yaw.toFixed(1)} 0.0`
        )
    );
    lines.push(`scoreboard players set @a[tag=${RESET_TAG}] ${CUT_SCORE} 0`);
    // A boat each, one racer at a time; anybody past the few a look has room
    // for is still out of a boat on the next, and has theirs then.
    for (let one = 0; one < MOUNTS_PER_LOOK; one += 1)
        lines.push(
            `tag @a[tag=${RESET_TAG},limit=1] add ${MOUNT_TAG}`,
            ...boatLines(`@a[tag=${MOUNT_TAG}]`, way),
            `tag @a[tag=${MOUNT_TAG}] remove ${RESET_TAG}`,
            `tag @a remove ${MOUNT_TAG}`
        );
    if (rides(way)) lines.push(`tag @a[tag=${RESET_TAG}] add ${WAIT_TAG}`);
    lines.push(`tag @a remove ${RESET_TAG}`);
    if (!rides(way))
        lines.push(
            `give @a[${racing},nbt=!{RootVehicle:{}},nbt=!{Inventory:[{id:"minecraft:oak_boat"}]}] ${markedBoat(way)} 1`
        );
    return lines;
}

/** Where a racer who has made `passed` passes goes back in: their last gate,
 *  as a reset puts them; the grid's first spot before any. */
export function resumeSpot(track: Track, passed: number): Spot {
    if (passed <= 0) return grid(track, 1)[0]!;
    return track.respawns[(passed - 1) % track.gates.length]!;
}

/** The lap a racer is on and the gates passed on it, from the gates passed. */
export function progressOf(track: Track, passed: number): { lap: number; gate: number } {
    const gates = track.gates.length;
    if (passed <= 0) return { lap: 1, gate: 0 };
    return {
        lap: Math.min(track.laps, Math.floor((passed - 1) / gates) + 1),
        gate: (passed - 1) % gates
    };
}
