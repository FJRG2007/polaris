/**
 * A spleef arena: a square floor of snow high over a site, a glass wall round
 * it three blocks high so nobody walks off the edge, and a glass net four blocks
 * under it that catches whoever falls through - who is then out, and sent back
 * to where they were. No lava anywhere: falling through the floor is the lava.
 */

import type { EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";

const WALL: Box["block"] = "minecraft:light_blue_stained_glass";
const NET: Box["block"] = "minecraft:white_stained_glass";
export const FLOOR: Box["block"] = "minecraft:snow_block";
/** How far under the floor the net is. */
const NET_DROP = 4;
const WALL_HEIGHT = 3;
/** Room above the floor for jumping about. */
const HEADROOM = 5;

export interface Arena {
    /** The floor's height: a player standing on it has their feet one above. */
    readonly floor: number;
    readonly center: { readonly x: number; readonly z: number };
    readonly size: number;
    /** What is built, in order: the net, the floor, the walls. */
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
    const wall = (x1: number, z1: number, x2: number, z2: number): Box => ({
        x1,
        y1: y + 1,
        z1,
        x2,
        y2: y + WALL_HEIGHT,
        z2,
        block: WALL
    });
    const boxes: Box[] = [
        {
            x1: x - outer,
            y1: y - NET_DROP,
            z1: z - outer,
            x2: x + outer,
            y2: y - NET_DROP,
            z2: z + outer,
            block: NET
        },
        { x1: x - r, y1: y, z1: z - r, x2: x + r, y2: y, z2: z + r, block: FLOOR },
        wall(x - outer, z - outer, x + outer, z - outer),
        wall(x - outer, z + outer, x + outer, z + outer),
        wall(x - outer, z - r, x - outer, z + r),
        wall(x + outer, z - r, x + outer, z + r)
    ];
    return {
        floor: y,
        center: { x, z },
        size: r,
        boxes,
        volume: {
            x1: x - outer,
            y1: y - NET_DROP,
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
 * floor, facing the middle, on top of the snow.
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

/** Fell through: below the top of the floor. */
export function fell(arena: Arena, y: number): boolean {
    return y < arena.floor + 0.5;
}
