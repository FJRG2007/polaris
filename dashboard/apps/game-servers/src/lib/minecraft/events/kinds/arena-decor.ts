/**
 * What an event builds, dressed for the time of year: jack o'lanterns, carved
 * pumpkins, cobwebs and soul lanterns round Halloween, in orange, purple and
 * black; small spruce trees, red and green wool and lanterns through winter.
 *
 * A light touch, and never part of the game. Each kind names the few places
 * a piece may go (`Spot`) - the top of a post, a corner of a wall, the rim of
 * a waiting pad - and nothing goes anywhere else: not on a panel, a track, a
 * floor that is played on or a maze's walls. A spot is one of:
 *
 * - `stand`: on top of one of the arena's own blocks, into air nobody can
 *   reach from where they play, with `room` blocks over it;
 * - `flat`: the same, where somebody can walk up to it - only a carpet, which
 *   nobody can climb, hide behind or be slowed by;
 * - `set`: in place of one of the arena's own blocks (`replaces`) - a barrier
 *   in a wall, a light in a pillar - with a full block, so it stops a player
 *   exactly as the block it replaced did;
 * - `garland`: a carpet or a block along a beam over everybody's heads.
 *
 * `fitted` then drops any spot the arena's own blocks do not leave room for:
 * every piece inside the box that was proved air, a standing one into air with
 * a block of the arena's under it, a set one only in place of what it names.
 *
 * Nothing used falls or can be picked up: no sand, gravel, concrete powder,
 * anvil or snow, and a lantern or a carpet only ever on a block that stands
 * until the arena comes down. Every piece is a block of the event's like any
 * other - written down with the arena before it goes in (`ids` into an
 * arena's list, `stage` boxes into a stage's) and taken down with it.
 *
 * Pure: every line is a function of what it is given, asserted in tests.
 */

import type { Decoration } from "../../seasonal";

/** What the server can show: a lantern from 1.14, a soul lantern (and the
 *  rest of the soul blocks and particles) from 1.16; the snowflake particle
 *  from 1.17; item components from 1.20.5. The last two are only read by the
 *  event's ambience (`season-ambience.ts`), and absent is not there. */
export interface Era {
    readonly lanterns: boolean;
    readonly soulLanterns: boolean;
    readonly snowflakes?: boolean;
    readonly components?: boolean;
}

/** The season an event is built for, and what its server can show of it. */
export interface Dressing {
    readonly season: Decoration;
    readonly era: Era;
}

export type SpotKind = "stand" | "flat" | "set" | "garland";

/** One place a piece may go: its lowest block. */
export interface Spot {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly kind: SpotKind;
    /** `stand`: how many blocks high a piece may be; one when absent. */
    readonly room?: number;
    /** `set`: the arena's block it takes the place of, as a bare id. */
    readonly replaces?: string;
}

/** How a kind's arena is to be dressed, beyond its spots. */
export interface Rules {
    /** Fire or lightning reaches it: nothing that burns. */
    readonly fireproof?: boolean;
    /** Flown or walked past: no cobweb to be caught in. */
    readonly exposed?: boolean;
}

/** One block of decoration in the world. */
export interface Piece {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: string;
    /** Put only in place of this block of the arena's; into air when absent. */
    readonly replaces?: string;
}

/** A box of the arena's own blocks: an arena's fill, a stage's box. */
export interface Solid {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
    readonly block: string;
}

/** A box of air: the arena's, both corners included. */
export interface Bounds {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
}

const JACK = "minecraft:jack_o_lantern";
const CARVED = "minecraft:carved_pumpkin";
const COBWEB = "minecraft:cobweb";
const SOUL_LANTERN = "minecraft:soul_lantern";
const LANTERN = "minecraft:lantern";
const GLOWSTONE = "minecraft:glowstone";
const SPRUCE_LOG = "minecraft:spruce_log";
/** Placed by a command, a leaf is not near a log as the game counts it until
 *  it is ticked, and would rot away dropping saplings: held, it never does. */
const LEAVES = "minecraft:spruce_leaves[persistent=true]";
const PURPLE_WOOL = "minecraft:purple_wool";
const BLACK_WOOL = "minecraft:black_wool";
const RED_WOOL = "minecraft:red_wool";
const GREEN_WOOL = "minecraft:green_wool";
const PURPLE_STONE = "minecraft:purple_terracotta";
const BLACK_STONE = "minecraft:black_terracotta";
const RED_STONE = "minecraft:red_terracotta";
const GREEN_STONE = "minecraft:green_terracotta";
const ORANGE_CARPET = "minecraft:orange_carpet";
const PURPLE_CARPET = "minecraft:purple_carpet";
const BLACK_CARPET = "minecraft:black_carpet";
const RED_CARPET = "minecraft:red_carpet";
const GREEN_CARPET = "minecraft:green_carpet";

