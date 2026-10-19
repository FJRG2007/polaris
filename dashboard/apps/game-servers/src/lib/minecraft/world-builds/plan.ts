/**
 * Where a seasonal build goes in a server's world, the commands that paste it,
 * and the ones that take it down again. Pure, like the event commands.
 *
 * The guarantees are the arena's (`events/kinds/arena.ts`):
 *
 * - Only air is ever changed. A site is taken only when its ground is the
 *   world's own, level, dry and off any tree or build, and the build's whole box
 *   above it counts as nothing but air; every block then goes in with `keep`.
 * - Taking it down gives back exactly what was there - air - for every block it
 *   placed and nothing else: each kind it used replaced with air inside its own
 *   box. Something a player put down in it meanwhile, a chest in the house, is
 *   theirs and stays.
 * - Pasted bottom layer first, in chunks the server takes a few ticks each.
 */

import { z } from "zod";
import { DECORATIONS } from "../seasonal";
import * as arena from "../events/kinds/arena";
import { arenaSchema, type Box } from "../events/state";
import { blockOf, decodeCells, type PolarisBuild } from "./format";

/** Install-config key the builds a server has up are written under. */
export const WORLD_BUILDS_KEY = "seasonalWorldBuilds";

/** Blocks a single paste chunk may cover: a few ticks of `polaris batch`. */
export const PASTE_CHUNK_BLOCKS = 32_768;

/** How far a build may stand above the lowest column it covers: a gap of one
 *  under an edge reads as part of the ground, more floats. */
export const GROUND_SPREAD_MAX = 1;

/** Nearest and farthest a build is put from a player's home, and the step. */
const RING_FIRST = 24;
const RING_LAST = 72;
const RING_STEP = 16;
const DIRECTIONS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1]
] as const;

const IN_OVERWORLD = "execute in minecraft:overworld run";

export const placedSchema = z.object({
    id: z.string(),
    season: z.enum(DECORATIONS),
    /** The box and kinds a teardown needs; written before the first block. */
    arena: arenaSchema,
    /** Paste chunks already run: a restart goes on from the next one. */
    pasted: z.number().int().min(0),
    up: z.boolean()
});

export type Placed = z.infer<typeof placedSchema>;

/** The builds a server's config says it has up; one that does not parse cannot be taken down and is left out. */
export function readPlaced(config: Readonly<Record<string, unknown>>): Placed[] {
    const list = config[WORLD_BUILDS_KEY];
    if (!Array.isArray(list)) return [];
    return list.flatMap((one) => {
        const parsed = placedSchema.safeParse(one);
        return parsed.success ? [parsed.data] : [];
    });
}

