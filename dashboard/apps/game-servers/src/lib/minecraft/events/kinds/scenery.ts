/**
 * The world an event in the sky seems to be played in: floating islands,
 * pillars and trees of one biome round its structure, drawn for each run - a
 * jungle, the Nether, the End, frozen peaks or a badlands mesa. Not the
 * season's dressing (`arena-decor`), which sits on the structure itself; this
 * is everything round it, and the two never share a block.
 *
 * Never part of the game. Every piece stands in a ring round the volume the
 * structure is played in (`play`), never closer to it than `GAP` blocks of air
 * on any side and never under it: nothing a player can jump or fall onto, no
 * shortcut on a parkour course, no landing under a dropper, nothing in an
 * elytra's way. The ring and the play volume together are the volume proved
 * empty before anything goes up (`sceneryVolume`), so every piece goes into
 * air that was nobody's.
 *
 * Nothing used falls, spreads, grows, burns where it should not or can be
 * picked up: no sand, gravel, concrete powder or dripstone (`stage.GRAVITY_BLOCKS`),
 * no vines, grass, saplings, bamboo or coral, no fire, no plain ice (which
 * melts into water). Leaves are placed persistent, so they never rot. Lava is
 * only ever a source sealed on every side it could flow to - a basin with a
 * glass lid, a fall inside a glass column - built after its shell and so taken
 * out before it, and only in a theme with nothing that burns.
 *
 * Each piece is a box of the stage's like any other: written down with the
 * rest before it is built (`keep`, into air only), and taken out latest first
 * by its own block. A run's pieces are bounded (`MOST_BLOCKS`, `MOST_BOXES`)
 * so the build stays short on a server that is being played.
 *
 * Pure: every box is a function of what it is given, asserted in tests.
 */

import { seeded, shuffled } from "../trivia-bank";
import type { ArenaBlock, Box, Volume } from "./stage";

export const THEMES = ["jungle", "nether", "end", "frost", "mesa"] as const;
export type Theme = (typeof THEMES)[number];

/** What the server can show: the Nether update's blocks from 1.16, moss from 1.17. */
export interface Era {
    readonly nether: boolean;
    readonly caves: boolean;
}

/** How a kind's surroundings are drawn. */
export interface Options {
    /** How far under the play volume the ring reaches; none over a structure near the ground. */
    readonly drop: number;
    /** Whether a sealed pool of lava may go in: never round a TNT floor. */
    readonly lava: boolean;
}

/** Air kept between the play volume and the nearest piece, on every side. */
export const GAP = 8;
/** How wide the ring the pieces stand in is. */
export const BAND = 10;
/** The most air - play and ring together - proved for scenery: this much, or
 *  `MOST_GROWTH` times what the structure proves bare, whichever is more. A
 *  long race's track is already a big volume to prove; past that it is built
 *  bare. */
export const MOST_VOLUME = 250_000;
export const MOST_GROWTH = 1.8;
/** The most blocks and boxes one run's scenery may take. */
export const MOST_BLOCKS = 3_000;
export const MOST_BOXES = 120;
/** How far apart along the ring two pieces are planned; each reaches at most
 *  three blocks from its middle, so it stays inside the band. */
const SPACING = 11;

const B = {
    jungleLog: "minecraft:jungle_log",
    jungleLeaves: "minecraft:jungle_leaves[persistent=true]",
    mossyCobble: "minecraft:mossy_cobblestone",
    mossyBricks: "minecraft:mossy_stone_bricks",
    moss: "minecraft:moss_block",
    melon: "minecraft:melon",
    seaLight: "minecraft:sea_lantern",
    netherrack: "minecraft:netherrack",
    netherBricks: "minecraft:nether_bricks",
    redNetherBricks: "minecraft:red_nether_bricks",
    magma: "minecraft:magma_block",
    wart: "minecraft:nether_wart_block",
    lava: "minecraft:lava",
    glass: "minecraft:glass",
    obsidian: "minecraft:obsidian",
    basalt: "minecraft:basalt",
    blackstone: "minecraft:blackstone",
    crimsonStem: "minecraft:crimson_stem",
    warpedStem: "minecraft:warped_stem",
    warpedWart: "minecraft:warped_wart_block",
    shroomlight: "minecraft:shroomlight",
    endStone: "minecraft:end_stone",
    endBricks: "minecraft:end_stone_bricks",
    purpur: "minecraft:purpur_block",
    purpurPillar: "minecraft:purpur_pillar",
    endRod: "minecraft:end_rod",
    chorus: "minecraft:chorus_plant",
    packedIce: "minecraft:packed_ice",
    blueIce: "minecraft:blue_ice",
    snow: "minecraft:snow_block",
    terracotta: "minecraft:terracotta",
    orangeClay: "minecraft:orange_terracotta",
    yellowClay: "minecraft:yellow_terracotta",
    whiteClay: "minecraft:white_terracotta",
    brownClay: "minecraft:brown_terracotta",
    grayClay: "minecraft:light_gray_terracotta",
    redSandstone: "minecraft:red_sandstone"
} as const satisfies Record<string, ArenaBlock>;