/**
 * Every block a piece can be, as it is placed. Taken down in this order: what
 * rests on another piece - a lantern, a carpet - before what holds it up.
 */
export const DECOR_BLOCKS = [
    SOUL_LANTERN,
    LANTERN,
    ORANGE_CARPET,
    PURPLE_CARPET,
    BLACK_CARPET,
    RED_CARPET,
    GREEN_CARPET,
    COBWEB,
    LEAVES,
    JACK,
    CARVED,
    GLOWSTONE,
    PURPLE_WOOL,
    BLACK_WOOL,
    RED_WOOL,
    GREEN_WOOL,
    PURPLE_STONE,
    BLACK_STONE,
    RED_STONE,
    GREEN_STONE,
    SPRUCE_LOG
] as const;

/** A block's id without its state: what a teardown by kind takes. */
export function bareId(block: string): string {
    return block.replace(/\[.*$/, "");
}

/** The most spots an arena is dressed at: a light touch, and a short build. */
export const MOST_SPOTS = 48;

/** What stands on a spot, bottom up, for each season. */
function standing(dressing: Dressing, rules: Rules): (readonly string[])[] {
    const { season, era } = dressing;
    const fire = rules.fireproof === true;
    if (season === "halloween") {
        const soul = era.soulLanterns ? SOUL_LANTERN : era.lanterns ? LANTERN : JACK;
        return [
            [JACK],
            [fire ? PURPLE_STONE : PURPLE_WOOL, CARVED],
            ...(rules.exposed ? [] : [[COBWEB]]),
            [fire ? BLACK_STONE : BLACK_WOOL, soul]
        ];
    }
    const light = era.lanterns ? LANTERN : GLOWSTONE;
    return [
        fire ? [GREEN_STONE, light] : [SPRUCE_LOG, LEAVES, LEAVES],
        [fire ? RED_STONE : RED_WOOL, light],
        [fire ? GREEN_STONE : GREEN_WOOL, light]
    ];
}

/** A piece cut to the room it has: what it stands on first, its top last. */
function cut(motif: readonly string[], room: number): readonly string[] {
    if (motif.length <= room) return motif;
    return [...motif.slice(0, Math.max(0, room - 1)), motif.at(-1)!];
}

function carpets(season: Decoration): readonly string[] {
    return season === "halloween"
        ? [ORANGE_CARPET, PURPLE_CARPET, BLACK_CARPET]
        : [RED_CARPET, GREEN_CARPET];
}

function solids(season: Decoration, fire: boolean): readonly string[] {
    if (season === "halloween") return [JACK, CARVED];
    return fire ? [RED_STONE, GREEN_STONE] : [RED_WOOL, GREEN_WOOL];
}

function garlands(season: Decoration, fire: boolean): readonly string[] {
    if (fire) return season === "halloween" ? [JACK, CARVED] : [GREEN_STONE, RED_STONE];
    return season === "halloween" ? carpets(season) : [LEAVES, RED_WOOL];
}

/**
 * The pieces for a kind's spots, each spot's from the bottom up; nothing at
 * all out of season. Which piece a spot gets goes round in order, so the same
 * arena is dressed the same however often it is worked out.
 */
export function piecesFor(
    spots: readonly Spot[],
    dressing: Dressing | null,
    rules: Rules = {}
): Piece[][] {
    if (!dressing) return [];
    const fire = rules.fireproof === true;
    const counts: Record<SpotKind, number> = { stand: 0, flat: 0, set: 0, garland: 0 };
    const next = <T>(kind: SpotKind, list: readonly T[]): T => list[counts[kind]++ % list.length]!;
    const motifs = standing(dressing, rules);
    return spots.slice(0, MOST_SPOTS).flatMap((spot): Piece[][] => {
        const at = { x: spot.x, y: spot.y, z: spot.z };
        switch (spot.kind) {
            case "stand": {
                const motif = cut(next("stand", motifs), Math.max(1, spot.room ?? 1));
                return [motif.map((block, up) => ({ ...at, y: spot.y + up, block }))];
            }
            case "flat":
                // A carpet burns, and nothing else is flat.
                return fire ? [] : [[{ ...at, block: next("flat", carpets(dressing.season)) }]];
            case "set":
                return spot.replaces
                    ? [
                          [
                              {
                                  ...at,
                                  block: next("set", solids(dressing.season, fire)),
                                  replaces: spot.replaces
                              }
                          ]
                      ]
                    : [];
            case "garland":
                return [[{ ...at, block: next("garland", garlands(dressing.season, fire)) }]];
        }
    });
}

function inside(box: Bounds, x: number, y: number, z: number): boolean {
    return (
        x >= Math.min(box.x1, box.x2) &&
        x <= Math.max(box.x1, box.x2) &&
        y >= Math.min(box.y1, box.y2) &&
        y <= Math.max(box.y1, box.y2) &&
        z >= Math.min(box.z1, box.z2) &&
        z <= Math.max(box.z1, box.z2)
    );
}

/** The arena's own block at a place - the first fill over it, which `keep`
 *  leaves there - or null for air. */
function blockAt(own: readonly Solid[], x: number, y: number, z: number): string | null {
    const found = own.find((one) => inside(one, x, y, z));
    return found ? bareId(found.block) : null;
}

/**
 * The spots' pieces the arena leaves room for, flattened: a spot is kept
 * whole or not at all - every piece inside `bounds`, none where another piece
 * already is, a standing one into the arena's air with one of its blocks (or
 * the piece under it) right under it, a set one only where the arena's block
 * is the one it replaces.
 */
export function fitted(
    pieces: readonly (readonly Piece[])[],
    own: readonly Solid[],
    bounds: Bounds
): Piece[] {
    const taken = new Set<string>();
    const kept: Piece[] = [];
    for (const spot of pieces) {
        const cells = spot.map((one) => `${one.x},${one.y},${one.z}`);
        const fits = spot.every((one, index) => {
            if (!inside(bounds, one.x, one.y, one.z) || taken.has(cells[index]!)) return false;
            if (cells.indexOf(cells[index]!) !== index) return false;
            const here = blockAt(own, one.x, one.y, one.z);
            if (one.replaces) return here === bareId(one.replaces);
            if (here !== null) return false;
            if (index > 0) return true;
            return blockAt(own, one.x, one.y - 1, one.z) !== null;
        });
        if (!fits) continue;
        cells.forEach((cell) => taken.add(cell));
        kept.push(...spot);
    }
    return kept;
}

/** Each piece put in, bottom up: into air only, or only in place of the block it replaces. */
export function decorLines(pieces: readonly Piece[]): string[] {
    return pieces.map(
        (one) =>
            `execute in minecraft:overworld run fill ${one.x} ${one.y} ${one.z} ${one.x} ${one.y} ${one.z} ${one.block} ${one.replaces ? `replace ${one.replaces}` : "keep"}`
    );
}

/** The kinds of block the pieces are, bare, in the order they come down
 *  (`DECOR_BLOCKS`): for an arena's list, ahead of its own. */
export function idsOf(pieces: readonly Piece[]): string[] {
    const used = new Set(pieces.map((one) => bareId(one.block)));
    return [...new Set(DECOR_BLOCKS.map(bareId))].filter((id) => used.has(id));
}

// ------------------------------------------------------------------ trim

/**
 * The parts of an arena that only frame the game, which the season may
 * recolor: a floor's walls, a rim, a post, a light. A kind names which of its
 * own blocks plays which part (`Trim`); nothing it plays on is ever named - a
 * spleef's snow, a TNT run's TNT, a bridge's glass panels, a pillar's top.
 */
export type TrimRole =
    | "light"
    | "lantern"
    | "hangingLantern"
    | "wallA"
    | "wallB"
    | "wallC"
    | "rimA"
    | "rimB"
    | "rimC"
    | "rimD"
    | "pane"
    | "post"
    | "beam"
    | "edge"
    | "checkDark"
    | "checkLight"
    | "poolLight"
    | "trunk"
    | "leaves"
    | "boulder"
    | "column"
    | "middle";

/** A kind's own trim blocks, exactly as it places them, by the part each plays. */
export type Trim = Readonly<Record<string, TrimRole>>;

/** A trim block only a server from 1.16 has; `before` under it, or the kind's
 *  own block when null. */
interface SoulOnly {
    readonly soul: string;
    readonly before: string | null;
}

const SOUL_HANGING = "minecraft:soul_lantern[hanging=true]";

/**
 * What each part becomes in each season; a part not listed keeps the kind's
 * own block. Full blocks only, but for a lantern that takes the place of a
 * lantern: nothing here falls, melts, grows or is any less solid than the block
 * it stands in for, so a player is stopped, held up and kept out exactly as
 * before. The same cells, so the same air proved before it was built.
 */
export const SEASON_TRIM: Readonly<
    Record<Decoration, Readonly<Partial<Record<TrimRole, string | SoulOnly>>>>
> = {
    halloween: {
        light: JACK,
        lantern: { soul: SOUL_LANTERN, before: null },
        hangingLantern: { soul: SOUL_HANGING, before: null },
        wallA: "minecraft:orange_stained_glass",
        wallB: "minecraft:purple_stained_glass",
        wallC: "minecraft:black_stained_glass",
        rimA: "minecraft:orange_concrete",
        rimB: "minecraft:purple_concrete",
        rimC: "minecraft:black_concrete",
        rimD: "minecraft:magenta_concrete",
        pane: "minecraft:purple_stained_glass",
        post: { soul: "minecraft:polished_blackstone_bricks", before: "minecraft:black_concrete" },
        beam: "minecraft:orange_concrete",
        edge: "minecraft:orange_terracotta",
        checkLight: "minecraft:orange_concrete",
        poolLight: { soul: "minecraft:crying_obsidian", before: null },
        trunk: "minecraft:dark_oak_log",
        leaves: "minecraft:dark_oak_leaves[persistent=true]",
        boulder: CARVED,
        column: { soul: "minecraft:blackstone", before: "minecraft:black_concrete" },
        middle: JACK
    },
    winter: {
        wallA: "minecraft:red_stained_glass",
        wallB: "minecraft:green_stained_glass",
        wallC: "minecraft:white_stained_glass",
        rimA: "minecraft:red_concrete",
        rimB: "minecraft:white_concrete",
        rimC: "minecraft:green_concrete",
        rimD: "minecraft:light_blue_concrete",
        pane: "minecraft:white_stained_glass",
        beam: "minecraft:red_concrete",
        edge: "minecraft:red_terracotta",
        checkDark: "minecraft:red_concrete",
        trunk: "minecraft:spruce_log",
        leaves: LEAVES,
        boulder: "minecraft:packed_ice",
        column: "minecraft:quartz_block",
        middle: "minecraft:red_concrete"
    }
};

/** A lantern, bare: what stands on or hangs from another block. */
const hangs = (id: string) => id === LANTERN || id === SOUL_LANTERN;

/**
 * Every block the trim can be, bare, in the order they come down: a lantern
 * first, before whatever it stands on or hangs from.
 */
export const TRIM_BLOCKS: readonly string[] = [
    ...new Set(
        Object.values(SEASON_TRIM)
            .flatMap((parts) => Object.values(parts))
            .flatMap((one) =>
                typeof one === "string" ? [one] : [one.soul, ...(one.before ? [one.before] : [])]
            )
            .map(bareId)
            .sort((left, right) => Number(hangs(right)) - Number(hangs(left)))
    )
];

/** The season's block for one of a kind's own: the kind's own when it plays
 *  no part in `trim`, out of season, or for a part the season leaves alone. */
export function trimmed(block: string, trim: Trim | undefined, dressing: Dressing | null): string {
    if (!dressing || !trim || !Object.hasOwn(trim, block)) return block;
    const pick = SEASON_TRIM[dressing.season][trim[block]!];
    if (pick === undefined) return block;
    if (typeof pick === "string") return pick;
    return dressing.era.soulLanterns ? pick.soul : (pick.before ?? block);
}

/** A kind's fills (or boxes) in the season's trim: the same boxes in the same
 *  order, only a trim block swapped. Exactly what was given out of season. */
export function trimFills<T extends { readonly block: string }>(
    fills: readonly T[],
    trim: Trim | undefined,
    dressing: Dressing | null
): T[] {
    if (!dressing || !trim) return [...fills];
    return fills.map((one) => {
        const block = trimmed(one.block, trim, dressing);
        return block === one.block ? one : ({ ...one, block } as T);
    });
}

/**
 * The trim blocks among what is built, bare, for an arena's list: a lantern
 * goes `first`, ahead of everything (it rests on the arena); a full block
 * `last`, after the kind's own (one of them may hang from it).
 */
export function trimIds(blocks: readonly string[]): { first: string[]; last: string[] } {
    const used = new Set(blocks.map(bareId));
    const ids = TRIM_BLOCKS.filter((id) => used.has(id));
    return { first: ids.filter(hangs), last: ids.filter((id) => !hangs(id)) };
}

/** Four corners of a rectangle, at one height. */
export function corners(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    y: number
): { x: number; y: number; z: number }[] {
    return [
        { x: x1, y, z: z1 },
        { x: x2, y, z: z1 },
        { x: x1, y, z: z2 },
        { x: x2, y, z: z2 }
    ];
}
