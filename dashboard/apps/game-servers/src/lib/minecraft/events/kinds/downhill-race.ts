/**
 * A downhill boat race: an ice boat race's track (`boat-race`, design 2 - the
 * same grown outline, the same middle line with its sweeping arcs, the same
 * width and walls) cut open into one road from a start at the top to a finish
 * at the bottom, dropping a block at a time on the way down. Every racer gets
 * a boat at "Go!", passes the checkpoints in order, and the first over the
 * finish line wins; a fall or a lost boat puts them back at the last line they
 * passed, as in the boat race - whose data pack, quick look and boats this
 * plays with (`boat-race.Track.downhill`).
 *
 * The road (`course`) is the loop's middle line from a little before its start
 * line, run on until a straight short of coming round to the grid again: the
 * gap left between the end and the grid is open air, two steps long, so the
 * finish is never in reach of the start. Down it:
 *
 * - **A block at a time.** The ice drops one block every `DROPS[steepness]`
 *   blocks along the middle after the start line, never two at once: any two
 *   blocks of ice side by side are at most a block apart in height, and a boat
 *   never has to climb.
 * - **Walls the whole way.** Every block beside the ice that is not ice is wall,
 *   standing from the lowest ice beside it to two over the highest, so there is
 *   no gap at a drop for a boat to slip through; the road's two ends are walled
 *   too.
 * - **Nothing skipped.** Taking the start, every checkpoint and the finish out
 *   of the road leaves it in one more piece than there are lines, each running
 *   from one line to the next.
 *
 * `courseProblems` checks those, from the blocks, and the tests run it over
 * thousands of runs.
 *
 * Pure: the course, the boxes and the lines are functions of what they are given.
 */

import type { Box } from "./stage";
import * as boatRace from "./boat-race";
import type { EventOptions } from "../catalog";

/** How courses are laid out now, written onto the stage when one is built. */
export const DESIGN = 1;

/** The boat race's design whose outline, middle line and width this is. */
const TRACK_DESIGN = 2;
/** Blocks along the middle between one drop of a block and the next. */
export const DROPS: Readonly<Record<EventOptions<"downhill-race">["steepness"], number>> = {
    gentle: 14,
    steep: 9
};
/** Blocks of level road kept before the start line, for the grid. */
export const GRID = 36;
/** Blocks of the loop left out between the end of the road and its grid. */
export const GAP = 32;
/** Blocks of level road past the finish line, to slow down in. */
export const RUNOFF = 16;
/** The fewest blocks between two lines along the road. */
const LEAST_APART = 24;
/** Half the road's width, and the gates' depth along it, as the boat race's. */
const HALF = (boatRace.WIDTH - 1) / 2;
const NET_DROP = 4;
const NET_TILE = 128;
const WALL_HEIGHT = 2;
const ARCH = 5;
const LIGHT_EVERY = 12;

const ICE: Box["block"] = "minecraft:packed_ice";
const LINE: Box["block"] = "minecraft:blue_ice";
const WALL: Box["block"] = "minecraft:white_concrete";
const RAIL: Box["block"] = "minecraft:light_blue_stained_glass";
const LIGHT: Box["block"] = "minecraft:sea_lantern";
const POST: Box["block"] = "minecraft:quartz_block";
const BEAM: Box["block"] = "minecraft:lime_concrete";
const NET: Box["block"] = "minecraft:white_stained_glass";
const CHEQUER: readonly Box["block"][] = ["minecraft:black_concrete", "minecraft:white_concrete"];

const key = (x: number, z: number) => `${x},${z}`;
const cellOf = (at: string) => at.split(",").map(Number) as [number, number];

/** The road in the outline's own blocks: the middle line and every block of ice
 *  with the drop it is at (0 the top, -1 a block down, ...). */
export interface Road {
    readonly samples: readonly boatRace.Sample[];
    /** Each block of ice by `x,z`: how far down it is, and the first sample near it. */
    readonly cells: ReadonlyMap<string, { readonly drop: number; readonly sample: number }>;
    /** The lines in the order they are passed - the start, the checkpoints,
     *  the finish - each by the sample it stands at and its gate. */
    readonly lines: readonly { readonly sample: number; readonly gate: boatRace.Gate }[];
}

/**
 * The road for a layout: the loop's middle line from `GRID` blocks before its
 * start line, round to the last straight point of the outline that leaves
 * `RUNOFF` blocks past it and `GAP` blocks before the grid again - the finish -
 * and `RUNOFF` on. Checkpoints are the loop's own gates in between that stand
 * at least `LEAST_APART` from the lines either side.
 */
