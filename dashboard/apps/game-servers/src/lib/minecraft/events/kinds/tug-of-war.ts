/**
 * Tug of war's platform and rules: two teams set up as a duel's (`team-duel.ts`
 * - its teams, colors and friendly fire off), each in a walled pen at one end
 * of a long platform in the air, a rope running down the middle of it and a
 * marker on the rope that starts at the center.
 *
 * Every player holds a rod; each right-click with it is a pull, which the game
 * counts by itself (`minecraft.used`), so nothing on the player's side can add
 * one the server did not see. Each look takes how much every count rose, caps
 * it at what a fast hand can do in the time since the last look (`capPulls`) -
 * a macro clicking a hundred times a second counts as a fast hand, no more -
 * and averages it over the team's players who are on, so the smaller side of
 * an odd split pulls as hard as the bigger one. The marker moves by the
 * difference, toward the team pulling harder.
 *
 * The marker over a team's line wins it for that team; with the time up, the
 * team it is nearer wins. Either way the losers' floor opens under them and
 * they drop into a pool of water below - nobody is hurt - before the arena
 * sends everybody back. Exactly in the middle when the time is up is a draw.
 *
 * Nothing in it is a bed, an anchor or anything else a spawn point is set by.
 * Pure; the loop is `tug-of-war-service.ts`.
 */

import { z } from "zod";
import type { Box } from "../state";
import type { Spot } from "./arena";
import type { Fill } from "./arena-game";
import * as decor from "./arena-decor";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 1;
/** The most players: sixteen a side. */
export const MOST = 32;
/** Blocks from the center to each team's line, when the event does not say. */
export const DEFAULT_LENGTH = 10;
/** Between a team's line and its pen's wall. */
const GAP = 2;
/** How deep a pen runs from its inner wall to its outer one, inside. */
const PEN = 8;
/** From the middle of the platform to its side wall, across the rope. */
export const HALF_Z = 4;
/** How far over the bottom of the pool below a pen its floor is. */
const DROP = 10;
/** How deep the pool is: the losers land in it unhurt. */
const POOL = 3;
/** How high a pen's walls stand over its floor. */
const WALL = 3;

/** A pull is a right-click with the rod; held down, the game repeats it five
 *  times a second, and a quick hand does a little better. More than this in a
 *  second is a macro and counts as this. */
export const CAP_PER_SECOND = 8;
/** How far the marker moves for one pull more, on average, than the other team. */
export const STEP = 0.1;
/** How long the losers are given to land in the pool before it ends. */
export const FALL_MS = 3_000;

export const ROD = "minecraft:carrot_on_a_stick";
/** What counts the pulls: the game's own use statistic for the rod. */
export const PULLS = "pe_tug";
export const READ_PULLS = `execute as @a run scoreboard players get @s ${PULLS}`;
export const SETUP: readonly string[] = [
    `scoreboard objectives remove ${PULLS}`,
    `scoreboard objectives add ${PULLS} minecraft.used:${ROD.replace(":", ".")}`
];
export const TEARDOWN: readonly string[] = [`scoreboard objectives remove ${PULLS}`];

const ROPE = "minecraft:oak_fence";
export const MARKER = "minecraft:yellow_wool";
/** What a pen's floor is: what opens under the losers. */
export const PEN_FLOOR = "minecraft:spruce_planks";
const FIELD_FLOOR = "minecraft:smooth_stone";
const MID_LINE = "minecraft:white_concrete";
export const SIDE_LINES = ["minecraft:red_concrete", "minecraft:blue_concrete"] as const;
const PEN_GLASS = ["minecraft:red_stained_glass", "minecraft:blue_stained_glass"] as const;
const RIM = "minecraft:stone_bricks";
const PILLAR = "minecraft:chiseled_stone_bricks";
const LIGHT = "minecraft:sea_lantern";
const WATER = "minecraft:water";

/** Every kind of block it is built of, in the order it comes down: the marker
 *  and the rope first, the water before the walls that hold it in. */