/** Every block a piece can be, as it is placed: none of them one of the
 *  season's (`arena-decor.DECOR_BLOCKS`), so the two are told apart. */
export const SCENERY_BLOCKS: readonly ArenaBlock[] = Object.values(B);

/** Blocks that burn: a theme with any of them never has lava. */
export const BURNING: readonly ArenaBlock[] = [B.jungleLog, B.jungleLeaves, B.moss];

/** The play volume with its corners in order. */
function ordered(volume: Volume): Volume {
    return {
        x1: Math.min(volume.x1, volume.x2),
        y1: Math.min(volume.y1, volume.y2),
        z1: Math.min(volume.z1, volume.z2),
        x2: Math.max(volume.x1, volume.x2),
        y2: Math.max(volume.y1, volume.y2),
        z2: Math.max(volume.z1, volume.z2)
    };
}

/**
 * The volume proved empty when a structure is built with scenery: its own,
 * the ring round it, and `drop` blocks under both. Null when that is more air
 * than is worth proving: such a structure is built bare.
 */
export function sceneryVolume(play: Volume, drop: number): Volume | null {
    const own = ordered(play);
    const out = GAP + BAND;
    const volume = {
        x1: own.x1 - out,
        y1: own.y1 - Math.max(0, drop),
        z1: own.z1 - out,
        x2: own.x2 + out,
        y2: own.y2,
        z2: own.z2 + out
    };
    const sizeOf = (one: Volume) =>
        (one.x2 - one.x1 + 1) * (one.y2 - one.y1 + 1) * (one.z2 - one.z1 + 1);
    return sizeOf(volume) <= Math.max(MOST_VOLUME, MOST_GROWTH * sizeOf(own)) ? volume : null;
}

/** Whether a cell is in the ring: inside the scenery volume, and `GAP` clear of the play volume's columns. */
export function inRing(play: Volume, outer: Volume, x: number, y: number, z: number): boolean {
    const own = ordered(play);
    if (x < outer.x1 || x > outer.x2 || y < outer.y1 || y > outer.y2) return false;
    if (z < outer.z1 || z > outer.z2) return false;
    const near = x >= own.x1 - GAP && x <= own.x2 + GAP && z >= own.z1 - GAP && z <= own.z2 + GAP;
    return !near;
}

/** Every cell of a box. */
export function cellsOf(box: Volume): { x: number; y: number; z: number }[] {
    const cells: { x: number; y: number; z: number }[] = [];
    for (let x = Math.min(box.x1, box.x2); x <= Math.max(box.x1, box.x2); x += 1)
        for (let y = Math.min(box.y1, box.y2); y <= Math.max(box.y1, box.y2); y += 1)
            for (let z = Math.min(box.z1, box.z2); z <= Math.max(box.z1, box.z2); z += 1)
                cells.push({ x, y, z });
    return cells;
}

function box(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    block: ArenaBlock
): Box {
    return { x1, y1, z1, x2, y2, z2, block };
}

/** A square of one block, `r` each way from its middle, `h` high. */
function square(x: number, y: number, z: number, r: number, h: number, block: ArenaBlock): Box {
    return box(x - r, y, z - r, x + r, y + h - 1, z + r, block);
}

/** A floating island: a round top of `top`, narrowing to a point of `under` beneath. */
function island(
    x: number,
    y: number,
    z: number,
    r: number,
    top: ArenaBlock,
    under: ArenaBlock
): Box[] {
    const boxes: Box[] = [];
    for (let down = r; down >= 0; down -= 1) {
        const radius = r - down;
        const block = down === 0 ? top : under;
        // A layer is three boxes - its corners cut, so it reads round - and
        // a single block at the point: few boxes, a short build and teardown.
        if (radius === 0) {
            boxes.push(box(x, y - down, z, x, y - down, z, block));
            continue;
        }
        boxes.push(
            box(x - radius, y - down, z - radius + 1, x + radius, y - down, z + radius - 1, block)
        );
        boxes.push(
            box(x - radius + 1, y - down, z - radius, x + radius - 1, y - down, z - radius, block)
        );
        boxes.push(
            box(x - radius + 1, y - down, z + radius, x + radius - 1, y - down, z + radius, block)
        );
    }
    return boxes;
}

