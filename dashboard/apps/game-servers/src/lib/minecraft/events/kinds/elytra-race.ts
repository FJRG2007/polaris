/**
 * Elytra race: a loop of rings hung in the sky, flown with a marked elytra and
 * rockets for laps. Racers wait on a glass pad behind the start ring; at "Go!"
 * its floor goes and they drop off it into a glide.
 *
 * - **The course** is a boat race's loop (`boat-race.laidOut`, the same shapes
 *   and the same gates), lifted into the air: a ring stands at each gate, its
 *   centre a little higher or lower than the last (`SWING`), never steeper
 *   than a quarter of the way between them.
 * - **Boosters**: a smaller ring halfway between each two, on the straight line
 *   from one ring to the next; flying through one is worth two rockets, and
 *   every ring passed one more.
 * - **Obstacles**: pillars beside that line, never closer to it than
 *   `CLEARANCE` - a racer flying ring to ring never touches one, one swinging
 *   wide may.
 * - **Checkpoints and laps** are counted by the events data pack the way a boat
 *   race's gates are (`FUNCTIONS`): a ring counts only when it is the next one,
 *   and one passed out of turn sends the racer back. So does falling below the
 *   course or landing on anything, to the last ring they passed.
 *
 * The elytra and the rockets carry the events' marker, and are taken back with
 * everything else the event gave (`stage.clearMarked`) - at the end, on leaving
 * and when a player who left comes back on.
 *
 * Pure: the course, the boxes and the lines are functions of what they are given.
 */

import * as boatRace from "./boat-race";
import { seeded } from "../trivia-bank";
import type { EventOptions } from "../catalog";
import type { Box, Flavour, Spot, Volume } from "./stage";

/** How courses are laid out now, written onto the stage when one is built. */
export const DESIGN = 1;

type Obstacles = EventOptions<"elytra-race">["obstacles"];

/** Half a ring's opening: a ring is open from its centre this far each way. */
export const RING = 4;
const FRAME = RING + 1;
/** Half a booster's opening. */
export const BOOST = 2;
/** The most a ring's centre stands over or under the course's height. */
export const SWING = 6;
/** How far a pillar keeps from the line between two rings, block to line. */
export const CLEARANCE = 3;
/** The least a line into or out of a ring may lean off its axis, as the cosine
 *  of that lean: 60 degrees. */
export const SQUARE = 0.5;
/** Rings are never left out below this many. */
const RINGS_LEAST = 4;
/** How far behind the start ring the pad is, and how far over its centre. */
const PAD_BACK = 18;
const PAD_RISE = 10;
/** Half the pad across, and its length along the course. */
const PAD_HALF = 3;
const PAD_DEPTH = 5;
/** How far below the lowest ring's frame a racer is taken for fallen. */
export const FALL = 12;
/** A pillar: blocks across, and how far it stands over and under its height. */
const PILLAR = 2;
const PILLAR_REACH = 6;
/** Pillars between each two rings, by the option. */
const PILLARS: Readonly<Record<Obstacles, number>> = { none: 0, few: 1, many: 3 };
/** Rockets in hand at "Go!", for whoever is behind. */
export const START_ROCKETS = 3;
/** Rockets for passing a ring, and a booster. */
export const RING_ROCKETS = 1;
export const BOOST_ROCKETS = 2;

const RING_BLOCK: Box["block"] = "minecraft:orange_concrete";
const START_BLOCK: Box["block"] = "minecraft:white_concrete";
const BOOST_BLOCK: Box["block"] = "minecraft:yellow_stained_glass";
const PILLAR_BLOCK: Box["block"] = "minecraft:magenta_concrete";
const PAD_BLOCK: Box["block"] = "minecraft:white_stained_glass";
const RIM_BLOCK: Box["block"] = "minecraft:glass";
const LIGHT: Box["block"] = "minecraft:glowstone";

type Point3 = { readonly x: number; readonly y: number; readonly z: number };

/** A ring, or a booster: its centre, the axis the course crosses it along, and
 *  the box flying through it is looked for in. */
export interface Hoop {
    readonly center: Point3;
    /** Along x (`true`) or along z. */
    readonly alongX: boolean;
    readonly box: Volume;
}

export interface Course {
    readonly layout: boatRace.Layout;
    readonly laps: number;
    /** The course's own height: the start ring's centre. */
    readonly height: number;
    readonly rings: readonly Hoop[];
    readonly boosters: readonly Hoop[];
    /** Every pillar, as the blocks it is. */
    readonly pillars: readonly Volume[];
    /** The pad's floor: what goes at "Go!". */
    readonly pad: Box;
    /** Where a racer is put back at each ring, facing on: in the air behind it. */
    readonly respawns: readonly Spot[];
    /** Where a racer is put back before the start ring. */
    readonly start: Spot;
    /** Under this, a racer has fallen. */
    readonly fallY: number;
    /** What is built, in order: the pad and its rim, the rings, boosters, pillars. */
    readonly boxes: readonly Box[];
    readonly volume: Volume;
    readonly reach: number;
}

const yawOf = (dx: number, dz: number) => Math.round((Math.atan2(-dx, dz) * 180) / Math.PI);