export function roadOf(layout: boatRace.Layout, steepness: keyof typeof DROPS): Road {
    const { points } = layout;
    const step = boatRace.STEP;
    const loop = boatRace.centerline(points, TRACK_DESIGN);
    const count = loop.length;
    const startAt = boatRace.sampleAt(points, layout.gates[0]!.at, TRACK_DESIGN);
    const first = (startAt - GRID + count) % count;
    // Where each point of the outline on a straight falls along the road.
    const turns = new Set(boatRace.turnsOf(points));
    const sampleOf = (index: number) => {
        const one = points[index]!;
        const found = loop.findIndex((s) => s.x === one.u * step && s.z === one.v * step);
        return found === -1 ? -1 : (found - first + count) % count;
    };
    const gateAt = (index: number): boatRace.Gate => {
        const one = points[index]!;
        const after = points[(index + 1) % points.length]!;
        return { at: index, du: after.u - one.u, dv: after.v - one.v };
    };
    const last = count - GAP - RUNOFF;
    const finish = points
        .map((_, index) => ({ index, sample: sampleOf(index) }))
        .filter((one) => !turns.has(one.index) && one.sample > GRID + LEAST_APART)
        .filter((one) => one.sample <= last)
        .sort((a, b) => b.sample - a.sample)[0]!;
    const checkpoints = layout.gates
        .slice(1)
        .map((gate) => ({ sample: sampleOf(gate.at), gate }))
        .filter(
            (one) => one.sample >= GRID + LEAST_APART && one.sample <= finish.sample - LEAST_APART
        )
        .sort((a, b) => a.sample - b.sample);
    // The pack counts at most `GATES.most` lines, the start and finish among
    // them: past that, checkpoints are kept evenly along the way.
    const room = boatRace.GATES.most - 2;
    const kept =
        checkpoints.length <= room
            ? checkpoints
            : Array.from(
                  { length: room },
                  (_, index) => checkpoints[Math.floor((index * checkpoints.length) / room)]!
              );
    const lines = [
        { sample: GRID, gate: layout.gates[0]! },
        ...kept,
        { sample: finish.sample, gate: gateAt(finish.index) }
    ];
    const length = finish.sample + RUNOFF + 1;
    const samples = Array.from({ length }, (_, index) => loop[(first + index) % count]!);
    const every = DROPS[steepness];
    // Level on the grid and past the finish, to set off and to slow down on.
    const dropAt = (sample: number) =>
        sample <= GRID ? 0 : -Math.floor((Math.min(sample, finish.sample) - GRID) / every);
    // Every block within half the width of the middle, at the drop of the
    // first sample it is near: the road only ever goes down along it.
    const reach = HALF + 0.5;
    const span = Math.ceil(reach) + 1;
    const cells = new Map<string, { drop: number; sample: number }>();
    samples.forEach((one, index) => {
        const bx = Math.round(one.x);
        const bz = Math.round(one.z);
        for (let x = bx - span; x <= bx + span; x += 1)
            for (let z = bz - span; z <= bz + span; z += 1) {
                const gx = x - one.x;
                const gz = z - one.z;
                if (gx * gx + gz * gz > reach * reach + 1e-9) continue;
                const at = key(x, z);
                if (!cells.has(at)) cells.set(at, { drop: dropAt(index), sample: index });
            }
    });
    return { samples, cells, lines };
}

/** A line's blocks across the road and its box, in the outline's own blocks. */
function lineArea(layout: boatRace.Layout, gate: boatRace.Gate) {
    return boatRace.gateArea(layout.points, gate, TRACK_DESIGN);
}

/**
 * The course over a site: the road's middle over the column, the bottom of the
 * road - the finish - at `y`, the top as many blocks over it as the road drops.
 * The same run gives the same course wherever it is put.
 */