/**
 * Sealed lava: the shell all round it first - floor, sides and a glass lid or
 * cap - and the lava last, so it is never open to flow, and is taken out
 * (latest first) before any of its shell.
 */
function sealedLava(x: number, y: number, z: number, h: number, wall: ArenaBlock): Box[] {
    return [
        box(x - 1, y - 1, z - 1, x + 1, y - 1, z + 1, wall),
        box(x - 1, y, z - 1, x + 1, y + h - 1, z - 1, B.glass),
        box(x - 1, y, z + 1, x + 1, y + h - 1, z + 1, B.glass),
        box(x - 1, y, z, x - 1, y + h - 1, z, B.glass),
        box(x + 1, y, z, x + 1, y + h - 1, z, B.glass),
        box(x - 1, y + h, z - 1, x + 1, y + h, z + 1, h > 1 ? wall : B.glass),
        box(x, y, z, x, y + h - 1, z, B.lava)
    ];
}

/** Where a piece is planned: its middle, the height its top sits at, and the run's dice. */
interface Site {
    readonly x: number;
    readonly z: number;
    /** The lowest a piece may reach, and the highest. */
    readonly low: number;
    readonly high: number;
    readonly roll: () => number;
}

type Piece = (site: Site, era: Era, lava: boolean) => Box[];

const between = (roll: () => number, least: number, most: number) =>
    most <= least ? least : least + Math.floor(roll() * (most - least + 1));

/** A height for an island's top, with room under it for its point and over it for what stands on it. */
function topAt(site: Site, under: number, over: number): number {
    return between(
        site.roll,
        Math.min(site.high, site.low + under),
        Math.max(site.low + under, site.high - over)
    );
}