/** A hoop's frame, a block thick, across the axis it is flown along. */
function frame(hoop: Hoop, half: number, block: Box["block"], light?: Box["block"]): Box[] {
    const { x, y, z } = hoop.center;
    const out = half + 1;
    // Across: the other horizontal axis.
    const span = (
        from: number,
        to: number,
        at: number,
        y1: number,
        y2: number,
        use: Box["block"]
    ): Box =>
        hoop.alongX
            ? { x1: x, x2: x, z1: from, z2: to, y1, y2, block: use }
            : { x1: from, x2: to, z1: at, z2: at, y1, y2, block: use };
    const across = hoop.alongX ? z : x;
    const boxes = [
        span(across - out, across + out, z, y + out, y + out, block),
        span(across - out, across + out, z, y - out, y - out, block),
        span(across - out, across - out, z, y - half, y + half, block),
        span(across + out, across + out, z, y - half, y + half, block)
    ];
    if (!light) return boxes;
    // A light at each corner in place of the frame's own block there.
    const top = boxes[0]!;
    const bottom = boxes[1]!;
    const trimmed = (bar: Box): Box =>
        hoop.alongX
            ? { ...bar, z1: bar.z1 + 1, z2: bar.z2 - 1 }
            : { ...bar, x1: bar.x1 + 1, x2: bar.x2 - 1 };
    const corners = [top, bottom].flatMap((bar) =>
        hoop.alongX
            ? [
                  { ...bar, z1: bar.z1, z2: bar.z1, block: light },
                  { ...bar, z1: bar.z2, z2: bar.z2, block: light }
              ]
            : [
                  { ...bar, x1: bar.x1, x2: bar.x1, block: light },
                  { ...bar, x1: bar.x2, x2: bar.x2, block: light }
              ]
    );
    return [trimmed(top), trimmed(bottom), boxes[2]!, boxes[3]!, ...corners];
}

/** The box flying through a hoop is looked for in: its opening, a block deep
 *  each way along the course. */
function openingOf(center: Point3, alongX: boolean, half: number): Volume {
    return alongX
        ? {
              x1: center.x - 1,
              x2: center.x + 1,
              y1: center.y - half,
              y2: center.y + half,
              z1: center.z - half,
              z2: center.z + half
          }
        : {
              x1: center.x - half,
              x2: center.x + half,
              y1: center.y - half,
              y2: center.y + half,
              z1: center.z - 1,
              z2: center.z + 1
          };
}

/** The course in its own blocks, before it is put over a site: the ring
 *  centres, boosters and pillars round (0, 0), at height 0. */
function shape(
    options: Pick<EventOptions<"elytra-race">, "obstacles">,
    seed: string,
    layout: boatRace.Layout
) {
    const random = seeded(`elytra-race-${seed}`);
    const placed = ringsAlong(layout);
    if (!placed) return null;
    const rings = placed.map((one, index) => {
        const rise = index === 0 ? 0 : Math.round((random() * 2 - 1) * SWING);
        return { ...one, y: rise };
    });
    // Never steeper than a quarter of the way between two rings, the last one
    // back to the start too: each ring but the start brought within reach of
    // both its neighbours, or level with the one before when it cannot be.
    const most = (one: (typeof rings)[number], other: (typeof rings)[number]) =>
        Math.floor(Math.hypot(one.x - other.x, one.z - other.z) / 4);
    for (let pass = 0; pass < 4; pass += 1)
        for (let index = 1; index < rings.length; index += 1) {
            const before = rings[index - 1]!;
            const after = rings[(index + 1) % rings.length]!;
            const one = rings[index]!;
            const low = Math.max(before.y - most(one, before), after.y - most(one, after));
            const high = Math.min(before.y + most(one, before), after.y + most(one, after));
            rings[index] = {
                ...one,
                y: low <= high ? Math.max(low, Math.min(high, one.y)) : before.y
            };
        }
    // Should that still leave a climb too steep anywhere, the course is flown level.
    const steep = rings.some((one, index) => {
        const after = rings[(index + 1) % rings.length]!;
        return Math.abs(after.y - one.y) > most(one, after);
    });
    if (steep) rings.forEach((one, index) => (rings[index] = { ...one, y: 0 }));
    const legs = rings.map((from, index) => ({ from, to: rings[(index + 1) % rings.length]! }));
    const boosters = legs.map(({ from, to }) => {
        const center = {
            x: Math.round((from.x + to.x) / 2),
            y: Math.round((from.y + to.y) / 2),
            z: Math.round((from.z + to.z) / 2)
        };
        return { center, alongX: Math.abs(to.x - from.x) >= Math.abs(to.z - from.z) };
    });
    const pillars: Volume[] = [];
    for (const { from, to } of legs)
        for (
            let count = 0, tries = 0;
            count < PILLARS[options.obstacles] && tries < 40;
            tries += 1
        ) {
            const along = 0.2 + random() * 0.6;
            const length = Math.hypot(to.x - from.x, to.z - from.z) || 1;
            // Off to one side of the line, square to it.
            const side = random() < 0.5 ? -1 : 1;
            const off = CLEARANCE + 1 + PILLAR + Math.floor(random() * 3);
            const px = Math.round(
                from.x + (to.x - from.x) * along + (side * off * -(to.z - from.z)) / length
            );
            const pz = Math.round(
                from.z + (to.z - from.z) * along + (side * off * (to.x - from.x)) / length
            );
            const py = Math.round(from.y + (to.y - from.y) * along);
            const pillar = {
                x1: px,
                x2: px + PILLAR - 1,
                y1: py - PILLAR_REACH,
                y2: py + PILLAR_REACH,
                z1: pz,
                z2: pz + PILLAR - 1
            };
            if (legs.some((leg) => nearLine(pillar, leg.from, leg.to) < CLEARANCE)) continue;
            if (pillars.some((other) => overlaps(grown(other, 2), pillar))) continue;
            pillars.push(pillar);
            count += 1;
        }
    return { layout, rings, boosters, pillars };
}