export const ARENA_BLOCKS: readonly string[] = [
    MARKER,
    ROPE,
    LIGHT,
    ...PEN_GLASS,
    PILLAR,
    WATER,
    PEN_FLOOR,
    FIELD_FLOOR,
    MID_LINE,
    ...SIDE_LINES,
    RIM
];

// ------------------------------------------------------------------ the run's own

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    /** Where the marker is, in blocks from the center: below 0 toward Red. */
    position: z.number().default(0),
    /** The team that won, once it is decided; the drop runs until `FALL_MS`. */
    wonBy: z.number().int().min(0).max(1).nullable().default(null),
    wonAt: z.number().nullable().default(null),
    /** Won by being ahead when the time ran out, not by crossing a line. */
    timeUp: z.boolean().default(false)
});
export type TugState = z.infer<typeof stateSchema>;

export function stateOf(game: unknown): TugState {
    const parsed = stateSchema.safeParse(game ?? {});
    return parsed.success ? parsed.data : stateSchema.parse({});
}

// ------------------------------------------------------------------ the rules

/** One player's pulls since the last look, at most what a hand can do in it. */
export function capPulls(raw: number, elapsedSeconds: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    const seconds = Math.max(0, Math.min(elapsedSeconds, 5));
    return Math.min(Math.floor(raw), Math.ceil(CAP_PER_SECOND * seconds));
}

/** Every rise in the pull count since the last look, capped, by lower-case name. */
export function countPulls(
    risen: ReadonlyMap<string, number>,
    elapsedSeconds: number
): Map<string, number> {
    const counted = new Map<string, number>();
    for (const [name, raw] of risen) {
        const pulls = capPulls(raw, elapsedSeconds);
        if (pulls > 0) counted.set(name.toLowerCase(), pulls);
    }
    return counted;
}

/** A team's pull: its pulls over its players who are on, so the size of a team
 *  never decides it. Nobody on pulls nothing. */
export function teamPull(pulls: readonly number[]): number {
    if (pulls.length === 0) return 0;
    return pulls.reduce((sum, one) => sum + one, 0) / pulls.length;
}

/** Where the marker is after a look: toward the team that pulled harder, never
 *  past either line. */
export function move(position: number, red: number, blue: number, length: number): number {
    const next = position + (blue - red) * STEP;
    return Math.max(-length, Math.min(length, Math.round(next * 1000) / 1000));
}

/** The team whose line the marker reached, or null. */
export function crossed(position: number, length: number): number | null {
    if (position <= -length) return 0;
    if (position >= length) return 1;
    return null;
}

/** The team the marker is nearer, or null exactly in the middle. */
export function leader(position: number): number | null {
    if (position < 0) return 0;
    if (position > 0) return 1;
    return null;
}

/** The final scores: the winners' pulls, nothing for the losers; everybody's
 *  pulls in a draw. */
export function scoresOf(
    entrants: readonly { name: string; side: number }[],
    points: Readonly<Record<string, number>>,
    wonBy: number | null
): Map<string, number> {
    return new Map(
        entrants.map((one) => [
            one.name,
            wonBy === null || one.side === wonBy ? (points[one.name] ?? 0) : 0
        ])
    );
}

// ------------------------------------------------------------------ the platform

/** From the center to a pen's inner wall, and to its outer one. */
function inner(length: number): number {
    return length + GAP;
}
function outer(length: number): number {
    return inner(length) + PEN + 1;
}

/** How far from its center the ground under it is judged. */
export function reachOf(length: number): number {
    return outer(length) + 1;
}

export function arenaBox(center: { x: number; z: number }, bottomY: number, length: number): Box {
    const half = outer(length);
    return {
        x1: center.x - half,
        y1: bottomY,
        z1: center.z - HALF_Z,
        x2: center.x + half,
        y2: bottomY + DROP + WALL + 1,
        z2: center.z + HALF_Z
    };
}

function centerOf(box: Box): { x: number; z: number } {
    return { x: Math.round((box.x1 + box.x2) / 2), z: Math.round((box.z1 + box.z2) / 2) };
}

/** The height of the platform's floor; players stand a block over it. */
export function floorOf(box: Box): number {
    return box.y1 + DROP;
}