const PIECES: Readonly<Record<Theme, readonly Piece[]>> = {
    jungle: [
        // A jungle tree on a mossy island, a light in its crown.
        (site, era) => {
            const y = topAt(site, 3, 9);
            const trunk = between(site.roll, 4, 6);
            const crown = y + trunk;
            return [
                ...island(site.x, y, site.z, 3, era.caves ? B.moss : B.mossyCobble, B.mossyCobble),
                box(site.x, y + 1, site.z, site.x, crown, site.z, B.jungleLog),
                box(site.x, crown + 1, site.z, site.x, crown + 1, site.z, B.seaLight),
                square(site.x, crown - 1, site.z, 2, 2, B.jungleLeaves),
                square(site.x, crown + 1, site.z, 1, 2, B.jungleLeaves)
            ];
        },
        // A ruined mossy column, leaves hanging off its top.
        (site) => {
            const top = between(site.roll, site.low + 6, site.high);
            return [
                box(site.x - 1, site.low, site.z - 1, site.x, top, site.z, B.mossyBricks),
                box(site.x - 1, top + 1, site.z - 1, site.x, top + 1, site.z, B.mossyCobble),
                square(site.x, top + 1, site.z, 2, 1, B.jungleLeaves)
            ];
        },
        // A small island with melons in the undergrowth.
        (site, era) => {
            const y = topAt(site, 2, 3);
            return [
                ...island(site.x, y, site.z, 2, era.caves ? B.moss : B.mossyCobble, B.mossyCobble),
                box(site.x - 1, y + 1, site.z, site.x - 1, y + 1, site.z, B.melon),
                box(site.x + 1, y + 1, site.z + 1, site.x + 1, y + 1, site.z + 1, B.melon),
                square(site.x, y + 1, site.z, 1, 1, B.jungleLeaves)
            ];
        }
    ],
    nether: [
        // A huge fungus on a netherrack island.
        (site, era) => {
            const y = topAt(site, 3, 8);
            const stem = era.nether
                ? site.roll() < 0.5
                    ? B.crimsonStem
                    : B.warpedStem
                : B.redNetherBricks;
            const cap = era.nether && stem === B.warpedStem ? B.warpedWart : B.wart;
            const height = between(site.roll, 4, 6);
            const top = y + height;
            return [
                ...island(
                    site.x,
                    y,
                    site.z,
                    3,
                    B.netherrack,
                    era.nether ? B.blackstone : B.netherrack
                ),
                box(site.x, y + 1, site.z, site.x, top, site.z, stem),
                box(
                    site.x,
                    top + 1,
                    site.z,
                    site.x,
                    top + 1,
                    site.z,
                    era.nether ? B.shroomlight : B.seaLight
                ),
                square(site.x, top, site.z, 2, 1, cap),
                square(site.x, top + 1, site.z, 1, 1, cap)
            ];
        },
        // A column of basalt (nether bricks before 1.16) topped with magma and a light.
        (site, era) => {
            const top = between(site.roll, site.low + 6, site.high - 1);
            return [
                box(
                    site.x - 1,
                    site.low,
                    site.z - 1,
                    site.x,
                    top,
                    site.z,
                    era.nether ? B.basalt : B.netherBricks
                ),
                box(site.x - 1, top + 1, site.z - 1, site.x, top + 1, site.z, B.magma),
                box(
                    site.x,
                    top + 2,
                    site.z,
                    site.x,
                    top + 2,
                    site.z,
                    era.nether ? B.shroomlight : B.seaLight
                )
            ];
        },
        // A lavafall sealed in glass, hanging from an island; a column of light without lava.
        (site, era, lava) => {
            const y = topAt(site, 9, 2);
            const fall = 6;
            const shell = era.nether ? B.blackstone : B.netherBricks;
            return [
                ...island(site.x, y, site.z, 3, B.netherrack, B.netherrack),
                ...(lava
                    ? sealedLava(site.x, y - fall - 2, site.z, fall, shell)
                    : [
                          box(
                              site.x,
                              y - fall - 2,
                              site.z,
                              site.x,
                              y - 3,
                              site.z,
                              era.nether ? B.shroomlight : B.seaLight
                          )
                      ])
            ];
        },
        // A basin of lava with a glass lid, on a magma rim.
        (site, era, lava) => {
            const y = topAt(site, 3, 3);
            return [
                ...island(
                    site.x,
                    y,
                    site.z,
                    3,
                    era.nether ? B.blackstone : B.netherrack,
                    B.netherrack
                ),
                ...(lava
                    ? sealedLava(site.x, y + 2, site.z, 1, B.magma)
                    : [
                          box(
                              site.x,
                              y + 1,
                              site.z,
                              site.x,
                              y + 1,
                              site.z,
                              era.nether ? B.shroomlight : B.seaLight
                          )
                      ])
            ];
        }
    ],
    end: [
        // An end stone island with a chorus plant.
        (site) => {
            const y = topAt(site, 3, 6);
            const tall = between(site.roll, 3, 5);
            return [
                ...island(site.x, y, site.z, 3, B.endStone, B.endStone),
                box(site.x + 1, y + 1, site.z, site.x + 1, y + tall, site.z, B.chorus),
                box(site.x - 1, y + 1, site.z - 1, site.x - 1, y + 2, site.z - 1, B.chorus)
            ];
        },
        // A purpur pillar with an end rod on top.
        (site) => {
            const top = between(site.roll, site.low + 6, site.high - 1);
            return [
                box(site.x, site.low, site.z, site.x, top, site.z, B.purpurPillar),
                box(site.x - 1, top + 1, site.z - 1, site.x + 1, top + 1, site.z + 1, B.purpur),
                box(site.x, top + 2, site.z, site.x, top + 2, site.z, B.endRod)
            ];
        },
        // An obsidian spire on an island of end stone bricks.
        (site) => {
            const y = topAt(site, 2, 7);
            const tall = between(site.roll, 4, 7);
            return [
                ...island(site.x, y, site.z, 2, B.endBricks, B.endStone),
                box(site.x, y + 1, site.z, site.x, y + tall, site.z, B.obsidian),
                box(site.x, y + tall + 1, site.z, site.x, y + tall + 1, site.z, B.endRod)
            ];
        }
    ],
    frost: [
        // An ice spike, wide at the foot and blue at the tip.
        (site) => {
            const top = between(site.roll, site.low + 8, site.high);
            const foot = site.low + Math.floor((top - site.low) / 3);
            return [
                square(site.x, site.low, site.z, 1, foot - site.low + 1, B.packedIce),
                box(site.x, foot + 1, site.z, site.x, top - 2, site.z, B.packedIce),
                box(site.x, top - 1, site.z, site.x, top, site.z, B.blueIce)
            ];
        },
        // A snowy island with a lantern of sea light.
        (site) => {
            const y = topAt(site, 3, 2);
            return [
                ...island(site.x, y, site.z, 3, B.snow, B.packedIce),
                box(site.x, y + 1, site.z, site.x, y + 1, site.z, B.seaLight)
            ];
        }
    ],
    mesa: [
        // A banded hoodoo.
        (site) => {
            const top = between(site.roll, site.low + 6, site.high);
            const bands: ArenaBlock[] = [
                B.terracotta,
                B.orangeClay,
                B.whiteClay,
                B.yellowClay,
                B.brownClay,
                B.grayClay
            ];
            const boxes: Box[] = [];
            for (let y = site.low, at = 0; y <= top; y += 2, at += 1)
                boxes.push(
                    box(
                        site.x - 1,
                        y,
                        site.z - 1,
                        site.x,
                        Math.min(top, y + 1),
                        site.z,
                        bands[at % bands.length]!
                    )
                );
            return [
                ...boxes,
                box(
                    site.x - 2,
                    top + 1,
                    site.z - 2,
                    site.x + 1,
                    top + 1,
                    site.z + 1,
                    B.redSandstone
                )
            ];
        },
        // A red sandstone island in bands of clay.
        (site) => {
            const y = topAt(site, 3, 2);
            return [
                ...island(site.x, y, site.z, 3, B.orangeClay, B.redSandstone),
                box(site.x - 1, y + 1, site.z, site.x, y + 1, site.z, B.grayClay)
            ];
        }
    ]
};