/** How squarely a ring is crossed: the least of the two lines' share along its
 *  axis, 1 straight through, 0 along the frame. */
function crossing(
    from: { x: number; z: number },
    at: { x: number; z: number },
    to: { x: number; z: number },
    du: number,
    dv: number
): number {
    return Math.min(share(from, at, du, dv), share(at, to, du, dv));
}

/** How much of the line from one point to another runs along an axis. */
function share(
    a: { x: number; z: number },
    b: { x: number; z: number },
    du: number,
    dv: number
): number {
    return ((b.x - a.x) * du + (b.z - a.z) * dv) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
}

const AXES = [
    { du: 1, dv: 0 },
    { du: -1, dv: 0 },
    { du: 0, dv: 1 },
    { du: 0, dv: -1 }
] as const;

/** The furthest along the track, in its points, one ring is from the next. */
const REACH_POINTS = 4;

/**
 * The rings over a track: the start on its gate, then the fewest more, each
 * over a point of the track and facing one of the four ways, such that every
 * line from one ring to the next crosses both squarely (`SQUARE`). Answers
 * none when the track turns too sharply for any; the caller tries another.
 */
function ringsAlong(
    layout: boatRace.Layout
): { x: number; z: number; du: number; dv: number }[] | null {
    const points = layout.points;
    const count = points.length;
    const gate = layout.gates[0]!;
    const step = boatRace.STEP;
    const pointAt = (offset: number) => {
        const one = points[(gate.at + offset) % count]!;
        return { x: one.u * step, z: one.v * step };
    };
    const startAxis = AXES.findIndex((axis) => axis.du === gate.du && axis.dv === gate.dv);
    // best[offset][axis]: the fewest rings to reach there, and from where.
    type Best = { rings: number; from: { offset: number; axis: number } | null };
    const best: (Best | undefined)[][] = Array.from({ length: count + 1 }, () => []);
    best[0]![startAxis] = { rings: 1, from: null };
    for (let offset = 0; offset < count; offset += 1)
        for (let axis = 0; axis < AXES.length; axis += 1) {
            const here = best[offset]![axis];
            if (!here) continue;
            for (let ahead = 1; ahead <= REACH_POINTS && offset + ahead <= count; ahead += 1) {
                const to = offset + ahead;
                const from = pointAt(offset);
                const at = pointAt(to);
                for (let next = 0; next < AXES.length; next += 1) {
                    // Back at the start, it is the start ring, facing its own way.
                    if (to === count && next !== startAxis) continue;
                    const square = Math.min(
                        share(from, at, AXES[axis]!.du, AXES[axis]!.dv),
                        share(from, at, AXES[next]!.du, AXES[next]!.dv)
                    );
                    if (square < SQUARE) continue;
                    const rings = here.rings + (to === count ? 0 : 1);
                    const known = best[to]![next];
                    if (!known || rings < known.rings)
                        best[to]![next] = { rings, from: { offset, axis } };
                }
            }
        }
    const end = best[count]![startAxis];
    if (!end || end.rings < RINGS_LEAST || end.rings > boatRace.GATES.most) return null;
    const chosen: { offset: number; axis: number }[] = [];
    for (let at = end.from; at; at = best[at.offset]![at.axis]!.from) chosen.unshift(at);
    return chosen.map(({ offset, axis }) => ({ ...pointAt(offset), ...AXES[axis]! }));
}

const grown = (box: Volume, by: number): Volume => ({
    x1: Math.min(box.x1, box.x2) - by,
    x2: Math.max(box.x1, box.x2) + by,
    y1: Math.min(box.y1, box.y2) - by,
    y2: Math.max(box.y1, box.y2) + by,
    z1: Math.min(box.z1, box.z2) - by,
    z2: Math.max(box.z1, box.z2) + by
});

/** Whether two boxes share a block. */
export function overlaps(one: Volume, other: Volume): boolean {
    const span = (a1: number, a2: number, b1: number, b2: number) =>
        Math.min(a1, a2) <= Math.max(b1, b2) && Math.min(b1, b2) <= Math.max(a1, a2);
    return (
        span(one.x1, one.x2, other.x1, other.x2) &&
        span(one.y1, one.y2, other.y1, other.y2) &&
        span(one.z1, one.z2, other.z1, other.z2)
    );
}

/** The least distance from any block of a box (its whole cube) to the line
 *  from one ring's centre to the next's, centre to centre. */
export function nearLine(box: Volume, from: Point3, to: Point3): number {
    const a = { x: from.x + 0.5, y: from.y + 0.5, z: from.z + 0.5 };
    const b = { x: to.x + 0.5, y: to.y + 0.5, z: to.z + 0.5 };
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 2));
    let least = Infinity;
    const low = {
        x: Math.min(box.x1, box.x2),
        y: Math.min(box.y1, box.y2),
        z: Math.min(box.z1, box.z2)
    };
    const high = {
        x: Math.max(box.x1, box.x2) + 1,
        y: Math.max(box.y1, box.y2) + 1,
        z: Math.max(box.z1, box.z2) + 1
    };
    for (let at = 0; at <= steps; at += 1) {
        const t = at / steps;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
        const dx = Math.max(low.x - p.x, 0, p.x - high.x);
        const dy = Math.max(low.y - p.y, 0, p.y - high.y);
        const dz = Math.max(low.z - p.z, 0, p.z - high.z);
        least = Math.min(least, Math.hypot(dx, dy, dz));
    }
    return least;
}

/**
 * The course over a site: its middle over the column, the start ring's centre
 * at `y`. The same run gives the same course wherever it is put.
 */
