/**
 * A king of the hill's commands: where its circle goes, the platform of its own
 * it stands on when there is no untouched ground for it, and - with "fists
 * only" - how the players brought to it are kept from harm.
 *
 * The circle wants a patch of the world's own ground as wide as itself. On a
 * small island there is none: a house, a farm, trees. Then it is put on a
 * platform over open water, one layer of one block, built only into air that was
 * proven empty and taken away again - only that block, only inside its own box -
 * so nothing of the island is ever touched.
 *
 * With "fists only" players join, their things are kept (`stash`) and they
 * come in empty-handed, in adventure mode. Nobody can die: Resistance V takes
 * every hurt a fall, lava, drowning or a punch can do, fire resistance and water
 * breathing besides, food keeps them fed, and whoever is knocked right off is
 * brought back to the edge of the hill. Knockback is all that is left, so
 * pushing is how the circle is won. keepInventory is held for all of it.
 *
 * Pure; the loop is `hill-service.ts`.
 */

import type { Box, Point } from "../state";
import { IN_ARENA, type Spot } from "./arena";

/** The platform's block: plain, cheap, and nothing the sea has. */
export const PLATFORM_BLOCK = "minecraft:smooth_stone";

/** Floor beyond the circle's edge, all round: room to be pushed out onto. */
export const MARGIN = 3;

/** Air over the platform proven empty before a block of it goes in. */
const HEADROOM = 4;

/** How far from the players its place is looked for. */
export const DISTANCE = 32;

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

/**
 * Nothing can kill them, for a moment past each look: Resistance V is every hurt
 * a fall, a fight, lava or drowning does; the fire and the water besides; fed, so
 * hunger - which Resistance does not stop - cannot either.
 */
export function protectLines(): string[] {
    const who = `@a[tag=${IN_ARENA}]`;
    return [
        `effect give ${who} minecraft:resistance 10 4 true`,
        `effect give ${who} minecraft:fire_resistance 10 0 true`,
        `effect give ${who} minecraft:water_breathing 10 0 true`,
        `effect give ${who} minecraft:saturation 10 0 true`
    ];
}