/** Where pieces are planned: along the middle of the ring, `SPACING` apart, from a corner of the run's own. */
function sites(play: Volume, roll: () => number): { x: number; z: number }[] {
    const own = ordered(play);
    const off = GAP + Math.floor(BAND / 2);
    const x1 = own.x1 - off;
    const x2 = own.x2 + off;
    const z1 = own.z1 - off;
    const z2 = own.z2 + off;
    const along: { x: number; z: number }[] = [];
    const width = x2 - x1;
    const depth = z2 - z1;
    const round = 2 * (width + depth);
    for (let at = Math.floor(roll() * SPACING); at < round; at += SPACING) {
        if (at < width) along.push({ x: x1 + at, z: z1 });
        else if (at < width + depth) along.push({ x: x2, z: z1 + at - width });
        else if (at < 2 * width + depth) along.push({ x: x2 - (at - width - depth), z: z2 });
        else along.push({ x: x1, z: z2 - (at - 2 * width - depth) });
    }
    return along;
}

/**
 * The boxes of a run's scenery round `play`, in the order they go in: each
 * piece whole or not at all - every cell of it in the ring, none on a cell an
 * earlier piece took - until the run's share of blocks and boxes is spent.
 * The same play volume, theme, era and seed always give the same boxes.
 */
export function sceneryBoxes(
    play: Volume,
    theme: Theme,
    era: Era,
    seed: string,
    options: Options
): Box[] {
    const outer = sceneryVolume(play, options.drop);
    if (!outer) return [];
    const roll = seeded(`scenery-${seed}`);
    const kinds = PIECES[theme];
    const taken = new Set<string>();
    const kept: Box[] = [];
    let blocks = 0;
    for (const at of shuffled(sites(play, roll), roll)) {
        const piece = kinds[Math.floor(roll() * kinds.length)]!;
        const site: Site = { ...at, low: outer.y1, high: outer.y2 - 3, roll };
        const boxes = piece(site, era, options.lava);
        const cells = boxes.flatMap((one) =>
            cellsOf(one).map((cell) => `${cell.x},${cell.y},${cell.z}`)
        );
        const own = new Set(cells);
        const size = boxes.reduce((sum, one) => sum + cellsOf(one).length, 0);
        const fits =
            boxes.every((one) =>
                cellsOf(one).every((cell) => inRing(play, outer, cell.x, cell.y, cell.z))
            ) &&
            [...own].every((cell) => !taken.has(cell)) &&
            kept.length + boxes.length <= MOST_BOXES &&
            blocks + size <= MOST_BLOCKS;
        if (!fits) continue;
        own.forEach((cell) => taken.add(cell));
        kept.push(...boxes);
        blocks += size;
    }
    return kept;
}

/**
 * The theme a run's scenery is drawn in: the parkour course's own where it
 * has one of these, the Nether round a nether maze, and otherwise one of
 * `allowed` drawn from the run's id.
 */
export function themeFor(seed: string, allowed: readonly Theme[], course?: string): Theme {
    if (course && (allowed as readonly string[]).includes(course)) return course as Theme;
    return shuffled(allowed, seeded(`scenery-theme-${seed}`))[0]!;
}