export function course(
    options: Pick<EventOptions<"elytra-race">, "laps" | "obstacles">,
    seed: string,
    site: { x: number; z: number },
    y: number
): Course {
    // The run's own track first, then a few more drawn from it, then the plain
    // one: the first whose rings are all crossed squarely and fly clear.
    let built: Course | null = null;
    for (let attempt = 0; attempt <= LAYOUT_TRIES; attempt += 1) {
        const layout =
            attempt === LAYOUT_TRIES
                ? boatRace.plainLayout()
                : boatRace.laidOut(attempt === 0 ? seed : `${seed}~${attempt}`);
        const made = shape(options, seed, layout);
        if (!made) continue;
        built = laid(options, made, site, y);
        if (courseProblems(built).length === 0) return built;
    }
    return built!;
}

/** How many more tracks are drawn for a run whose own cannot take rings. */
const LAYOUT_TRIES = 8;

function laid(
    options: Pick<EventOptions<"elytra-race">, "laps" | "obstacles">,
    made: NonNullable<ReturnType<typeof shape>>,
    site: { x: number; z: number },
    y: number
): Course {
    const start = made.rings[0]!;
    // The pad, behind the start ring and over it.
    const back = { x: start.x - start.du * PAD_BACK, z: start.z - start.dv * PAD_BACK };
    const across = start.du !== 0;
    const padLocal: Volume = across
        ? {
              x1: back.x - Math.sign(start.du) * (PAD_DEPTH - 1),
              x2: back.x,
              z1: back.z - PAD_HALF,
              z2: back.z + PAD_HALF,
              y1: PAD_RISE,
              y2: PAD_RISE
          }
        : {
              x1: back.x - PAD_HALF,
              x2: back.x + PAD_HALF,
              z1: back.z - Math.sign(start.dv) * (PAD_DEPTH - 1),
              z2: back.z,
              y1: PAD_RISE,
              y2: PAD_RISE
          };
    // Everything, to find the middle and the bounds.
    const reachOf = [
        ...made.rings.map((one) =>
            grown({ x1: one.x, x2: one.x, y1: one.y, y2: one.y, z1: one.z, z2: one.z }, FRAME)
        ),
        ...made.pillars,
        grown(padLocal, 1)
    ];
    const lowX = Math.min(...reachOf.map((one) => Math.min(one.x1, one.x2)));
    const highX = Math.max(...reachOf.map((one) => Math.max(one.x1, one.x2)));
    const lowZ = Math.min(...reachOf.map((one) => Math.min(one.z1, one.z2)));
    const highZ = Math.max(...reachOf.map((one) => Math.max(one.z1, one.z2)));
    const dx = site.x - Math.round((lowX + highX) / 2);
    const dz = site.z - Math.round((lowZ + highZ) / 2);
    const moved = <T extends Volume>(box: T): T => ({
        ...box,
        x1: box.x1 + dx,
        x2: box.x2 + dx,
        y1: box.y1 + y,
        y2: box.y2 + y,
        z1: box.z1 + dz,
        z2: box.z2 + dz
    });
    const at = (one: { x: number; y: number; z: number }): Point3 => ({
        x: one.x + dx,
        y: one.y + y,
        z: one.z + dz
    });
    const rings: Hoop[] = made.rings.map((one) => {
        const center = at(one);
        return { center, alongX: one.du !== 0, box: openingOf(center, one.du !== 0, RING) };
    });
    const boosters: Hoop[] = made.boosters.map((one) => {
        const center = at(one.center);
        return { center, alongX: one.alongX, box: openingOf(center, one.alongX, BOOST) };
    });
    const pillars = made.pillars.map(moved);
    const pad: Box = { ...moved(padLocal), block: PAD_BLOCK };
    const rim = grown(pad, 1);
    const rimBoxes: Box[] = [
        { ...rim, y1: pad.y1 + 1, y2: pad.y1 + 2, x2: rim.x1, block: RIM_BLOCK },
        { ...rim, y1: pad.y1 + 1, y2: pad.y1 + 2, x1: rim.x2, block: RIM_BLOCK },
        {
            ...rim,
            y1: pad.y1 + 1,
            y2: pad.y1 + 2,
            x1: rim.x1 + 1,
            x2: rim.x2 - 1,
            z2: rim.z1,
            block: RIM_BLOCK
        },
        {
            ...rim,
            y1: pad.y1 + 1,
            y2: pad.y1 + 2,
            x1: rim.x1 + 1,
            x2: rim.x2 - 1,
            z1: rim.z2,
            block: RIM_BLOCK
        }
    ];
    const respawnAt = (ring: (typeof made.rings)[number]): Spot => {
        const center = at(ring);
        return {
            x: center.x - ring.du * 6 + 0.5,
            y: center.y + 1,
            z: center.z - ring.dv * 6 + 0.5,
            yaw: yawOf(ring.du, ring.dv)
        };
    };
    const lowest = Math.min(...rings.map((one) => one.center.y)) - FRAME;
    const fallY = lowest - FALL;
    const highest = Math.max(
        pad.y1 + 3,
        ...rings.map((one) => one.center.y + FRAME),
        ...pillars.map((one) => one.y2)
    );
    const boxes: Box[] = [
        pad,
        ...rimBoxes,
        ...rings.flatMap((ring, index) =>
            index === 0 ? frame(ring, RING, START_BLOCK, LIGHT) : frame(ring, RING, RING_BLOCK)
        ),
        ...boosters.flatMap((one) => frame(one, BOOST, BOOST_BLOCK)),
        ...pillars.map((one) => ({ ...one, block: PILLAR_BLOCK }))
    ];
    return {
        layout: made.layout,
        laps: options.laps,
        height: y,
        rings,
        boosters,
        pillars,
        pad,
        respawns: made.rings.map(respawnAt),
        start: {
            ...respawnAt(start),
            x: respawnAt(start).x - start.du * 4,
            z: respawnAt(start).z - start.dv * 4
        },
        fallY,
        boxes,
        volume: {
            x1: lowX + dx - 1,
            y1: fallY - 1,
            z1: lowZ + dz - 1,
            x2: highX + dx + 1,
            y2: highest + 1,
            z2: highZ + dz + 1
        },
        reach: Math.ceil(Math.hypot(highX - lowX, highZ - lowZ) / 2) + 2
    };
}

