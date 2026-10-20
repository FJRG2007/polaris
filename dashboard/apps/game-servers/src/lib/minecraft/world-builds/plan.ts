/**
 * Where a seasonal build goes in a server's world, the commands that paste it,
 * and the ones that take it down again. Pure, like the event commands.
 *
 * The guarantees are the arena's (`events/kinds/arena.ts`):
 *
 * - Only air is ever changed. A site is taken only when its ground is the
 *   world's own, dry and off any tree or build, and the build's whole box above
 *   it counts as nothing but air; every block then goes in with `keep`.
 * - Ground as players leave it - a slope, a dip, a hummock - takes a build
 *   too: it stands level with the highest column it covers, never cut into
 *   the ground, on a foundation of dirt that fills the air down to the ground
 *   in each lower column (the pedestal structure placers such as
 *   BetterStructures put under theirs). Every column of the footprint is read,
 *   not a sample of them, so the foundation's cells are known one by one and
 *   none of them is ground: they sit above the heightmap's top in their
 *   column, where only air or what grows can be, and only the air is filled.
 * - Grass and flowers do not turn a site down. Short and tall grass and ferns
 *   (`WEEDS`), which grow back on any grass block, are cleared out of the
 *   build's box and its foundation so it stands on the ground; a flower or
 *   anything else that grows is never replaced - a build over one is lifted a
 *   block or two instead, and the foundation goes in round it with `keep`, so
 *   taking it down leaves it as it was. Trees, water and lava still turn a
 *   site down: nothing is cut, drained or bridged.
 * - Taking it down gives back exactly what was there - air - for every block it
 *   placed and nothing else: each cell it filled, top layer first, emptied only
 *   while it still holds what went there (or what that turned into by itself).
 *   Something a player put down in it meanwhile - a chest in the house, planks
 *   of the same wood beside a wall - is theirs and stays. The foundation comes
 *   down the same way, cell by cell, after the build.
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

/** The most a build's foundation may raise it over the lowest column it
 *  covers, however wide it is: past that it is a tower, not a build on a hill. */
export const GROUND_SPREAD_MAX = 8;

/** How far a build may stand above the lowest column it covers: as far as its
 *  longer side - a foundation no taller than the build is wide - two at least,
 *  `GROUND_SPREAD_MAX` at most. */
export function spreadAllowed(build: PolarisBuild): number {
    return Math.min(GROUND_SPREAD_MAX, Math.max(2, build.size.x, build.size.z));
}

/** What a build clears out of its way rather than stand over: grass and ferns,
 *  which grow back on any grass block. Tall grass and large ferns are two
 *  blocks; clearing the lower half takes the upper with it. Short grass was
 *  `grass` before 1.20.3, and a server refuses only the line of the name it
 *  does not know. */
export const WEEDS = [
    "minecraft:short_grass",
    "minecraft:grass",
    "minecraft:tall_grass",
    "minecraft:fern",
    "minecraft:large_fern"
] as const;

/** The commands that empty `box` of `WEEDS` and of nothing else. */
export function clearWeeds(box: Box): string[] {
    return arena
        .slices(box)
        .flatMap((piece) =>
            WEEDS.map(
                (weed) =>
                    `${IN_OVERWORLD} fill ${piece.x1} ${piece.y1} ${piece.z1} ${piece.x2} ${piece.y2} ${piece.z2} minecraft:air replace ${weed}`
            )
        );
}

/** How far a build is lifted over flowers in its way, the tallest of
 *  which (a sunflower, a rose bush) are two blocks. */
export const LIFT_MAX = 2;

/** What the foundation is made of: grass from the ground round it grows over
 *  it, and it never spreads onto anything that is not ours, as grass would. */
export const FOUNDATION_BLOCK = "minecraft:dirt";

/** How far from a player's home a build is put, nearest first: every 16 blocks
 *  near, every 32 further out, to well past where anybody's base usually ends. */
const RINGS = [24, 40, 56, 72, 96, 128, 160, 192] as const;
/** About how far apart a ring's sites lie: a far ring gets more of them. */
const RING_SPACING = 64;

const IN_OVERWORLD = "execute in minecraft:overworld run";

/** The snow that falls on whatever stands in the open: nobody placed it. */
const SNOW = "minecraft:snow";

/** One run of foundation along x: the cells from `y1` to `y2` in each column,
 *  as `[x1, x2, z, y1, y2]`. */
