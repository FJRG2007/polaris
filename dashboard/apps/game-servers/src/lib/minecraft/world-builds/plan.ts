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
 *   placed and nothing else: each cell it filled, top layer first, emptied only
 *   while it still holds what went there (or what that turned into by itself).
 *   Something a player put down in it meanwhile - a chest in the house, planks
 *   of the same wood beside a wall - is theirs and stays.
 * - Pasted bottom layer first, in chunks the server takes a few ticks each.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { DECORATIONS } from "../seasonal";
import * as arena from "../events/kinds/arena";
import { arenaSchema, type Box } from "../events/state";
import { falls, fallingGone } from "../events/kinds/stage";
import { blockOf, decodeCells, type BuildCells, type PolarisBuild } from "./format";

/** Install-config key the builds a server has up are written under. */
export const WORLD_BUILDS_KEY = "seasonalWorldBuilds";

/** Blocks a single paste chunk may cover: a few ticks of `polaris batch`. */
export const PASTE_CHUNK_BLOCKS = 32_768;
/** Commands a single paste chunk may hold, for a server that takes them one by one. */
export const PASTE_CHUNK_LINES = 1_024;

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

/** The snow that falls on whatever stands in the open: nobody placed it. */
const SNOW = "minecraft:snow";

export const placedSchema = z.object({
    id: z.string(),
    season: z.enum(DECORATIONS),
    /** The box and kinds a teardown needs; written before the first block. */
    arena: arenaSchema,
    /** Which build was pasted, block for block: a teardown cell by cell only follows the same one. */
    digest: z.string().optional(),
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

/** The entries `readPlaced` left out, kept as written: a later version may read one, and it is the only record of a build still standing. */
export function unreadPlaced(config: Readonly<Record<string, unknown>>): unknown[] {
    const list = config[WORLD_BUILDS_KEY];
    if (!Array.isArray(list)) return [];
    return list.filter((one) => !placedSchema.safeParse(one).success);
}

/** Install-config key each build's site search is written under: where the
 *  next pass goes on from, so a restart does not start again at the nearest. */
export const SITE_SEARCH_KEY = "seasonalWorldBuildSearch";

/** Where a build's search stands: the candidate list it walks (as a digest),
 *  the next one in it to survey, and the last one surveyed. */
export const siteSearchSchema = z.object({
    list: z.string(),
    next: z.number().int().min(0),
    last: z.object({ x: z.number().int(), z: z.number().int() }).optional()
});

export type SiteSearch = z.infer<typeof siteSearchSchema>;

/** Every build's search the config holds; one that does not parse is a search not started. */
export function readSiteSearches(
    config: Readonly<Record<string, unknown>>
): Record<string, SiteSearch> {
    const stored = config[SITE_SEARCH_KEY];
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const found: Record<string, SiteSearch> = {};
    for (const [id, one] of Object.entries(stored)) {
        const parsed = siteSearchSchema.safeParse(one);
        if (parsed.success) found[id] = parsed.data;
    }
    return found;
}

/** A short digest of a candidate list: a cursor only means something in the list it was taken in. */
export function listDigest(centers: readonly { x: number; z: number }[]): string {
    return createHash("sha256")
        .update(centers.map((one) => `${one.x},${one.z}`).join(";"))
        .digest("hex")
        .slice(0, 16);
}

/**
 * The index a search goes on from in `centers`. In the list it was taken in,
 * where it stopped; in another (a player online or gone with a bed of their
 * own), the one after the last site it surveyed, when that is still in it -
 * so the far rings are reached however often people come and go - and the
 * nearest otherwise.
 */
export function searchStart(
    search: SiteSearch | undefined,
    centers: readonly { x: number; z: number }[]
): number {
    if (!search) return 0;
    if (search.list === listDigest(centers)) return search.next < centers.length ? search.next : 0;
    const last = search.last;
    const at = last ? centers.findIndex((one) => one.x === last.x && one.z === last.z) : -1;
    return at < 0 || at + 1 >= centers.length ? 0 : at + 1;
}

/** Grid a player's standing position is rounded to before it is searched round:
 *  walking about does not make a new list on every pass. */
export const STANDING_GRID = 32;

/**
 * What a build is searched round, the same on every pass while nothing about
 * where people live changes: the beds and anchors, deduplicated and in a fixed
 * order. Where they stand is only used when nobody has one, rounded to a grid.
 */
export function stableHomes(
    beds: readonly { x: number; z: number }[],
    standing: readonly { x: number; z: number }[]
): { x: number; z: number }[] {
    const snap = (value: number) => Math.round(value / STANDING_GRID) * STANDING_GRID || 0;
    const from =
        beds.length > 0 ? beds : standing.map((one) => ({ x: snap(one.x), z: snap(one.z) }));
    const unique = new Map<string, { x: number; z: number }>();
    for (const one of from) {
        const home = { x: Math.floor(one.x), z: Math.floor(one.z) };
        unique.set(`${home.x},${home.z}`, home);
    }
    return [...unique.values()].sort((one, other) => one.x - other.x || one.z - other.z);
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

/** One paste command, the run it fills, and how many blocks it covers. */
export interface PastePiece {
    readonly line: string;
    readonly blocks: number;
    readonly state: string;
    readonly from: Point;
    readonly to: Point;
}

/**
 * The commands that paste a build at `origin`: each run of one state along x a
 * `fill ... keep`, a lone block a `setblock ... keep`, the bottom layer first so
 * whatever falls or hangs has what holds it already in place.
 */
export function pastePieces(build: BuildCells, origin: Point): PastePiece[] {
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
                    const from = { x: origin.x + x, y: origin.y + y, z: origin.z + z };
                    const to = { ...from, x: origin.x + end };
                    const at = `${from.x} ${from.y} ${from.z}`;
                    pieces.push({
                        line:
                            end === x
                                ? `${IN_OVERWORLD} setblock ${at} ${state} keep`
                                : `${IN_OVERWORLD} fill ${at} ${to.x} ${to.y} ${to.z} ${state} keep`,
                        blocks: end - x + 1,
                        state,
                        from,
                        to
                    });
                }
                x = end + 1;
            }
        }
    }
    return pieces;
}