/** Where each of `count` racers waits: on the pad, in rows across it, facing
 *  the start ring. */
export function spots(built: Course, count: number): Spot[] {
    const pad = built.pad;
    const yaw = built.respawns[0]!.yaw;
    const cells: { x: number; z: number }[] = [];
    for (let x = Math.min(pad.x1, pad.x2); x <= Math.max(pad.x1, pad.x2); x += 1)
        for (let z = Math.min(pad.z1, pad.z2); z <= Math.max(pad.z1, pad.z2); z += 1)
            cells.push({ x, z });
    return Array.from({ length: count }, (_, index) => {
        const cell = cells[index % cells.length]!;
        return { x: cell.x + 0.5, y: pad.y1 + 1, z: cell.z + 0.5, yaw };
    });
}

/** Standing on the pad. */
export function onPad(built: Course, at: { x: number; y: number; z: number }): boolean {
    const pad = built.pad;
    return (
        at.y >= pad.y1 + 0.5 &&
        at.y <= pad.y1 + 3 &&
        at.x >= Math.min(pad.x1, pad.x2) - 0.5 &&
        at.x <= Math.max(pad.x1, pad.x2) + 1.5 &&
        at.z >= Math.min(pad.z1, pad.z2) - 0.5 &&
        at.z <= Math.max(pad.z1, pad.z2) + 1.5
    );
}

/** The pad's floor taken away, at "Go!". */
export function padGone(built: Course): string {
    const pad = built.pad;
    return `execute in minecraft:overworld run fill ${pad.x1} ${pad.y1} ${pad.z1} ${pad.x2} ${pad.y2} ${pad.z2} minecraft:air replace ${PAD_BLOCK}`;
}

/** Whether boxes are an elytra course's: it has boosters. */
export function isCourse(boxes: readonly Pick<Box, "block">[]): boolean {
    return boxes.some((one) => one.block === BOOST_BLOCK);
}

/**
 * Whatever keeps a course from being fair: rings too steep from one to the
 * next, a pillar too near the line between two, anything built where a ring or
 * a booster is flown through, or outside the volume.
 */
export function courseProblems(built: Course): string[] {
    const problems: string[] = [];
    const count = built.rings.length;
    built.rings.forEach((one, index) => {
        const next = built.rings[(index + 1) % count]!;
        const before = built.rings[(index + count - 1) % count]!;
        // Crossed one way or the other, both lines the same way.
        const square = Math.max(
            ...[1, -1].map((sign) =>
                crossing(
                    before.center,
                    one.center,
                    next.center,
                    one.alongX ? sign : 0,
                    one.alongX ? 0 : sign
                )
            )
        );
        if (square < SQUARE) problems.push(`ring ${index} crossed along its frame`);
        const flat = Math.hypot(next.center.x - one.center.x, next.center.z - one.center.z);
        if (Math.abs(next.center.y - one.center.y) > flat / 4)
            problems.push(`too steep after ring ${index}`);
        for (const pillar of built.pillars)
            if (nearLine(pillar, one.center, next.center) < CLEARANCE)
                problems.push(`a pillar in the way after ring ${index}`);
        const booster = built.boosters[index]!;
        if (nearLine(booster.box, one.center, next.center) > 0.5)
            problems.push(`booster ${index} off the line`);
        // Nothing else built near the line: another ring's frame, the pad.
        const own = [one, next, booster].map((hoop) => grown(hoop.box, 2));
        for (const box of built.boxes) {
            if (box.block === PILLAR_BLOCK || own.some((near) => overlaps(near, box))) continue;
            if (nearLine(box, one.center, next.center) < 1.5)
                problems.push(`${box.block} in the way after ring ${index}`);
        }
    });
    const open = [...built.rings, ...built.boosters].map((one) => one.box);
    for (const box of built.boxes) {
        if (open.some((one) => overlaps(one, box))) problems.push(`${box.block} in an opening`);
        if (!inside(built.volume, box)) problems.push(`${box.block} outside the volume`);
    }
    // A racer put back is put back in the open.
    for (const spot of [built.start, ...built.respawns]) {
        const at = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) };
        const body = { x1: at.x, x2: at.x, y1: at.y, y2: at.y + 1, z1: at.z, z2: at.z };
        if (built.boxes.some((box) => overlaps(box, body)))
            problems.push("a restart inside the course");
    }
    if (built.fallY <= built.volume.y1) problems.push("falls out of the volume");
    return problems;
}

function inside(volume: Volume, box: Volume): boolean {
    return (
        Math.min(box.x1, box.x2) >= volume.x1 &&
        Math.max(box.x1, box.x2) <= volume.x2 &&
        Math.min(box.y1, box.y2) >= volume.y1 &&
        Math.max(box.y1, box.y2) <= volume.y2 &&
        Math.min(box.z1, box.z2) >= volume.z1 &&
        Math.max(box.z1, box.z2) <= volume.z2
    );
}

