/**
 * A spleef arena, floating high over a site: several floors of snow stacked one
 * under the other, each walled in glass three blocks high so nobody walks off
 * an edge, and a glass net under the lowest that catches whoever falls through
 * it - who is then out, and sent back to where they were. No lava anywhere:
 * falling through the last floor is the lava.
 *
 * Each run plays one of three ways, drawn for it among those the event allows
 * (`variantFor`):
 * - shovel: everybody has a shovel that breaks the snow and nothing else;
 * - decay: no tools - the snow a player stands on turns red, and is gone on the
 *   next look, so standing still is falling;
 * - snowballs: a snowball breaks the snow it hits (`snowball-pack.ts`).
 *
 * Nobody can wait the others out. Whoever dropped to a lower floor and
 * crouched there, or kept to an untouched corner, used to make the rest dig
 * the whole floor blind. So every player inside glows - seen through the snow
 * - and from `SHRINK_AFTER_MS` after the start the floors close in from the
 * walls one at a time, the top one first, a ring every `SHRINK_EVERY_MS`, the
 * next ring turning red first, until it is gone and the one under it starts:
 * whoever is left drops to the next floor down, and the game runs on until
 * there is no floor left (`shrinkLines`).
 *
 * Built only into air, taken out only where its own blocks still are.
 */

