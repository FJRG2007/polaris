/**
 * A spleef arena, floating high over a site: several floors of snow stacked one
 * under the other (as Fall Guys' Hex-A-Gone stacks its layers), each walled in
 * glass three blocks high so nobody walks off an edge, and a glass net under the
 * lowest that catches whoever falls through it - who is then out, and sent back
 * to where they were. No lava anywhere: falling through the last floor is the
 * lava.
 *
 * Each run plays one of three ways, drawn for it among those the event allows
 * (`variantFor`):
 * - shovel: everybody has a shovel that breaks the snow and nothing else;
 * - decay: no tools - the snow a player stands on turns red, and is gone on the
 *   next look, so standing still is falling;
 * - snowballs: a snowball breaks the snow it hits (`snowball-pack.ts`).
 *
 * Built only into air, taken out only where its own blocks still are.
 */

import { SPLEEF_VARIANTS, type EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";
import { seeded, shuffled } from "../trivia-bank";

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
/** How many floors. */
export const LAYERS = 3;
/** How far under each floor the next one is. */
export const LAYER_GAP = 7;
/** How far under the lowest floor the net is. */
const NET_DROP = 4;
const WALL_HEIGHT = 3;
/** Room above the top floor for jumping about. */
const HEADROOM = 5;

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
 * floors, only where it is still the arena's snow.
 */
export function decayLines(arena: Arena, inArena: string): string[] {
    const r = arena.size;
    const { x, z } = arena.center;
    return [
        ...(arena.floors ?? [arena.floor]).map(
            (at) =>
                `execute in minecraft:overworld run fill ${x - r} ${at} ${z - r} ${x + r} ${at} ${z + r} minecraft:air replace ${WARN}`
        ),
        `execute in minecraft:overworld as @a[tag=${inArena}] at @s if block ~ ~-1 ~ ${FLOOR} if entity @s[x=${x - r},dx=${2 * r},z=${z - r},dz=${2 * r},y=${arena.floors?.at(-1) ?? arena.floor},dy=${arena.floor - (arena.floors?.at(-1) ?? arena.floor) + 2}] run setblock ~ ~-1 ~ ${WARN}`
    ];
}

/** How many snowballs a player is topped up to in the snowball game. */
export const SNOWBALLS = 16;