// ------------------------------------------------------------------ items

const MARK = "minecraft:custom_data={polaris_event:1b}";

/** The marked elytra, worn, never wearing out. */
export function elytraLine(name: string, items: Flavour["items"]): string {
    return items === "components"
        ? `item replace entity ${name} armor.chest with minecraft:elytra[${MARK},minecraft:unbreakable={}] 1`
        : `item replace entity ${name} armor.chest with minecraft:elytra{polaris_event:1b,Unbreakable:1b} 1`;
}

/** Marked rockets, a short burst each, for `who`. */
export function rocketLine(who: string, items: Flavour["items"], count: number): string {
    return items === "components"
        ? `give ${who} minecraft:firework_rocket[${MARK},minecraft:fireworks={flight_duration:1}] ${count}`
        : `give ${who} minecraft:firework_rocket{polaris_event:1b,Fireworks:{Flight:1b}} ${count}`;
}

/** Everything a racer needs to fly, once they are in the air or about to be. */
export function flyLines(name: string, items: Flavour["items"]): string[] {
    return [elytraLine(name, items), rocketLine(name, items, START_ROCKETS)];
}

// ------------------------------------------------------------------ in the game

export const PASSED_SCORE = "pe_epass";
export const NEXT_SCORE = "pe_enext";
export const LAST_SCORE = "pe_elast";
export const FINISH_SCORE = "pe_efin";
export const CUT_SCORE = "pe_ecut";
/** Rockets a racer is owed, handed out by the quick look. */
export const OWED_SCORE = "pe_erkt";
/** The last booster a racer flew through, plus one. */
const BOOSTED_SCORE = "pe_ebst";
/** Looks left after a racer is put back before a fall or a landing counts. */
export const GRACE_SCORE = "pe_egrc";
/** Falls and landings in a row since a ring was last passed. */
export const TRIES_SCORE = "pe_etry";
/** The passes the quick look last saw, to tell when a ring was passed. */
const SEEN_SCORE = "pe_eseen";
export const OBJECTIVE = "polaris_elytra";
const SCALE = 64;
/** The most rings, and boosters, a course has: a boat race's gates. */
const MOST = boatRace.GATES.most;

const OWN = [
    PASSED_SCORE,
    NEXT_SCORE,
    LAST_SCORE,
    FINISH_SCORE,
    CUT_SCORE,
    OWED_SCORE,
    BOOSTED_SCORE,
    GRACE_SCORE,
    TRIES_SCORE,
    SEEN_SCORE
];

export const SCORES_ADDED = [...OWN, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);
export const SCORES_REMOVED = OWN.map((name) => `scoreboard objectives remove ${name}`);

/** A racer coming in: nothing passed, or - back in a race they left - the
 *  passes they had made over a course of `rings`. */
export function racerScores(name: string, passed = 0, rings = 1): string[] {
    return [
        `scoreboard players set ${name} ${PASSED_SCORE} ${passed}`,
        `scoreboard players set ${name} ${NEXT_SCORE} ${passed % rings}`,
        `scoreboard players set ${name} ${LAST_SCORE} ${passed > 0 ? (passed - 1) % rings : -1}`,
        `scoreboard players set ${name} ${FINISH_SCORE} 0`,
        `scoreboard players set ${name} ${CUT_SCORE} 0`,
        `scoreboard players set ${name} ${OWED_SCORE} 0`,
        `scoreboard players set ${name} ${BOOSTED_SCORE} 0`,
        `scoreboard players set ${name} ${GRACE_SCORE} 0`,
        `scoreboard players set ${name} ${TRIES_SCORE} 0`,
        `scoreboard players set ${name} ${SEEN_SCORE} ${passed}`,
        `tag ${name} remove ${SENT_TAG}`
    ];
}

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** The `if score` tests that `#px`/`#py`/`#pz` lie inside box `prefix``index`. */
function inBox(prefix: string, index: number): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`p${axis}`)} >= ${score(`${prefix}${index}${axis}1`)} if score ${score(`p${axis}`)} <= ${score(`${prefix}${index}${axis}2`)}`
        )
        .join(" ");
}

/**
 * The functions, by name under `polaris:elytra/`. Every tick, for every racer
 * still racing: at the ring they are to pass next, it counts - a rocket owed,
 * the next ring on, the finish noted to the tick; at any other ring but the
 * last they passed, once over the start, they are marked to be sent back. A
 * booster is worth its rockets once each time it is flown through.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @a[tag=pe_in,scores={${FINISH_SCORE}=0},distance=0..] run function polaris:elytra/racer`
    ],
    racer: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        ...Array.from({ length: MOST }, (_, index) => [
            `execute if score ${score("rings")} matches ${index + 1}.. if score @s ${NEXT_SCORE} matches ${index} ${inBox("r", index)} run function polaris:elytra/pass`,
            `execute if score ${score("rings")} matches ${index + 1}.. if score @s ${PASSED_SCORE} matches 1.. unless score @s ${NEXT_SCORE} matches ${index} unless score @s ${LAST_SCORE} matches ${index} ${inBox("r", index)} run scoreboard players set @s ${CUT_SCORE} 1`
        ]).flat(),
        ...Array.from({ length: MOST }, (_, index) => {
            const at = `execute if score ${score("boosters")} matches ${index + 1}.. unless score @s ${BOOSTED_SCORE} matches ${index + 1} ${inBox("b", index)}`;
            return [
                `${at} run playsound minecraft:entity.firework_rocket.launch master @s ~ ~ ~ 1 1.2`,
                `${at} run scoreboard players add @s ${OWED_SCORE} ${BOOST_ROCKETS}`,
                `${at} run scoreboard players set @s ${BOOSTED_SCORE} ${index + 1}`
            ];
        }).flat()
    ],
    pass: [
        `scoreboard players add @s ${PASSED_SCORE} 1`,
        `scoreboard players add @s ${OWED_SCORE} ${RING_ROCKETS}`,
        `scoreboard players operation @s ${LAST_SCORE} = @s ${NEXT_SCORE}`,
        `scoreboard players add @s ${NEXT_SCORE} 1`,
        `execute if score @s ${NEXT_SCORE} >= ${score("rings")} run scoreboard players set @s ${NEXT_SCORE} 0`,
        "playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1.5",
        `execute if score @s ${PASSED_SCORE} >= ${score("total")} store result score @s ${FINISH_SCORE} run time query gametime`
    ]
};

