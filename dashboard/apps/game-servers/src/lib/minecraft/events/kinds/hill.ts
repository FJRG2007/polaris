/**
 * A king of the hill's commands: the platform it floats on - `LIFT` over the
 * highest thing under it, built only into air proven empty and taken away
 * again, only that block, only inside its own box - and how the players brought
 * to it are kept from harm.
 *
 * With "fists only" players join, their things are kept (`stash`) and they
 * come in empty-handed, in adventure mode. Off the circle the hill wears them
 * down (Poison, down to three hearts); in it, it mends them (Regeneration).
 * Whoever is knocked off falls slowly and is brought back to the edge, the
 * fire and the water cannot hurt them, and a fist's knockback is left whole:
 * pushing is how the circle is won. keepInventory is held for all of it.
 *
 * Pure; the loop is `hill-service.ts`.
 */

import type { Box, Point } from "../state";
import { IN_ARENA, type Spot } from "./arena";

/** The platform's block: plain, cheap, and nothing the sea has. */
export const PLATFORM_BLOCK = "minecraft:smooth_stone";
/** The platform's edge, its corners, and the circle drawn on it. */
export const EDGE_BLOCK = "minecraft:polished_andesite";
export const CORNER_BLOCK = "minecraft:sea_lantern";
export const RING_BLOCK = "minecraft:yellow_concrete";
/** Every block the platform is built of, for taking it down. */
export const PLATFORM_BLOCKS = [PLATFORM_BLOCK, EDGE_BLOCK, CORNER_BLOCK, RING_BLOCK] as const;

/**
 * The platform's look, put in before its plain floor fills round it: its
 * edge in polished stone with a light at each corner, and the circle drawn
 * in yellow, a block wide, where it ends. Only on the floor's own layer.
 */
export function platformDecor(place: Point, radius: number): { box: Box; block: string }[] {
    const half = radius + MARGIN;
    const { x, y, z } = place;
    const one = (bx: number, bz: number, block: string) => ({
        box: { x1: bx, y1: y, z1: bz, x2: bx, y2: y, z2: bz },
        block
    });
    const out: { box: Box; block: string }[] = [
        one(x - half, z - half, CORNER_BLOCK),
        one(x + half, z - half, CORNER_BLOCK),
        one(x - half, z + half, CORNER_BLOCK),
        one(x + half, z + half, CORNER_BLOCK),
        {
            box: { x1: x - half + 1, y1: y, z1: z - half, x2: x + half - 1, y2: y, z2: z - half },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x - half + 1, y1: y, z1: z + half, x2: x + half - 1, y2: y, z2: z + half },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x - half, y1: y, z1: z - half + 1, x2: x - half, y2: y, z2: z + half - 1 },
            block: EDGE_BLOCK
        },
        {
            box: { x1: x + half, y1: y, z1: z - half + 1, x2: x + half, y2: y, z2: z + half - 1 },
            block: EDGE_BLOCK
        }
    ];
    // The ring: every block whose middle is within half a block of the circle.
    for (let dx = -radius; dx <= radius; dx += 1)
        for (let dz = -radius; dz <= radius; dz += 1) {
            const away = Math.hypot(dx, dz);
            if (Math.abs(away - radius) <= 0.5) out.push(one(x + dx, z + dz, RING_BLOCK));
        }
    return out;
}

/** Floor beyond the circle's edge, all round: room to be pushed out onto. */
export const MARGIN = 3;

/** Air over the platform proven empty before a block of it goes in. */
const HEADROOM = 4;

/** How far from the players its place is looked for. */
export const DISTANCE = 32;

/** How far over the highest thing under it the platform floats. */
export const LIFT = 20;

/** How many can play: as many as fit round the circle. */
export const MOST = 16;

/** How far past the floor somebody may be before they are brought back. */
const STRAY = 6;

/** How far under the circle somebody may fall before they are brought back. */
const DROP = 5;

/** A platform's one layer: a square round the circle, `MARGIN` past its edge. */
export function platformBox(place: Point, radius: number): Box {
    const half = radius + MARGIN;
    return {
        x1: place.x - half,
        y1: place.y,
        z1: place.z - half,
        x2: place.x + half,
        y2: place.y,
        z2: place.z + half
    };
}

/** The platform's layer and the air over it, proven empty before it is built. */
export function proofBox(place: Point, radius: number): Box {
    return { ...platformBox(place, radius), y2: place.y + HEADROOM };
}

/**
 * The room the hill is played in, on the ground or on its platform: the circle,
 * its margin and the air a few blocks over and under it. Nothing hostile comes
 * into it, and what is dropped there stays its thrower's.
 */
export function bounds(place: Point, radius: number): Box {
    const half = radius + MARGIN;
    return {
        x1: place.x - half,
        y1: place.y - DROP,
        z1: place.z - half,
        x2: place.x + half,
        y2: place.y + 8,
        z2: place.z + half
    };
}