const foundationRunSchema = z.tuple([
    z.number().int(),
    z.number().int(),
    z.number().int(),
    z.number().int(),
    z.number().int()
]);

export type FoundationRun = z.infer<typeof foundationRunSchema>;

export const placedSchema = z.object({
    id: z.string(),
    season: z.enum(DECORATIONS),
    /** The box and kinds a teardown needs; written before the first block. */
    arena: arenaSchema,
    /** Which build was pasted, block for block: a teardown cell by cell only follows the same one. */
    digest: z.string().optional(),
    /** The foundation's cells, none of them ground when it was written down;
     *  pasted before the build and taken down after it. None on a build placed
     *  before there were foundations. */
    foundation: z.array(foundationRunSchema).optional(),
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

/** Half the longer side: how far a site's chunks are held loaded round it. */
export function radiusOf(build: PolarisBuild): number {
    return Math.ceil(Math.max(build.size.x, build.size.z) / 2);
}

/** Every `step`th column the build covers for a site centered on `center`, its
 *  last row and column included: every column of it at a step of one. */
export function footprintOf(
    build: PolarisBuild,
    center: { x: number; z: number },
    step = 1
): { x: number; z: number }[] {
    const origin = originFor(build, center, 0);
    const along = (side: number) => {
        const at: number[] = [];
        for (let one = 0; one < side - 1; one += step) at.push(one);
        return [...at, side - 1];
    };
    return along(build.size.z).flatMap((dz) =>
        along(build.size.x).map((dx) => ({ x: origin.x + dx, z: origin.z + dz }))
    );
}

/** Columns read about in one answer: a marker's line is about seventy bytes,
 *  and RCON hands back 4096 of an answer at most. */
export const STRIP_COLUMNS = 48;

/** A grid of columns cut into strips of whole rows (or of a row, when one is
 *  wider than a strip) of at most `STRIP_COLUMNS` columns, each read on its own. */
export function stripsOf(columns: readonly { x: number; z: number }[]): Box[] {
    const sorted = (values: number[]) => [...new Set(values)].sort((one, other) => one - other);
    const xs = sorted(columns.map((one) => one.x));
    const zs = sorted(columns.map((one) => one.z));
    const width = Math.min(xs.length, STRIP_COLUMNS);
    const rows = Math.max(1, Math.floor(STRIP_COLUMNS / width));
    const strips: Box[] = [];
    for (let row = 0; row < zs.length; row += rows) {
        for (let column = 0; column < xs.length; column += width) {
            strips.push({
                x1: xs[column]!,
                y1: 0,
                z1: zs[row]!,
                x2: xs[Math.min(xs.length, column + width) - 1]!,
                y2: 0,
                z2: zs[Math.min(zs.length, row + rows) - 1]!
            });
        }
    }
    return strips;
}

/** A marker tag narrowed to one strip's columns, from the bottom of the world
 *  to the top - or to the markers standing no higher than `top` - for any
 *  selector that takes a tag (`@e[tag=...]`). */
export function stripTag(tag: string, strip: Box, top?: number): string {
    // A marker has no height: a volume ending half a block over `top` takes in
    // the ones at `top` and none a block higher.
    const height = top === undefined ? 384 : top + 63.5;
    const volume = `dx=${strip.x2 - strip.x1},dy=${height},dz=${strip.z2 - strip.z1}`;
    return `${tag},x=${strip.x1},y=-64,z=${strip.z1},${volume}`;
}

/** The sites of one ring round a point: eight, and more the further out it is,
 *  starting due east and going round. */
function ringSites(ring: number, reach: number): { x: number; z: number }[] {
    const count = 8 * Math.max(1, Math.round((2 * Math.PI * ring) / (8 * RING_SPACING)));
    const out = ring + reach;
    return Array.from({ length: count }, (_, at) => {
        const angle = (at / count) * 2 * Math.PI;
        return {
            x: Math.round(Math.cos(angle) * out) || 0,
            z: Math.round(Math.sin(angle) * out) || 0
        };
    });
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
    for (const ring of RINGS) {
        const sites = ringSites(ring, reach);
        for (const home of homes) {
            for (const site of sites) {
                const spot = { x: home.x + site.x, z: home.z + site.z };
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
 * column, none on a tree, the sea or a build, and all within `spreadAllowed`
 * of each other. The build stands on the highest of them - over the ground of
 * every column, never in it - lifted by `LIFT_MAX` at most, so that much room
 * is kept under the top of the world.
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
    if (high - Math.min(...ys) > spreadAllowed(build)) return { why: "uneven" };
    if (high + LIFT_MAX + build.size.y - 1 > worldTop) return { why: "too-high" };
    return { y: high };
}

/**
 * The foundation under a build standing at `level`: in every column it covers,
 * the cells from the top the survey read (the first one over the ground) up to
 * the build, as runs along x of columns that start at the same height. A
 * column whose ground reaches the build has none.
 */
export function foundationRuns(
    tops: readonly { x: number; y: number; z: number }[],
    level: number
): FoundationRun[] {
    const rows = new Map<number, { x: number; y: number }[]>();
    for (const one of tops) {
        if (one.y >= level) continue;
        rows.set(one.z, [...(rows.get(one.z) ?? []), { x: one.x, y: one.y }]);
    }
    const runs: FoundationRun[] = [];
    for (const z of [...rows.keys()].sort((one, other) => one - other)) {
        const row = rows.get(z)!.sort((one, other) => one.x - other.x);
        for (let at = 0; at < row.length; ) {
            let end = at;
            while (
                end + 1 < row.length &&
                row[end + 1]!.x === row[end]!.x + 1 &&
                row[end + 1]!.y === row[at]!.y
            )
                end += 1;
            runs.push([row[at]!.x, row[end]!.x, z, row[at]!.y, level - 1]);
            at = end + 1;
        }
    }
    return runs;
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

/** The commands that put the foundation in, only into air like the build's,
 *  the lowest runs first. */
export function foundationPieces(runs: readonly FoundationRun[]): PastePiece[] {
    return [...runs]
        .sort((one, other) => one[3] - other[3])
        .map(([x1, x2, z, y1, y2]) => ({
            line: `${IN_OVERWORLD} fill ${x1} ${y1} ${z} ${x2} ${y2} ${z} ${FOUNDATION_BLOCK} keep`,
            blocks: (x2 - x1 + 1) * (y2 - y1 + 1),
            state: FOUNDATION_BLOCK,
            from: { x: x1, y: y1, z },
            to: { x: x2, y: y2, z }
        }));
}

/** Everything a placed build pastes, in order: its foundation, then itself.
 *  The chunks a restart counts in (`pasted`) are cut from this. */
export function piecesOf(build: BuildCells, placed: Placed): PastePiece[] {
    const { box } = placed.arena;
    return [
        ...foundationPieces(placed.foundation ?? []),
        ...pastePieces(build, { x: box.x1, y: box.y1, z: box.z1 })
    ];
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
export function placedFor(
    build: PolarisBuild,
    origin: Point,
    batch?: string,
    foundation: readonly FoundationRun[] = []
): Placed {
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
        ...(foundation.length > 0 ? { foundation: [...foundation] } : {}),
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

const take = (from: Point, to: Point, block: string) =>
    `${IN_OVERWORLD} fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} minecraft:air replace ${block}`;

/** Each piece's cells back to air, the last pasted first, only where a cell
 *  still holds what went there or what that turned into by itself. */
function emptied(pieces: readonly PastePiece[]): string[] {
    return [...pieces].reverse().flatMap((piece) =>
        arena
            .withDecayed([blockOf(piece.state)])
            .filter((one) => one !== SNOW)
            .map((one) => take(piece.from, piece.to, one))
    );
}

/**
 * The build taken down: every cell it filled back to air, the top layer first,
 * and only while the cell still holds what went there or what that turns into
 * by itself - a block a player put anywhere else in its box stays. The snow
 * that fell on it comes down first, and whatever fell while it came down after.
 * Without the build it was pasted from (one since dropped from the catalog),
 * every kind it used back to air inside its box. The foundation last, cell by
 * cell the same way - its dirt, or the grass that grew over it - whichever
 * build it held up.
 */
export function restoreLines(placed: Placed, build?: PolarisBuild): string[] {
    const foundation = emptied(foundationPieces(placed.foundation ?? []));
    if (!build || !placedIs(placed, build)) return [...arena.teardown(placed.arena), ...foundation];
    const { box } = placed.arena;
    const cells = emptied(pastePieces(build, { x: box.x1, y: box.y1, z: box.z1 }));
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
        ...(placed.arena.blocks.some(falls) ? [fallingGone(box)] : []),
        ...foundation
    ];
}