export function course(
    options: Pick<EventOptions<"downhill-race">, "steepness">,
    seed: string,
    site: { x: number; z: number },
    y: number
): boatRace.Track {
    const layout = boatRace.laidOut(seed, TRACK_DESIGN);
    const road = roadOf(layout, options.steepness);
    const fall = -Math.min(...[...road.cells.values()].map((one) => one.drop));
    const top = y + fall;
    const heightOf = (at: string) => top + road.cells.get(at)!.drop;
    // The walls: every block beside the ice that is not ice, from the lowest
    // ice beside it to two over the highest.
    const walls = new Map<string, { low: number; high: number }>();
    for (const at of road.cells.keys()) {
        const [x, z] = cellOf(at);
        const h = heightOf(at);
        for (let dx = -1; dx <= 1; dx += 1)
            for (let dz = -1; dz <= 1; dz += 1) {
                const near = key(x + dx, z + dz);
                if (road.cells.has(near)) continue;
                const was = walls.get(near);
                walls.set(near, {
                    low: Math.min(was?.low ?? h, h),
                    high: Math.max(was?.high ?? h, h)
                });
            }
    }
    const all = [...road.cells.keys(), ...walls.keys()].map(cellOf);
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
    const areas = road.lines.map(({ gate }) => lineArea(layout, gate));
    const floors = road.lines.map(({ gate }) => {
        const one = layout.points[gate.at]!;
        return heightOf(key(one.u * boatRace.STEP, one.v * boatRace.STEP));
    });
    const lineCells = new Map<string, number>();
    areas.forEach(({ line }) => {
        for (let x = line.x1; x <= line.x2; x += 1)
            for (let z = line.z1; z <= line.z2; z += 1)
                if (road.cells.has(key(x, z))) lineCells.set(key(x, z), heightOf(key(x, z)));
    });
    /** Cells grouped by a height, each group as boxes one block high. */
    const layers = (cells: ReadonlyMap<string, number>, block: Box["block"]): Box[] => {
        const byHeight = new Map<number, Set<string>>();
        for (const [at, h] of cells)
            (byHeight.get(h) ?? byHeight.set(h, new Set()).get(h)!).add(at);
        return [...byHeight.entries()].flatMap(([h, group]) =>
            boatRace.rectangles(group).map((one) => world({ ...one, y1: h, y2: h, block }))
        );
    };
    const ice = new Map(
        [...road.cells.keys()].filter((at) => !lineCells.has(at)).map((at) => [at, heightOf(at)])
    );
    // A wall stands as columns: grouped by where they start and end.
    const columns = (
        pick: (one: { low: number; high: number }, at: string) => [number, number] | null,
        block: Box["block"]
    ): Box[] => {
        const bySpan = new Map<string, Set<string>>();
        for (const [at, one] of walls) {
            const span = pick(one, at);
            if (!span) continue;
            const id = `${span[0]}:${span[1]}`;
            (bySpan.get(id) ?? bySpan.set(id, new Set()).get(id)!).add(at);
        }
        return [...bySpan.entries()].flatMap(([id, group]) => {
            const [y1, y2] = id.split(":").map(Number) as [number, number];
            return boatRace.rectangles(group).map((one) => world({ ...one, y1, y2, block }));
        });
    };
    const lit = (at: string) => {
        const [x, z] = cellOf(at);
        return (((x + z) % LIGHT_EVERY) + LIGHT_EVERY) % LIGHT_EVERY === 0;
    };
    const arches: Box[] = areas.flatMap(({ line }, index) => {
        const across = line.x1 === line.x2;
        const floor = floors[index]!;
        const posts = across
            ? [
                  { x1: line.x1, z1: line.z1 - 1, x2: line.x1, z2: line.z1 - 1 },
                  { x1: line.x1, z1: line.z2 + 1, x2: line.x1, z2: line.z2 + 1 }
              ]
            : [
                  { x1: line.x1 - 1, z1: line.z1, x2: line.x1 - 1, z2: line.z1 },
                  { x1: line.x2 + 1, z1: line.z1, x2: line.x2 + 1, z2: line.z1 }
              ];
        const ends = index === 0 || index === areas.length - 1;
        const beam = Array.from({ length: boatRace.WIDTH }, (_, step) => {
            const at = across
                ? { x1: line.x1, z1: line.z1 + step, x2: line.x1, z2: line.z1 + step }
                : { x1: line.x1 + step, z1: line.z1, x2: line.x1 + step, z2: line.z1 };
            const block = ends ? CHEQUER[step % CHEQUER.length]! : step === HALF ? LIGHT : BEAM;
            return world({ ...at, y1: floor + ARCH, y2: floor + ARCH, block });
        });
        // Each post from over its wall up to the beam.
        return [
            ...posts.map((post) => {
                const wall = walls.get(key(post.x1, post.z1));
                const from = (wall?.high ?? floor) + WALL_HEIGHT + 1;
                return world({ ...post, y1: from, y2: Math.max(from, floor + ARCH), block: POST });
            }),
            ...beam
        ];
    });
    const net: Box[] = [];
    for (let x1 = lowX; x1 <= highX; x1 += NET_TILE)
        for (let z1 = lowZ; z1 <= highZ; z1 += NET_TILE)
            net.push(
                world({
                    x1,
                    z1,
                    x2: Math.min(highX, x1 + NET_TILE - 1),
                    z2: Math.min(highZ, z1 + NET_TILE - 1),
                    y1: y - NET_DROP,
                    y2: y - NET_DROP,
                    block: NET
                })
            );
    const boxes: Box[] = [
        ...net,
        ...layers(ice, ICE),
        ...layers(lineCells, LINE),
        // The wall: plain from the lowest ice beside it to a block over the
        // highest (a light now and then in that top block), the rail over that.
        ...columns((one) => [one.low, one.high], WALL),
        ...columns((one, at) => (lit(at) ? null : [one.high + 1, one.high + 1]), WALL),
        ...columns((one, at) => (lit(at) ? [one.high + 1, one.high + 1] : null), LIGHT),
        ...columns((one) => [one.high + 2, one.high + 2], RAIL),
        ...arches
    ];
    const respawns = road.lines.map(({ gate }, index) => {
        const one = layout.points[gate.at]!;
        return {
            x: one.u * boatRace.STEP + dx + 0.5,
            y: floors[index]! + 1,
            z: one.v * boatRace.STEP + dz + 0.5,
            yaw: Math.round((Math.atan2(-gate.du, gate.dv) * 180) / Math.PI)
        };
    });
    const highest = Math.max(top, ...[...walls.values()].map((one) => one.high)) + ARCH + 2;
    return {
        layout,
        laps: 1,
        floor: top,
        boxes,
        gates: areas.map(({ box }) => world(box)),
        respawns,
        volume: {
            x1: lowX + dx,
            y1: y - NET_DROP,
            z1: lowZ + dz,
            x2: highX + dx,
            y2: highest,
            z2: highZ + dz
        },
        reach: Math.ceil(Math.hypot(highX - lowX, highZ - lowZ) / 2) + 1,
        origin: { x: dx, z: dz },
        lap: road.samples.length,
        downhill: { bottom: y, gateFloors: floors, grid: GRID }
    };
}