/** The sign a side's things are laid out to: Red toward -x, Blue toward +x. */
function sign(side: number): number {
    return side === 0 ? -1 : 1;
}

/** A side's pen floor: what opens under it when it loses. */
export function penFloor(box: Box, length: number, side: number): Box {
    const center = centerOf(box);
    const near = center.x + sign(side) * (inner(length) + 1);
    const far = center.x + sign(side) * (outer(length) - 1);
    const y = floorOf(box);
    return {
        x1: Math.min(near, far),
        y1: y,
        z1: center.z - HALF_Z + 1,
        x2: Math.max(near, far),
        y2: y,
        z2: center.z + HALF_Z - 1
    };
}

/** Whether somebody is still inside their own pen, over its floor. */
export function inPen(
    box: Box,
    length: number,
    side: number,
    at: { x: number; y: number; z: number }
): boolean {
    const floor = penFloor(box, length, side);
    return (
        at.x >= floor.x1 &&
        at.x < floor.x2 + 1 &&
        at.z >= floor.z1 &&
        at.z < floor.z2 + 1 &&
        at.y >= floor.y1 + 0.5 &&
        at.y <= floor.y1 + WALL + 2
    );
}

/** Where the `index`th player of a side stands: in rows either side of the rope,
 *  from the inner wall outward, facing the other team. */
export function startSpot(box: Box, length: number, side: number, index: number): Spot {
    const center = centerOf(box);
    const rows = [-1, 1, -2, 2, -3, 3];
    const row = rows[index % rows.length]!;
    const column = Math.floor(index / rows.length) % PEN;
    return {
        x: center.x + sign(side) * (inner(length) + 1 + column),
        y: floorOf(box) + 1,
        z: center.z + row,
        yaw: side === 0 ? -90 : 90
    };
}

/** Where the marker block stands for a position. */
export function markerAt(box: Box, position: number): { x: number; y: number; z: number } {
    const center = centerOf(box);
    return { x: center.x + Math.round(position), y: floorOf(box) + 1, z: center.z };
}

/** The marker where the position says: the rope where it was, the marker put
 *  back, a few sparks over it. */
export function markerLines(box: Box, length: number, position: number): string[] {
    const center = centerOf(box);
    const y = floorOf(box) + 1;
    const at = markerAt(box, position);
    return [
        `execute in minecraft:overworld run fill ${center.x - length} ${y} ${center.z} ${center.x + length} ${y} ${center.z} ${ROPE} replace ${MARKER}`,
        `execute in minecraft:overworld run setblock ${at.x} ${at.y} ${at.z} ${MARKER}`,
        `execute in minecraft:overworld run particle minecraft:happy_villager ${at.x + 0.5} ${at.y + 1} ${at.z + 0.5} 0.3 0.3 0.3 0 4`
    ];
}

/** The losers' floor taken away: they drop into the pool under it. */
export function openLines(box: Box, length: number, side: number): string[] {
    const floor = penFloor(box, length, side);
    return [
        `execute in minecraft:overworld run fill ${floor.x1} ${floor.y1} ${floor.z1} ${floor.x2} ${floor.y2} ${floor.z2} minecraft:air replace ${PEN_FLOOR}`
    ];
}

/**
 * What it is built of, each only into air, in this order: the pens' corner
 * pillars and lights, the rope, the pens' glass walls, the floors and lines,
 * the stone rim round all of it, the pools under the pens - their shells
 * first, then the water in them - and the marker last, at the center: the
 * marker where it should be is the proof that the blocks stayed.
 */