/** The corner of a course's pad: what names the course the pack is armed for. */
function cornerOf(
    boxes: readonly Pick<Box, "x1" | "z1" | "block">[]
): { x: number; z: number } | null {
    const pad = boxes.find((one) => one.block === PAD_BLOCK);
    return pad ? { x: pad.x1, z: pad.z1 } : null;
}

/**
 * Switched on for one course, at "Go!": how many rings, and how many passes
 * make the race (the start, then every ring of every lap), each ring's and
 * booster's opening in 64ths, and the switch last.
 */
export function armLines(built: Course): string[] {
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const box = (prefix: string, index: number, one: Volume) =>
        (["x", "y", "z"] as const).flatMap((axis) => {
            const low = Math.min(one[`${axis}1`], one[`${axis}2`]);
            const high = Math.max(one[`${axis}1`], one[`${axis}2`]);
            return [
                set(`${prefix}${index}${axis}1`, low * SCALE),
                set(`${prefix}${index}${axis}2`, (high + 1) * SCALE - 1)
            ];
        });
    const corner = cornerOf(built.boxes)!;
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("tx", corner.x),
        set("tz", corner.z),
        set("rings", built.rings.length),
        set("boosters", built.boosters.length),
        set("total", built.laps * built.rings.length + 1),
        ...built.rings.flatMap((one, index) => box("r", index, one.box)),
        ...built.boosters.flatMap((one, index) => box("b", index, one.box)),
        set("on", 1)
    ];
}

/**
 * Switched off - only while the switch is still this course's - and any rocket
 * still flying over it put out. Safe when it was never on.
 */
export function stopLines(
    boxes: readonly Pick<Box, "x1" | "y1" | "z1" | "x2" | "y2" | "z2" | "block">[]
): string[] {
    const corner = cornerOf(boxes);
    if (!corner) return [];
    const low = {
        x: Math.min(...boxes.map((one) => Math.min(one.x1, one.x2))),
        y: Math.min(...boxes.map((one) => Math.min(one.y1, one.y2))),
        z: Math.min(...boxes.map((one) => Math.min(one.z1, one.z2)))
    };
    const high = {
        x: Math.max(...boxes.map((one) => Math.max(one.x1, one.x2))),
        y: Math.max(...boxes.map((one) => Math.max(one.y1, one.y2))),
        z: Math.max(...boxes.map((one) => Math.max(one.z1, one.z2)))
    };
    return [
        `execute if score ${score("tx")} matches ${corner.x} if score ${score("tz")} matches ${corner.z} run scoreboard players set ${score("on")} 0`,
        `execute in minecraft:overworld run kill @e[type=minecraft:firework_rocket,x=${low.x - 16},y=${low.y - 32},z=${low.z - 16},dx=${high.x - low.x + 32},dy=${high.y - low.y + 48},dz=${high.z - low.z + 32}]`
    ];
}

/** Every racer's passes and finish tick, as the game has them. */
export const READ_PASSED = `execute as @a[tag=pe_in,scores={${PASSED_SCORE}=0..}] run scoreboard players get @s ${PASSED_SCORE}`;
export const READ_FINISHED = `execute as @a[tag=pe_in,scores={${FINISH_SCORE}=1..}] run scoreboard players get @s ${FINISH_SCORE}`;

const RESET_TAG = "pe_ereset";
/**
 * A racer put back in the air whom the server has not yet seen off the ground.
 * Until their game answers the teleport the server keeps the `OnGround` they
 * had where they landed, so the next look read them as landed again and put
 * them back again, and again: a racer held in one spot in mid-air, every
 * second, until the server's own check kicked them for flying ("Flying is not
 * enabled on this server", logged as "kicked for floating too long"). The same
 * trap the dropper fell into (`dropper.SENT_TAG`).
 */
export const SENT_TAG = "pe_esent";

/**
 * How many looks (`QUICK_MS`, 0.4 s) a racer put back has before a fall or a
 * landing counts again: a fall past the course or onto something in that time
 * is theirs to fly out of. Short enough that whoever never opens their wings
 * is put back before the server's floating check (80 ticks in the air) could
 * count the whole of it.
 */
export const GRACE_LOOKS = 8;

/**
 * Falls and landings in a row, no ring passed, after which a racer is told how
 * to open their wings - and, landing on something, left standing on it rather
 * than put back in the air again: a racer who has not found the jump to glide
 * was otherwise dropped from the same spot every second and a half until they
 * gave up and left.
 */
export const TRIES_MOST = 3;

/**
 * Put back in the air, the server's floating check sees a player who does not
 * glide as floating, and a teleport does not start its count over: four
 * seconds of it across a few put-backs is a kick for flying where flight is
 * off. A moment of Levitation, which that check never counts, starts it over
 * at every put-back, and holds them up while they get ready.
 */