import { SPLEEF_VARIANTS, type EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";
import { seeded, shuffled } from "../trivia-bank";
import * as decor from "./arena-decor";

export const FLOOR: Box["block"] = "minecraft:snow_block";
/** What snow somebody stood on becomes in the decay game, just before it goes. */
export const WARN: Box["block"] = "minecraft:red_concrete";
const NET: Box["block"] = "minecraft:white_stained_glass";
/** A light on each corner of every floor's wall, so the arena reads from afar. */
const CORNER_LIGHT: Box["block"] = "minecraft:sea_lantern";
/** Each floor's wall its own color, so a player knows which floor they are on. */
const WALLS: readonly Box["block"][] = [
    "minecraft:light_blue_stained_glass",
    "minecraft:lime_stained_glass",
    "minecraft:yellow_stained_glass"
];
/** The parts that only frame the game (`arena-decor.SEASON_TRIM`): each
 *  floor's wall and its corner lights. Never the snow, which the snowball pack
 *  reads, nor the net. */
export const TRIM: decor.Trim = {
    [CORNER_LIGHT]: "light",
    [WALLS[0]!]: "wallA",
    [WALLS[1]!]: "wallB",
    [WALLS[2]!]: "wallC"
};
/** How many floors. */
export const LAYERS = 3;
/** How far under each floor the next one is. */
export const LAYER_GAP = 7;
/** How far under the lowest floor the net is. */
const NET_DROP = 4;
const WALL_HEIGHT = 3;
/** Room above the top floor for jumping about. */
const HEADROOM = 5;

/** When the floors start closing in, after the start. */
export const SHRINK_AFTER_MS = 45_000;
/** How often the next ring of every floor goes once they do. */
export const SHRINK_EVERY_MS = 4_000;
/** Glowing for whoever is inside, given again on every look and gone a moment
 *  after the last, so nobody keeps it once they are out - online or not. */
export const GLOW = "effect give @a[tag=pe_in] minecraft:glowing 4 0 true";

export const VARIANTS = SPLEEF_VARIANTS;
export type Variant = (typeof VARIANTS)[number];

/** How a run plays: drawn among the ways the event allows - the same for the
 *  same run, so a restart does not change it. The ways are drawn in `VARIANTS`
 *  order, so with all three a run plays as it did before ways could be left out. */
export function variantFor(runId: string, allowed: readonly Variant[] = VARIANTS): Variant {
    const ways = VARIANTS.filter((way) => allowed.includes(way));
    return shuffled(ways.length > 0 ? ways : VARIANTS, seeded(`${runId}-spleef`))[0] as Variant;
}

export interface Arena {
    /** The top floor's height: a player standing on it has their feet one above. */
    readonly floor: number;
    /** Every floor's height, top first. */
    readonly floors: readonly number[];
    readonly center: { readonly x: number; readonly z: number };
    readonly size: number;
    /** What is built, in order: the net, then each floor with its walls, lowest first. */
    readonly boxes: readonly Box[];
    readonly volume: Volume;
    readonly reach: number;
    /** Where players start, on the top floor, for an arena from a build
     *  (`world-builds/arenas`): its own starts, not the generated ring. */
    readonly starts?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

export function arena(
    options: EventOptions<"spleef">,
    site: { x: number; z: number },
    y: number
): Arena {
    const r = options.size;
    const { x, z } = site;
    const outer = r + 1;
    const floors = Array.from({ length: LAYERS }, (_, index) => y - index * LAYER_GAP);
    const bottom = floors[floors.length - 1]!;
    const wall = (
        x1: number,
        z1: number,
        x2: number,
        z2: number,
        at: number,
        block: Box["block"]
    ): Box => ({ x1, y1: at + 1, z1, x2, y2: at + WALL_HEIGHT, z2, block });
    const boxes: Box[] = [
        {
            x1: x - outer,
            y1: bottom - NET_DROP,
            z1: z - outer,
            x2: x + outer,
            y2: bottom - NET_DROP,
            z2: z + outer,
            block: NET
        }
    ];
    // The lowest first: what stands higher is built over what is already there.
    [...floors].reverse().forEach((at, index) => {
        const block = WALLS[(LAYERS - 1 - index) % WALLS.length]!;
        const light = (cx: number, cz: number): Box => ({
            x1: cx,
            y1: at + WALL_HEIGHT + 1,
            z1: cz,
            x2: cx,
            y2: at + WALL_HEIGHT + 1,
            z2: cz,
            block: CORNER_LIGHT
        });
        boxes.push(
            { x1: x - r, y1: at, z1: z - r, x2: x + r, y2: at, z2: z + r, block: FLOOR },
            wall(x - outer, z - outer, x + outer, z - outer, at, block),
            wall(x - outer, z + outer, x + outer, z + outer, at, block),
            wall(x - outer, z - r, x - outer, z + r, at, block),
            wall(x + outer, z - r, x + outer, z + r, at, block),
            light(x - outer, z - outer),
            light(x + outer, z - outer),
            light(x - outer, z + outer),
            light(x + outer, z + outer)
        );
    });
    return {
        floor: y,
        floors,
        center: { x, z },
        size: r,
        boxes,
        volume: {
            x1: x - outer,
            y1: bottom - NET_DROP,
            z1: z - outer,
            x2: x + outer,
            y2: y + HEADROOM,
            z2: z + outer
        },
        reach: Math.ceil(Math.SQRT2 * outer)
    };
}

/**
 * Where each of `count` players starts: spread evenly round a ring inside the
 * top floor, facing the middle, on top of the snow.
 */
export function spots(arena: Arena, count: number): Spot[] {
    if (arena.starts && arena.starts.length > 0) {
        const starts = arena.starts;
        return Array.from({ length: count }, (_, index) => {
            const at = starts[index % starts.length]!;
            const dx = at.x - arena.center.x;
            const dz = at.z - arena.center.z;
            return {
                x: at.x + 0.5,
                y: at.y,
                z: at.z + 0.5,
                yaw: Math.round((Math.atan2(dx, -dz) * 180) / Math.PI)
            };
        });
    }
    const ring = Math.max(1, Math.round(arena.size * 0.6));
    return Array.from({ length: count }, (_, index) => {
        const angle = (index / Math.max(1, count)) * Math.PI * 2;
        const dx = Math.round(Math.cos(angle) * ring);
        const dz = Math.round(Math.sin(angle) * ring);
        const yaw = Math.round((Math.atan2(dx, -dz) * 180) / Math.PI);
        return {
            x: arena.center.x + dx + 0.5,
            y: arena.floor + 1,
            z: arena.center.z + dz + 0.5,
            yaw
        };
    });
}

/**
 * One cell of `block` at each floor's low corner: the corner the event pack is
 * switched on with (`snowball-pack.armLines`, `tnt-run.armLines`), which is
 * what its `stopLines` read to tell this arena's switch from a newer one's.
 * Exactly the generated floors' own corners; an arena from a build, whose
 * floors are pasted rather than boxes, is told apart by these.
 */
export function floorMarks(arena: Arena, block: Box["block"]): Box[] {
    const r = arena.size;
    const { x, z } = arena.center;
    return arena.floors.map((at) => ({
        x1: x - r,
        y1: at,
        z1: z - r,
        x2: x - r,
        y2: at,
        z2: z - r,
        block
    }));
}

/** Fell through the last floor: below the top of the lowest one. */
export function fell(arena: Arena, y: number): boolean {
    const bottom = arena.floors?.[arena.floors.length - 1] ?? arena.floor;
    return y < bottom + 0.5;
}

/** Every floor as a box of the decay game's red snow: what it may leave behind,
 *  taken out with the rest. */
export function warnBoxes(arena: Arena): Box[] {
    const r = arena.size;
    const { x, z } = arena.center;
    return (arena.floors ?? [arena.floor]).map((at) => ({
        x1: x - r,
        y1: at,
        z1: z - r,
        x2: x + r,
        y2: at,
        z2: z + r,
        block: WARN
    }));
}

/**
 * One look of the decay game: the red snow of the last look gone, and the snow
 * under each player still in it turned red - only inside the arena's own
 * floors, only where it is still the arena's snow. With `rings` closed in, the
 * red ring the floors close in to next is left for `shrinkLines` to take.
 */
export function decayLines(arena: Arena, inArena: string, total = 0): string[] {
    const r = arena.size;
    const { x, z } = arena.center;
    return [
        ...(arena.floors ?? [arena.floor]).flatMap((at, index) => {
            const rings = floorRings(arena, total, index);
            const s = rings > 0 ? r - rings - 1 : r;
            return s < 0
                ? []
                : [
                      `execute in minecraft:overworld run fill ${x - s} ${at} ${z - s} ${x + s} ${at} ${z + s} minecraft:air replace ${WARN}`
                  ];
        }),
        `execute in minecraft:overworld as @a[tag=${inArena}] at @s if block ~ ~-1 ~ ${FLOOR} if entity @s[x=${x - r},dx=${2 * r},z=${z - r},dz=${2 * r},y=${arena.floors?.at(-1) ?? arena.floor},dy=${arena.floor - (arena.floors?.at(-1) ?? arena.floor) + 2}] run setblock ~ ~-1 ~ ${WARN}`
    ];
}

/** How many snowballs a player is topped up to in the snowball game. */
export const SNOWBALLS = 16;

/** How many rings have gone `elapsed` after the start, counted across the
 *  floors top first (`floorRings`): none before `SHRINK_AFTER_MS`, then one
 *  more each `SHRINK_EVERY_MS`. */
export function shrunk(elapsed: number): number {
    if (elapsed < SHRINK_AFTER_MS) return 0;
    return Math.floor((elapsed - SHRINK_AFTER_MS) / SHRINK_EVERY_MS) + 1;
}

/**
 * How many of `rings` - counted across the floors - one floor has lost, the top
 * one (`index` 0) first: a floor starts closing in only once every floor over it
 * is gone, which takes its `size` rings and the middle.
 */
export function floorRings(arena: Arena, rings: number, index: number): number {
    const whole = arena.size + 1;
    return Math.max(0, Math.min(whole, rings - index * whole));
}

/**
 * Every floor, the top one first (`floorRings`), with its outer rings gone and
 * the ring inside them turned red,
 * as a warning - only the arena's own snow, white or red, is ever touched, so
 * the walls and a floor already dug stay as they are. Everything gone up to
 * here goes again on every look, so a missed look is caught up on the next.
 * With every ring gone, so is the middle.
 */
export function shrinkLines(arena: Arena, total: number): string[] {
    if (total <= 0) return [];
    const r = arena.size;
    const { x, z } = arena.center;
    const lines: string[] = [];
    const fill = (
        x1: number,
        z1: number,
        x2: number,
        z2: number,
        at: number,
        to: string,
        from: string
    ) =>
        `execute in minecraft:overworld run fill ${x1} ${at} ${z1} ${x2} ${at} ${z2} ${to} replace ${from}`;
    for (const [index, at] of (arena.floors ?? [arena.floor]).entries()) {
        const rings = floorRings(arena, total, index);
        if (rings <= 0) continue;
        if (rings > r) {
            for (const block of [FLOOR, WARN])
                lines.push(fill(x - r, z - r, x + r, z + r, at, "minecraft:air", block));
            continue;
        }
        const t = rings;
        // The band `t` wide inside the walls: west and east whole, north and
        // south between them.
        const band: [number, number, number, number][] = [
            [x - r, z - r, x - r + t - 1, z + r],
            [x + r - t + 1, z - r, x + r, z + r],
            [x - r + t, z - r, x + r - t, z - r + t - 1],
            [x - r + t, z + r - t + 1, x + r - t, z + r]
        ];
        for (const [x1, z1, x2, z2] of band)
            for (const block of [FLOOR, WARN])
                lines.push(fill(x1, z1, x2, z2, at, "minecraft:air", block));
        // The next ring, red.
        const n = r - t;
        const ring: [number, number, number, number][] =
            n === 0
                ? [[x, z, x, z]]
                : [
                      [x - n, z - n, x - n, z + n],
                      [x + n, z - n, x + n, z + n],
                      [x - n + 1, z - n, x + n - 1, z - n],
                      [x - n + 1, z + n, x + n - 1, z + n]
                  ];
        for (const [x1, z1, x2, z2] of ring) lines.push(fill(x1, z1, x2, z2, at, WARN, FLOOR));
    }
    return lines;
}

/** Where the season's pieces go (`arena-decor`): on the light over each corner
 *  of each floor's walls, outside where anybody plays or falls. */
export function decorSpots(arena: Arena): decor.Spot[] {
    const outer = arena.size + 1;
    const { x, z } = arena.center;
    return arena.floors.flatMap((at) =>
        decor.corners(x - outer, z - outer, x + outer, z + outer, at + WALL_HEIGHT + 2).map(
            (one): decor.Spot => ({
                ...one,
                kind: "stand",
                room: at === arena.floor ? HEADROOM - WALL_HEIGHT - 1 : 2
            })
        )
    );
}