export function arenaFills(box: Box, length: number): Fill[] {
    const center = centerOf(box);
    const floorY = floorOf(box);
    const fills: Fill[] = [];
    const add = (
        block: string,
        x1: number,
        y1: number,
        z1: number,
        x2: number,
        y2: number,
        z2: number
    ) =>
        fills.push({
            block,
            box: {
                x1: Math.min(x1, x2),
                y1: Math.min(y1, y2),
                z1: Math.min(z1, z2),
                x2: Math.max(x1, x2),
                y2: Math.max(y1, y2),
                z2: Math.max(z1, z2)
            }
        });
    const zs = [center.z - HALF_Z, center.z + HALF_Z];
    const near = (side: number) => center.x + sign(side) * inner(length);
    const far = (side: number) => center.x + sign(side) * outer(length);

    // A pillar with a light on it at each corner of each pen.
    for (const side of [0, 1])
        for (const x of [near(side), far(side)])
            for (const z of zs) {
                add(PILLAR, x, floorY + 1, z, x, floorY + WALL - 1, z);
                add(LIGHT, x, floorY + WALL, z, x, floorY + WALL, z);
            }
    // The rope, end to end, round the marker's cell at the center.
    add(
        ROPE,
        center.x - outer(length) + 1,
        floorY + 1,
        center.z,
        center.x - 1,
        floorY + 1,
        center.z
    );
    add(
        ROPE,
        center.x + 1,
        floorY + 1,
        center.z,
        center.x + outer(length) - 1,
        floorY + 1,
        center.z
    );
    // Each pen's glass, in its team's color.
    for (const side of [0, 1]) {
        const glass = PEN_GLASS[side]!;
        for (const x of [near(side), far(side)])
            add(glass, x, floorY + 1, zs[0]!, x, floorY + WALL, zs[1]!);
        for (const z of zs) add(glass, near(side), floorY + 1, z, far(side), floorY + WALL, z);
    }
    // The floors: each pen's planks, the lines, the field, a light at each end
    // of each line, and the rim round it all.
    for (const side of [0, 1]) {
        const floor = penFloor(box, length, side);
        add(PEN_FLOOR, floor.x1, floorY, floor.z1, floor.x2, floorY, floor.z2);
        const line = center.x + sign(side) * length;
        for (const z of zs) add(LIGHT, line, floorY, z, line, floorY, z);
        add(SIDE_LINES[side]!, line, floorY, zs[0]! + 1, line, floorY, zs[1]! - 1);
    }
    add(MID_LINE, center.x, floorY, zs[0]! + 1, center.x, floorY, zs[1]! - 1);
    add(
        FIELD_FLOOR,
        center.x - inner(length) + 1,
        floorY,
        zs[0]! + 1,
        center.x + inner(length) - 1,
        floorY,
        zs[1]! - 1
    );
    add(RIM, box.x1, floorY, box.z1, box.x2, floorY, box.z2);
    // The pools under the pens: a light at the bottom, the shell, then the water.
    for (const side of [0, 1]) {
        const floor = penFloor(box, length, side);
        const x1 = near(side);
        const x2 = far(side);
        add(
            LIGHT,
            center.x + sign(side) * (inner(length) + 1 + PEN / 2),
            box.y1,
            center.z,
            center.x + sign(side) * (inner(length) + 1 + PEN / 2),
            box.y1,
            center.z
        );
        add(RIM, x1, box.y1, zs[0]!, x2, box.y1, zs[1]!);
        add(RIM, x1, box.y1 + 1, zs[0]!, x1, floorY - 1, zs[1]!);
        add(RIM, x2, box.y1 + 1, zs[0]!, x2, floorY - 1, zs[1]!);
        for (const z of zs) add(RIM, x1, box.y1 + 1, z, x2, floorY - 1, z);
        add(WATER, floor.x1, box.y1 + 1, floor.z1, floor.x2, box.y1 + POOL, floor.z2);
    }
    add(MARKER, center.x, floorY + 1, center.z, center.x, floorY + 1, center.z);
    return fills;
}

/** Where the season's pieces go (`arena-decor`): on the light over each corner
 *  of each pen, over the glass nobody climbs. */
export function decorSpots(box: Box, length: number): decor.Spot[] {
    const center = centerOf(box);
    const y = floorOf(box) + WALL + 1;
    return [0, 1].flatMap((side) =>
        [inner(length), outer(length)].flatMap((reach) =>
            [center.z - HALF_Z, center.z + HALF_Z].map(
                (z): decor.Spot => ({ x: center.x + sign(side) * reach, y, z, kind: "stand" })
            )
        )
    );
}