/**
 * Whatever keeps a course from being fair, worked out from its road: two
 * blocks of ice side by side more than a block apart, the road going up
 * along the way it is raced, a line off the road or out of order, and
 * anything to skip between two lines.
 */
export function courseProblems(layout: boatRace.Layout, steepness: keyof typeof DROPS): string[] {
    const problems: string[] = [];
    const road = roadOf(layout, steepness);
    for (const [at, one] of road.cells) {
        const [x, z] = cellOf(at);
        for (const [ox, oz] of [
            [1, 0],
            [0, 1]
        ] as const) {
            const near = road.cells.get(key(x + ox, z + oz));
            if (near && Math.abs(near.drop - one.drop) > 1) problems.push(`a step of two at ${at}`);
        }
    }
    // Along the middle, only ever level or down.
    let before = 0;
    road.samples.forEach((one, index) => {
        const here = road.cells.get(key(Math.round(one.x), Math.round(one.z)));
        if (!here) problems.push(`sample ${index} off the road`);
        else {
            if (here.drop > before) problems.push(`the road climbs at sample ${index}`);
            before = here.drop;
        }
    });
    // The lines in order, far enough apart, the start's grid level.
    road.lines.forEach((one, index) => {
        const next = road.lines[index + 1];
        if (next && next.sample - one.sample < LEAST_APART)
            problems.push(`lines ${index} and ${index + 1} too close`);
    });
    if (road.lines.length < 3) problems.push("no checkpoint between the start and the finish");
    if (road.lines.length > boatRace.GATES.most) problems.push("more lines than the pack counts");
    // Nothing skipped: with every line's box taken out, the road falls into one
    // more piece than there are lines.
    const out = new Set<string>();
    for (const { gate } of road.lines) {
        const { box } = lineArea(layout, gate);
        for (let x = box.x1; x <= box.x2; x += 1)
            for (let z = box.z1; z <= box.z2; z += 1) out.add(key(x, z));
    }
    const left = new Set([...road.cells.keys()].filter((at) => !out.has(at)));
    let pieces = 0;
    for (const at of left) {
        pieces += 1;
        const queue = [at];
        left.delete(at);
        while (queue.length > 0) {
            const [x, z] = cellOf(queue.pop()!);
            for (const [ox, oz] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ] as const) {
                const near = key(x + ox, z + oz);
                if (left.delete(near)) queue.push(near);
            }
        }
    }
    if (pieces !== road.lines.length + 1)
        problems.push(`the road is in ${pieces} pieces between ${road.lines.length} lines`);
    return problems;
}