/** The pieces grouped into chunks of at most `budget` blocks and `lines` commands, in order. */
export function pasteChunks(
    pieces: readonly Pick<PastePiece, "line" | "blocks">[],
    budget = PASTE_CHUNK_BLOCKS,
    lines = PASTE_CHUNK_LINES
): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let blocks = 0;
    for (const piece of pieces) {
        if (current.length > 0 && (blocks + piece.blocks > budget || current.length >= lines)) {
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
        digest: digestOf(build),
        pasted: 0,
        up: false
    };
}

/** The build block for block: one changed since it was pasted is another build. */
export function digestOf(build: PolarisBuild): string {
    return createHash("sha256")
        .update(JSON.stringify([build.size, build.palette, build.blocks]))
        .digest("hex")
        .slice(0, 32);
}

/** Whether `build` is exactly the one `placed` wrote down. */
function placedIs(placed: Placed, build: PolarisBuild): boolean {
    return (
        build.id === placed.id &&
        build.season === placed.season &&
        placed.digest !== undefined &&
        placed.digest === digestOf(build)
    );
}

/**
 * The build taken down: every cell it filled back to air, the top layer first,
 * and only while the cell still holds what went there or what that turns into
 * by itself - a block a player put anywhere else in its box stays. The snow
 * that fell on it comes down first, and whatever fell while it came down after.
 * Without the build it was pasted from (one since dropped from the catalog),
 * every kind it used back to air inside its box.
 */
export function restoreLines(placed: Placed, build?: PolarisBuild): string[] {
    if (!build || !placedIs(placed, build)) return arena.teardown(placed.arena);
    const { box } = placed.arena;
    const take = (from: Point, to: Point, block: string) =>
        `${IN_OVERWORLD} fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} minecraft:air replace ${block}`;
    const cells = pastePieces(build, { x: box.x1, y: box.y1, z: box.z1 })
        .reverse()
        .flatMap((piece) => {
            const block = blockOf(piece.state);
            return arena
                .withDecayed([block])
                .filter((one) => one !== SNOW)
                .map((one) => take(piece.from, piece.to, one));
        });
    return [
        ...[...arena.slices(box)]
            .reverse()
            .map((piece) =>
                take(
                    { x: piece.x1, y: piece.y1, z: piece.z1 },
                    { x: piece.x2, y: piece.y2, z: piece.z2 },
                    SNOW
                )
            ),
        ...cells,
        ...(placed.arena.blocks.some(falls) ? [fallingGone(box)] : [])
    ];
}