const PUT_BACK_LIFT = "minecraft:levitation 1 0 true";

/**
 * The quick look at a race, with selectors alone: whoever is racing and has
 * fallen below the course, landed on anything, or was seen at a ring out of
 * turn is told why and put back behind the last ring they passed - before the
 * start ring if none - and the rockets anybody is owed handed out, one a look.
 *
 * A racer just put back has `GRACE_LOOKS` before a fall or a landing counts.
 * After `TRIES_MOST` falls and landings in a row with no ring passed they are
 * told how to fly, and a landing no longer puts them back: they stay on what
 * they landed on, to jump off and glide. A fall under the course still does.
 */
export function quickLines(
    built: Course,
    items: Flavour["items"] | null,
    told: { fell: string; cut: string; howTo: string }
): string[] {
    const volume = built.volume;
    const x = volume.x1 - 16;
    const z = volume.z1 - 16;
    const y = built.fallY - 64;
    const under = `x=${x},y=${y},z=${z},dx=${volume.x2 - volume.x1 + 32},dy=${built.fallY - y},dz=${volume.z2 - volume.z1 + 32}`;
    const counts = `${FINISH_SCORE}=0,${GRACE_SCORE}=..0`;
    // Racing, and past the grace of their last put-back.
    const ready = `tag=pe_in,scores={${counts}}`;
    // The same, and not yet out of tries: a landing still puts them back.
    const trying = `tag=pe_in,scores={${counts},${TRIES_SCORE}=..${TRIES_MOST - 1}}`;
    const world = "execute in minecraft:overworld";
    const lines = [
        // Racers from before these counts: none of them set yet.
        `scoreboard players add @a[tag=pe_in] ${GRACE_SCORE} 0`,
        `scoreboard players add @a[tag=pe_in] ${TRIES_SCORE} 0`,
        `scoreboard players add @a[tag=pe_in] ${SEEN_SCORE} 0`,
        // A ring passed since the last look: their tries start over.
        `execute as @a[tag=pe_in] if score @s ${PASSED_SCORE} > @s ${SEEN_SCORE} run scoreboard players set @s ${TRIES_SCORE} 0`,
        `execute as @a[tag=pe_in] run scoreboard players operation @s ${SEEN_SCORE} = @s ${PASSED_SCORE}`,
        `scoreboard players remove @a[tag=pe_in,scores={${GRACE_SCORE}=1..}] ${GRACE_SCORE} 1`,
        `${world} as @a[${ready},${under}] run tellraw @s ${told.fell}`,
        `${world} run tag @a[${ready},${under}] add ${RESET_TAG}`,
        `tag @a[tag=${SENT_TAG},nbt={OnGround:0b}] remove ${SENT_TAG}`,
        `execute as @a[${trying},tag=!${RESET_TAG},tag=!${SENT_TAG},nbt={OnGround:1b}] run tellraw @s ${told.fell}`,
        `tag @a[${trying},tag=!${SENT_TAG},nbt={OnGround:1b}] add ${RESET_TAG}`,
        `scoreboard players add @a[tag=${RESET_TAG}] ${TRIES_SCORE} 1`,
        `execute as @a[tag=${RESET_TAG},scores={${TRIES_SCORE}=${TRIES_MOST}..}] run tellraw @s ${told.howTo}`,
        `execute as @a[tag=pe_in,tag=!${RESET_TAG},scores={${CUT_SCORE}=1}] run tellraw @s ${told.cut}`,
        `tag @a[tag=pe_in,scores={${CUT_SCORE}=1}] add ${RESET_TAG}`,
        ...[built.start, ...built.respawns].map(
            (spot, index) =>
                `${world} run tp @a[tag=${RESET_TAG},scores={${LAST_SCORE}=${index - 1}}] ${spot.x.toFixed(3)} ${spot.y.toFixed(3)} ${spot.z.toFixed(3)} ${spot.yaw.toFixed(1)} 0.0`
        ),
        `effect give @a[tag=${RESET_TAG}] ${PUT_BACK_LIFT}`,
        `scoreboard players set @a[tag=${RESET_TAG}] ${GRACE_SCORE} ${GRACE_LOOKS}`,
        `scoreboard players set @a[tag=${RESET_TAG}] ${CUT_SCORE} 0`,
        `tag @a[tag=${RESET_TAG}] add ${SENT_TAG}`,
        `tag @a remove ${RESET_TAG}`
    ];
    if (items)
        lines.push(
            rocketLine(`@a[tag=pe_in,scores={${OWED_SCORE}=1..}]`, items, 1),
            `scoreboard players remove @a[tag=pe_in,scores={${OWED_SCORE}=1..}] ${OWED_SCORE} 1`
        );
    return lines;
}

/** Where a racer who has made `passed` passes goes back in. */
export function resumeSpot(built: Course, passed: number): Spot {
    if (passed <= 0) return built.start;
    return built.respawns[(passed - 1) % built.rings.length]!;
}

/** The lap a racer is on and the rings passed on it, from the passes. */
export function progressOf(built: Course, passed: number): { lap: number; ring: number } {
    const rings = built.rings.length;
    if (passed <= 0) return { lap: 1, ring: 0 };
    return {
        lap: Math.min(built.laps, Math.floor((passed - 1) / rings) + 1),
        ring: (passed - 1) % rings
    };
}

/** The ring a racer with `passed` passes flies at next. */
export function nextRing(built: Course, passed: number): Hoop {
    return built.rings[Math.max(0, passed) % built.rings.length]!;
}