export interface Point {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** Where the build's lowest corner goes for a site centered on `center`. */
export function originFor(build: PolarisBuild, center: { x: number; z: number }, y: number): Point {
    return {
        x: center.x - Math.floor(build.size.x / 2),
        y,
        z: center.z - Math.floor(build.size.z / 2)
    };
}

export function boxFor(build: PolarisBuild, origin: Point): Box {
    return {
        x1: origin.x,
        y1: origin.y,
        z1: origin.z,
        x2: origin.x + build.size.x - 1,
        y2: origin.y + build.size.y - 1,
        z2: origin.z + build.size.z - 1
    };
}

/** Half the longer side: the radius the ground survey covers. */
export function radiusOf(build: PolarisBuild): number {
    return Math.ceil(Math.max(build.size.x, build.size.z) / 2);
}

/**
 * Where to look for a site, nearest first: rings round each home in turn, far
 * enough out that the build does not land on anybody's door.
 */
export function candidateCenters(
    homes: readonly { x: number; z: number }[],
    build: PolarisBuild,
    max = 8
): { x: number; z: number }[] {
    const reach = radiusOf(build);
    const seen = new Set<string>();
    const found: { x: number; z: number }[] = [];
    for (let ring = RING_FIRST; ring <= RING_LAST; ring += RING_STEP) {
        for (const home of homes) {
            for (const [dx, dz] of DIRECTIONS) {
                const step = (ring + reach) / Math.hypot(dx, dz);
                const spot = {
                    x: Math.round(home.x + dx * step),
                    z: Math.round(home.z + dz * step)
                };
                const key = `${spot.x},${spot.z}`;
                if (seen.has(key)) continue;
                seen.add(key);
                found.push(spot);
                if (found.length >= max) return found;
            }
        }
    }
    return found;
}

export type SiteVerdict =
    | { readonly y: number }
    | { readonly why: "unloaded" | "uneven" | "covered" | "too-high" };

/**
 * Whether the ground the survey read is a site: a marker came down on every
 * column (none missing to water or lava), none on a tree, the sea or a build,
 * and all within `GROUND_SPREAD_MAX` of each other. The build stands on the
 * highest of them.
 */
export function judgeSite(
    columns: number,
    tops: readonly { y: number }[],
    covered: number,
    build: PolarisBuild,
    worldTop = arena.worldTop(true)
): SiteVerdict {
    if (tops.length < columns) return { why: "unloaded" };
    if (covered > 0) return { why: "covered" };
    const ys = tops.map((one) => one.y);
    const high = Math.max(...ys);
    if (high - Math.min(...ys) > GROUND_SPREAD_MAX) return { why: "uneven" };
    if (high + build.size.y - 1 > worldTop) return { why: "too-high" };
    return { y: high };
}

/** One paste command and how many blocks it covers. */
export interface PastePiece {
    readonly line: string;
    readonly blocks: number;
}

/**
 * The commands that paste a build at `origin`: each run of one state along x a
 * `fill ... keep`, a lone block a `setblock ... keep`, the bottom layer first so
 * whatever falls or hangs has what holds it already in place.
 */
export function pastePieces(build: PolarisBuild, origin: Point): PastePiece[] {
    const cells = decodeCells(build);
    const { x: width, z: depth, y: height } = build.size;
    const pieces: PastePiece[] = [];
    for (let y = 0; y < height; y += 1) {
        for (let z = 0; z < depth; z += 1) {
            const row = (y * depth + z) * width;
            for (let x = 0; x < width; ) {
                const index = cells[row + x]!;
                let end = x;
                while (end + 1 < width && cells[row + end + 1] === index) end += 1;
                if (index !== 0) {
                    const state = build.palette[index]!;
                    const at = `${origin.x + x} ${origin.y + y} ${origin.z + z}`;
                    pieces.push(
                        end === x
                            ? { line: `${IN_OVERWORLD} setblock ${at} ${state} keep`, blocks: 1 }
                            : {
                                  line: `${IN_OVERWORLD} fill ${at} ${origin.x + end} ${origin.y + y} ${origin.z + z} ${state} keep`,
                                  blocks: end - x + 1
                              }
                    );
                }
                x = end + 1;
            }
        }
    }
    return pieces;
}

/** The pieces grouped into chunks of at most `budget` blocks, in order. */
export function pasteChunks(
    pieces: readonly PastePiece[],
    budget = PASTE_CHUNK_BLOCKS
): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let blocks = 0;
    for (const piece of pieces) {
        if (current.length > 0 && blocks + piece.blocks > budget) {
            chunks.push(current);
            current = [];
            blocks = 0;
        }
        current.push(piece.line);
        blocks += piece.blocks;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** What is written down before the first block goes in: the box, and every kind
 *  the build uses in the order a teardown takes them. */
export function placedFor(build: PolarisBuild, origin: Point, batch?: string): Placed {
    // What went in last comes down first: a lantern before the floor it stands on.
    const last = new Map<number, number>();
    decodeCells(build).forEach((index, at) => {
        if (index !== 0) last.set(index, at);
    });
    const order = [...last.entries()].sort((one, other) => other[1] - one[1]);
    const kinds = [...new Set(order.map(([index]) => blockOf(build.palette[index]!)))];
    return {
        id: build.id,
        season: build.season,
        arena: { box: boxFor(build, origin), blocks: kinds, ...(batch ? { batch } : {}) },
        pasted: 0,
        up: false
    };
}

/** The build taken down: every kind it used back to air, inside its box only. */
export function restoreLines(placed: Placed): string[] {
    return arena.teardown(placed.arena);
}