/** The way to face from `from` to look at `to`: 0 is south, 90 west, in this game. */
function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
    const degrees = (-Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI;
    return Math.round(degrees * 10) / 10;
}

/**
 * Where each player comes in: evenly round the circle, a block outside its edge,
 * facing the middle - everybody starts as far from it as everybody else.
 */
export function entrySpots(place: Point, radius: number, count: number): Spot[] {
    const ring = radius + 1;
    return Array.from({ length: Math.max(1, count) }, (_unused, index) => {
        const angle = (index / Math.max(1, count)) * Math.PI * 2;
        const x = place.x + Math.round(Math.cos(angle) * ring);
        const z = place.z + Math.round(Math.sin(angle) * ring);
        return { x, y: place.y, z, yaw: yawTowards({ x, z }, place) };
    });
}

/**
 * Into the hill at a spot: on the ground under the air over it where the server
 * can say where that is (1.19.4 and later), and at the circle's own height
 * otherwise. Tagged first, in adventure mode after.
 */
export function enterLines(name: string, spot: Spot, overGround: boolean): string[] {
    const tp = overGround
        ? `execute in minecraft:overworld positioned ${spot.x + 0.5} ${spot.y + 6} ${spot.z + 0.5} positioned over motion_blocking_no_leaves run tp ${name} ~ ~ ~ ${spot.yaw} 0`
        : `execute in minecraft:overworld run tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} ${spot.yaw} 0`;
    return [`tag ${name} add ${IN_ARENA}`, tp, `gamemode adventure ${name}`];
}

/**
 * Whether somebody stands on the platform: over its floor, at the circle's own
 * height - a jump allowed - rather than still on the way in, or under it.
 */
export function onPlatform(
    at: { x: number; y: number; z: number },
    place: Point,
    radius: number
): boolean {
    const half = radius + MARGIN;
    return (
        at.y >= place.y - 0.5 &&
        at.y <= place.y + 1.5 &&
        at.x >= place.x - half &&
        at.x < place.x + half + 1 &&
        at.z >= place.z - half &&
        at.z < place.z + half + 1
    );
}

/** Who of `names` is not on the platform yet - not on, or not there. */
export function notArrived(
    names: readonly string[],
    where: readonly { name: string; x: number; y: number; z: number }[],
    place: Point,
    radius: number
): string[] {
    const here = new Map(where.map((one) => [one.name.toLowerCase(), one]));
    return names.filter((name) => {
        const at = here.get(name.toLowerCase());
        return !at || !onPlatform(at, place, radius);
    });
}

/** Knocked right off - into the sea, down a slope, far out: time to come back. */
export function strayed(
    at: { x: number; y: number; z: number },
    place: Point,
    radius: number
): boolean {
    const reach = radius + MARGIN + STRAY;
    return (
        at.y < place.y - DROP ||
        at.y > place.y + 40 ||
        Math.abs(at.x - (place.x + 0.5)) > reach ||
        Math.abs(at.z - (place.z + 0.5)) > reach
    );
}

/** Each entrant's health, kept by the game as it changes (`health` criterion). */
export const HEALTH_SCORE = "pe_khp";

/** Health under which the hill stops wearing anybody down: three hearts. */
const DRAIN_FLOOR = 6;

/**
 * The hill wears down whoever is off it and mends whoever holds it, for a
 * moment past each look - and nobody can die of it:
 * - off the circle, Poison, and only while they have more than three hearts;
 * - in it, the Poison taken off again and Regeneration instead;
 * - Resistance IV, so a punch is a fifth of one and keeps its knockback;
 * - whoever is under the platform - knocked off - falls slowly, so the drop
 *   never hurts, and is brought back to the edge;
 * - the fire and the water kept off.
 */
export function protectLines(
    point?: { x: number; y: number; z: number },
    radius?: number
): string[] {
    const who = `@a[tag=${IN_ARENA}]`;
    const lines = [
        `effect give ${who} minecraft:resistance 10 3 true`,
        `effect give ${who} minecraft:fire_resistance 10 0 true`,
        `effect give ${who} minecraft:water_breathing 10 0 true`
    ];
    if (!point || radius === undefined) return lines;
    const reach = radius + MARGIN + 64;
    const under = `x=${point.x - reach},y=${point.y - 128},z=${point.z - reach},dx=${2 * reach},dy=127,dz=${2 * reach}`;
    const inside = `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[tag=${IN_ARENA},distance=..${radius}]`;
    return [
        ...lines,
        `scoreboard objectives add ${HEALTH_SCORE} health`,
        `effect give @a[tag=${IN_ARENA},scores={${HEALTH_SCORE}=${DRAIN_FLOOR + 1}..}] minecraft:poison 3 1 true`,
        `${inside} run effect clear @s minecraft:poison`,
        `${inside} run effect give @s minecraft:regeneration 3 1 true`,
        `execute in minecraft:overworld run effect give @a[tag=${IN_ARENA},${under}] minecraft:slow_falling 3 0 true`
    ];
}
