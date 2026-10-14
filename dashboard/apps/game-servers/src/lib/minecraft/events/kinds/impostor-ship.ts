/**
 * The impostor station from design 3 (`impostor.ts` `SHIP_SINCE`): a ship laid
 * out the way the game it is modelled on lays out its own - a cafeteria at the
 * top with the emergency table, long corridors off it, and themed rooms round
 * it, each drawn by hand for what it is.
 *
 * The ship is a grid of cells `PITCH` blocks apart. A room sits centered on the
 * cells it spans, at its own size; a hall is a cell that is only corridor, a
 * junction. A corridor runs straight between the centers of two cells next to
 * each other (`EDGES`), so it meets every room through the middle of a wall.
 * Up to eight players the ship is its right-hand five columns; past eight the
 * engine wing to the west - reactor, both engines, security - is added.
 *
 * A template draws a room in its own terms: `u` across (west to east), `v`
 * deep (north to south), both from 0 at the inside of the walls, and `level`
 * from 1 on the floor to `WALL` under the roof. What it puts down first wins.
 * Besides its blocks it hands over its task stations, and where a vent can go.
 * Every block is one a 1.16 server has, and none falls, flows, burns, spreads,
 * gives off or takes redstone power, or needs a wall to hang from.
 *
 * Pure.
 */

import type { StationKind } from "./impostor";

/** The cells' spacing. */
export const PITCH = 20;
/** How high a wall stands over the floor; the roof is on top of it. */
export const WALL = 5;
/** The cell columns the small ship starts from: the engine wing is 0 and 1. */
export const WING_COLS = 2;
export const COLS_FULL = 7;
export const ROWS_FULL = 3;

export const SHIP_ROOMS = [
    "cafeteria",
    "reactor",
    "upperEngine",
    "lowerEngine",
    "security",
    "medbay",
    "electrical",
    "admin",
    "storage",
    "weapons",
    "o2",
    "navigation",
    "shields",
    "communications"
] as const;
export type ShipRoom = (typeof SHIP_ROOMS)[number];

/** A room on the grid: the cells it spans, and its size, walls included. */
export interface Plot {
    readonly name: ShipRoom;
    readonly cols: readonly [number, number];
    readonly rows: readonly [number, number];
    readonly w: number;
    readonly d: number;
    /** Only on the full ship. */
    readonly wing?: boolean;
}

export const PLOTS: readonly Plot[] = [
    { name: "cafeteria", cols: [3, 4], rows: [0, 0], w: 35, d: 17 },
    { name: "reactor", cols: [0, 0], rows: [0, 2], w: 15, d: 47, wing: true },
    { name: "upperEngine", cols: [1, 1], rows: [0, 0], w: 17, d: 15, wing: true },
    { name: "security", cols: [1, 1], rows: [1, 1], w: 11, d: 11, wing: true },
    { name: "lowerEngine", cols: [1, 1], rows: [2, 2], w: 17, d: 15, wing: true },
    { name: "medbay", cols: [2, 2], rows: [1, 1], w: 15, d: 13 },
    { name: "electrical", cols: [2, 2], rows: [2, 2], w: 15, d: 13 },
    { name: "admin", cols: [4, 4], rows: [1, 1], w: 15, d: 13 },
    { name: "storage", cols: [3, 4], rows: [2, 2], w: 31, d: 15 },
    { name: "weapons", cols: [5, 5], rows: [0, 0], w: 15, d: 15 },
    { name: "o2", cols: [5, 5], rows: [1, 1], w: 13, d: 11 },
    { name: "navigation", cols: [6, 6], rows: [1, 1], w: 15, d: 17 },
    { name: "shields", cols: [6, 6], rows: [2, 2], w: 13, d: 13 },
    { name: "communications", cols: [5, 5], rows: [2, 2], w: 13, d: 13 }
];

/** The cells that are only corridor: where three ways meet. */
export const HALLS: readonly (readonly [number, number])[] = [
    [2, 0],
    [3, 1]
];

/** The corridors, each between two cells side by side, by column and row. */
export const EDGES: readonly (readonly [number, number, number, number])[] = [
    [0, 0, 1, 0],
    [0, 1, 1, 1],
    [0, 2, 1, 2],
    [1, 0, 2, 0],
    [2, 0, 3, 0],
    [2, 0, 2, 1],
    [1, 2, 2, 2],
    [2, 2, 3, 2],
    [3, 0, 3, 1],
    [3, 1, 4, 1],
    [3, 1, 3, 2],
    [4, 0, 5, 0],
    [5, 0, 5, 1],
    [5, 1, 6, 1],
    [6, 1, 6, 2],
    [6, 2, 5, 2],
    [5, 2, 4, 2]
];

/** How many interior columns at the east of navigation are space: the backdrop
 *  and the dark in front of it, then the window. */
export const SPACE_COLS = 2;

/** Each room's floor. */
export const FLOORS: Readonly<Record<ShipRoom, string>> = {
    cafeteria: "minecraft:polished_andesite",
    reactor: "minecraft:polished_blackstone_bricks",
    upperEngine: "minecraft:smooth_stone",
    lowerEngine: "minecraft:smooth_stone",
    security: "minecraft:gray_terracotta",
    medbay: "minecraft:white_concrete",
    electrical: "minecraft:polished_blackstone",
    admin: "minecraft:smooth_quartz",
    storage: "minecraft:spruce_planks",
    weapons: "minecraft:dark_prismarine",
    o2: "minecraft:prismarine_bricks",
    navigation: "minecraft:blue_terracotta",
    shields: "minecraft:light_blue_terracotta",
    communications: "minecraft:cyan_terracotta"
};

/** What a template draws with: its room's inside. */
export interface Canvas {
    /** The inside's size: `u` 0 to `w - 1`, `v` 0 to `d - 1`. */
    readonly w: number;
    readonly d: number;
    readonly random: () => number;
    /** A box of one block, levels `l1` to `l2`; what is already there stays. */
    put(
        block: string,
        u1: number,
        l1: number,
        v1: number,
        u2?: number,
        l2?: number,
        v2?: number
    ): void;
    station(kind: StationKind, u: number, v: number): void;
    /** Where a vent can go, and where whoever comes out of it stands. */
    vent(u: number, v: number, outU: number, outV: number): void;
}

// ------------------------------------------------------------------ blocks

const CARPET_BLUE = "minecraft:light_blue_carpet";
const CARPET_WHITE = "minecraft:white_carpet";
const CARPET_YELLOW = "minecraft:yellow_carpet";
const FERN = "minecraft:fern";
const LANTERN = "minecraft:lantern[hanging=true]";
const CHAIN_X = "minecraft:chain[axis=x]";
const CHAIN_Y = "minecraft:chain[axis=y]";
const CHAIN_Z = "minecraft:chain[axis=z]";
const BARREL = "minecraft:barrel[facing=up]";
const DESK_STONE = "minecraft:smooth_stone_slab[type=top]";
const DESK_DARK = "minecraft:polished_blackstone_slab[type=top]";
const DESK_LIGHT = "minecraft:polished_andesite_slab[type=top]";
const TABLE_TOP = "minecraft:smooth_quartz_slab[type=top]";
const BENCH = "minecraft:spruce_slab[type=bottom]";
const SCREEN_BLUE = "minecraft:light_blue_stained_glass";
const SCREEN_GREEN = "minecraft:lime_stained_glass";
const SCREEN_RED = "minecraft:red_stained_glass";
const GLASS_WHITE = "minecraft:white_stained_glass";
const GLASS_ORANGE = "minecraft:orange_stained_glass";
const GLASS_YELLOW = "minecraft:yellow_stained_glass";
const FRAME = "minecraft:black_concrete";
const METAL = "minecraft:iron_block";

/** What stands or hangs on another block: taken down before anything. */
export const SHIP_STANDING: readonly string[] = [
    "minecraft:lantern",
    CARPET_BLUE,
    CARPET_WHITE,
    CARPET_YELLOW,
    FERN
];

// ------------------------------------------------------------------ helpers

/** A round table with a bench either side, centered on `u`, `v`. */
function diningTable(c: Canvas, u: number, v: number): void {
    c.put("minecraft:smooth_quartz", u, 1, v);
    c.put(TABLE_TOP, u - 1, 1, v - 1, u + 1, 1, v + 1);
    c.put(BENCH, u - 2, 1, v - 1, u - 2, 1, v + 1);
    c.put(BENCH, u + 2, 1, v - 1, u + 2, 1, v + 1);
    c.put(LANTERN, u, WALL, v);
}

/** A cot along the west wall: a pillow at `u`, a blanket over the rest. */
function cot(c: Canvas, u: number, v: number): void {
    c.put("minecraft:white_wool", u, 1, v, u + 1, 1, v);
    c.put(CARPET_WHITE, u, 2, v);
    c.put(CARPET_BLUE, u + 1, 2, v);
}

/** A wall of screens in a black frame, along `v` from `u1` to `u2`. */
function screensAlongV(c: Canvas, v: number, u1: number, u2: number, screen: string): void {
    for (let u = u1 + 1; u < u2; u += 2) c.put(screen, u, 2, v, u, 3, v);
    c.put(FRAME, u1, 2, v, u2, 4, v);
}

/** The same, along `u`, from `v1` to `v2`. */
function screensAlongU(c: Canvas, u: number, v1: number, v2: number, screen: string): void {
    for (let v = v1 + 1; v < v2; v += 2) c.put(screen, u, 2, v, u, 3, v);
    c.put(FRAME, u, 2, v1, u, 4, v2);
}

/** A stack of crates, one to three high. */
function crates(c: Canvas, u1: number, v1: number, u2: number, v2: number): void {
    const kinds = [
        BARREL,
        "minecraft:spruce_planks",
        "minecraft:oak_planks",
        "minecraft:stripped_oak_wood"
    ];
    for (let u = u1; u <= u2; u += 1)
        for (let v = v1; v <= v2; v += 1) {
            const high = 1 + Math.floor(c.random() * 3);
            c.put(kinds[Math.floor(c.random() * kinds.length)]!, u, 1, v, u, high, v);
        }
}

// ------------------------------------------------------------------ the rooms

type Template = (c: Canvas) => void;

/** 33 by 15: the emergency table in the middle (drawn with the stations),
 *  four dining tables round it, the kitchen counter along the north. */
const cafeteria: Template = (c) => {
    for (const [u, v] of [
        [5, 4],
        [27, 4],
        [5, 11],
        [27, 11]
    ] as const)
        diningTable(c, u, v);
    // The counter: two stoves and a crate of food on it.
    c.put("minecraft:smoker[facing=south]", 11, 1, 0);
    c.put("minecraft:smoker[facing=south]", 21, 1, 0);
    c.put(BARREL, 13, 2, 0);
    c.put(BARREL, 19, 2, 0);
    c.put("minecraft:smooth_quartz", 10, 1, 0, 22, 1, 0);
    // The vending machines in the corners.
    for (const u of [1, 31]) {
        c.put(SCREEN_BLUE, u, 2, 0);
        c.put("minecraft:white_concrete", u, 1, 0, u, 3, 0);
    }
    for (const u of [10, 16, 22]) c.put(LANTERN, u, WALL, 2);
};

/** 13 by 45: the core in the middle behind glass, coolant tanks at either
 *  end, pipes along the west wall. */
const reactor: Template = (c) => {
    c.put("minecraft:beacon", 6, 1, 22);
    c.put("minecraft:sea_lantern", 5, 1, 21, 7, 4, 23);
    c.put(SCREEN_BLUE, 4, 1, 20, 8, 4, 24);
    c.put(METAL, 4, 5, 20, 8, 5, 24);
    // Hazard markings round it.
    for (let u = 3; u <= 9; u += 1) for (const v of [19, 25]) c.put(CARPET_YELLOW, u, 1, v);
    for (let v = 20; v <= 24; v += 1) for (const u of [3, 9]) c.put(CARPET_YELLOW, u, 1, v);
    // Coolant tanks and their pipes.
    for (const v of [1, 42]) {
        c.put("minecraft:light_blue_concrete", 0, 1, v, 1, 3, v + 1);
        c.put(CHAIN_Y, 0, 4, v, 1, 5, v + 1);
    }
    c.put(CHAIN_Z, 0, 4, 4, 0, 4, 40);
    // The manifolds: a panel of lights along the west wall.
    for (let v = 8; v <= 14; v += 2) c.put(SCREEN_GREEN, 0, 2, v);
    c.put(FRAME, 0, 1, 7, 0, 3, 15);
    // Two generators at the south end.
    c.put("minecraft:polished_basalt[axis=y]", 2, 1, 34, 3, 4, 35);
    c.put("minecraft:polished_basalt[axis=y]", 9, 1, 34, 10, 4, 35);
    for (const v of [5, 12, 31, 39]) c.put(LANTERN, 6, WALL, v);
    c.station("button", 6, 16);
    c.station("switch", 1, 11);
    c.station("scan", 6, 29);
    c.vent(2, 9, 3, 10);
};

/** 15 by 13 inside each: the engine along the north, its exhaust glowing at
 *  the west end, fuel cans at the south. */
const engine: Template = (c) => {
    c.put("minecraft:shroomlight", 2, 2, 3);
    c.put(GLASS_ORANGE, 2, 1, 2, 2, 3, 4);
    c.put(METAL, 6, 1, 2, 6, 3, 4);
    c.put(METAL, 10, 1, 2, 10, 3, 4);
    c.put("minecraft:polished_basalt[axis=x]", 3, 1, 2, 12, 3, 4);
    c.put(CHAIN_Y, 4, 4, 3, 4, 5, 3);
    c.put(CHAIN_Y, 8, 4, 3, 8, 5, 3);
    c.put(CHAIN_Y, 12, 4, 3, 12, 5, 3);
    c.put("minecraft:red_terracotta", 1, 1, 11, 2, 2, 12);
    c.put(BARREL, 3, 1, 12);
    c.put(LANTERN, 7, WALL, 9);
    c.station("button", 5, 10);
    c.station("switch", 10, 10);
    c.vent(13, 11, 12, 10);
};

/** 9 by 9: the camera screens along the east wall over a desk. */
const security: Template = (c) => {
    screensAlongU(c, 8, 1, 7, SCREEN_BLUE);
    c.put(DESK_STONE, 7, 1, 1, 7, 1, 7);
    c.put("minecraft:quartz_stairs[facing=west]", 5, 1, 2);
    c.put("minecraft:quartz_stairs[facing=west]", 5, 1, 6);
    c.put(LANTERN, 4, WALL, 4);
    c.station("button", 7, 4);
    c.station("switch", 3, 8);
    c.vent(2, 1, 3, 2);
};

/** 13 by 11: cots along the west wall, the scanner in its glass ring, the
 *  cabinets along the east. */
const medbay: Template = (c) => {
    for (const v of [2, 5, 8]) cot(c, 0, v);
    for (const [u, v] of [
        [8, 3],
        [10, 3],
        [8, 5],
        [10, 5]
    ] as const)
        c.put(SCREEN_BLUE, u, 1, v, u, 3, v);
    c.put(SCREEN_BLUE, 8, 4, 3, 10, 4, 5);
    c.put("minecraft:cauldron", 12, 1, 8);
    c.put(DESK_LIGHT, 12, 1, 1, 12, 1, 6);
    c.put("minecraft:brewing_stand", 12, 2, 2);
    c.put("minecraft:brewing_stand", 12, 2, 5);
    // A red cross high on the south wall.
    for (const [u, l] of [
        [6, 3],
        [6, 4],
        [6, 5],
        [5, 4],
        [7, 4]
    ] as const)
        c.put("minecraft:red_concrete", u, l, 10);
    c.station("scan", 9, 4);
    c.station("button", 4, 8);
    c.vent(11, 7, 10, 7);
};

/** 13 by 11: the breaker panels along the north wall, the wiring overhead,
 *  the generators at the south. */
const electrical: Template = (c) => {
    for (const u of [2, 5, 7, 10]) c.put(GLASS_YELLOW, u, 2, 0, u, 3, 0);
    c.put(METAL, 1, 1, 0, 11, 4, 0);
    c.put(CHAIN_X, 0, WALL, 3, 12, WALL, 3);
    c.put(CHAIN_X, 0, WALL, 6, 12, WALL, 6);
    c.put("minecraft:yellow_terracotta", 2, 1, 10, 3, 2, 10);
    c.put("minecraft:polished_blackstone", 1, 1, 9, 4, 3, 10);
    c.put("minecraft:yellow_terracotta", 9, 1, 10, 10, 2, 10);
    c.put("minecraft:polished_blackstone", 8, 1, 9, 11, 3, 10);
    c.station("switch", 4, 1);
    c.station("switch", 8, 1);
    c.vent(6, 9, 6, 8);
};

/** 13 by 11: the map table in the middle, glowing, files along the north. */
const admin: Template = (c) => {
    c.put(SCREEN_BLUE, 5, 1, 4, 8, 1, 6);
    c.put("minecraft:smooth_quartz", 4, 1, 3, 9, 1, 7);
    for (const [u, v] of [
        [4, 3],
        [9, 3],
        [4, 7],
        [9, 7]
    ] as const)
        c.put("minecraft:end_rod[facing=up]", u, 2, v);
    c.put("minecraft:bookshelf", 3, 1, 0, 9, 2, 0);
    c.put(BARREL, 12, 1, 4, 12, 2, 6);
    c.put(LANTERN, 6, WALL, 5);
    c.station("button", 11, 1);
    c.station("switch", 11, 9);
    c.vent(1, 9, 2, 8);
};

/** 29 by 13: stacks of crates either side of the aisle, the fuel tank in
 *  the corner. */
const storage: Template = (c) => {
    for (const u of [8, 14, 20]) {
        crates(c, u, 0, u + 2, 2);
        crates(c, u, 10, u + 2, 12);
    }
    c.put("minecraft:red_terracotta", 25, 1, 0, 27, 3, 1);
    c.put(CHAIN_Y, 26, 4, 0, 26, 5, 0);
    for (const u of [5, 11, 17, 23]) c.put(LANTERN, u, WALL, 6);
    c.station("button", 24, 3);
    c.station("scan", 4, 10);
};

/** 13 by 13: the targeting screen on the north wall over the gunner's desk,
 *  the ammunition racks along the east. */
const weapons: Template = (c) => {
    c.put("minecraft:target", 6, 3, 0);
    for (const [u, l] of [
        [5, 3],
        [7, 3],
        [6, 2],
        [6, 4]
    ] as const)
        c.put(SCREEN_GREEN, u, l, 0);
    c.put(FRAME, 3, 2, 0, 9, 4, 0);
    c.put(DESK_DARK, 3, 1, 1, 9, 1, 1);
    c.put("minecraft:iron_bars", 12, 1, 1, 12, 3, 3);
    c.put(METAL, 12, 1, 9, 12, 1, 11);
    c.put("minecraft:red_concrete", 12, 2, 9, 12, 2, 11);
    c.put(LANTERN, 6, WALL, 6);
    c.station("button", 6, 1);
    c.station("switch", 10, 10);
    c.vent(2, 10, 3, 9);
};

/** 11 by 9: planters along the west wall, the oxygen tanks along the south. */
const o2: Template = (c) => {
    for (let v = 1; v <= 7; v += 1)
        c.put(v % 2 === 1 ? FERN : "minecraft:birch_leaves[persistent=true]", 0, 2, v);
    c.put("minecraft:podzol", 0, 1, 1, 0, 1, 7);
    for (const [u, block] of [
        [2, "minecraft:white_concrete"],
        [4, "minecraft:light_blue_concrete"],
        [6, "minecraft:white_concrete"]
    ] as const) {
        c.put(block, u, 1, 8, u + 1, 3, 8);
        c.put(CHAIN_Y, u, 4, 8, u, 5, 8);
    }
    c.put(GLASS_WHITE, 9, 1, 8, 10, 2, 8);
    c.station("button", 3, 4);
    c.station("switch", 8, 6);
};

/** 13 by 15, the east of it space behind a window: the pilot's desk along
 *  the window, a star chart on the north wall. */
const navigation: Template = (c) => {
    c.put(DESK_LIGHT, 9, 1, 2, 9, 1, 12);
    c.put("minecraft:quartz_stairs[facing=west]", 7, 1, 4);
    c.put("minecraft:quartz_stairs[facing=west]", 7, 1, 10);
    for (const u of [2, 5]) c.put("minecraft:glowstone", u, 3, 0);
    c.put("minecraft:sea_lantern", 4, 2, 0);
    c.put(FRAME, 1, 2, 0, 6, 4, 0);
    c.put(LANTERN, 5, WALL, 7);
    c.station("button", 9, 7);
    c.station("switch", 3, 2);
    c.vent(1, 12, 2, 11);
};

/** 11 by 11: the shield panels on the east wall, the generator at the
 *  south. */
const shields: Template = (c) => {
    for (let v = 2; v <= 8; v += 1)
        for (let l = 2; l <= 4; l += 1)
            c.put((v + l) % 2 === 0 ? GLASS_WHITE : SCREEN_RED, 10, l, v);
    c.put("minecraft:beacon", 5, 2, 9);
    c.put(METAL, 4, 1, 9, 6, 1, 10);
    c.put(LANTERN, 5, WALL, 5);
    c.station("button", 8, 5);
    c.station("switch", 2, 8);
    c.vent(8, 1, 7, 2);
};

/** 11 by 11: the radio desk along the north wall, the antenna mast at the
 *  south. */
const communications: Template = (c) => {
    screensAlongV(c, 0, 2, 8, SCREEN_GREEN);
    c.put("minecraft:jukebox", 1, 1, 0);
    c.put(DESK_STONE, 2, 1, 0, 8, 1, 0);
    c.put("minecraft:iron_bars", 5, 1, 9, 5, 4, 9);
    c.put(TABLE_TOP, 4, 5, 8, 6, 5, 10);
    c.station("button", 5, 1);
    c.station("switch", 9, 9);
};

export const TEMPLATES: Readonly<Record<ShipRoom, Template>> = {
    cafeteria,
    reactor,
    upperEngine: engine,
    lowerEngine: engine,
    security,
    medbay,
    electrical,
    admin,
    storage,
    weapons,
    o2,
    navigation,
    shields,
    communications
};

/** Every block the rooms are furnished with but `SHIP_STANDING`. */
export const SHIP_BLOCKS: readonly string[] = [
    "minecraft:chain",
    BARREL,
    DESK_STONE,
    DESK_DARK,
    DESK_LIGHT,
    TABLE_TOP,
    BENCH,
    SCREEN_BLUE,
    SCREEN_GREEN,
    SCREEN_RED,
    GLASS_WHITE,
    GLASS_ORANGE,
    GLASS_YELLOW,
    FRAME,
    METAL,
    "minecraft:smooth_quartz",
    "minecraft:smoker",
    "minecraft:white_concrete",
    "minecraft:beacon",
    "minecraft:sea_lantern",
    "minecraft:light_blue_concrete",
    "minecraft:polished_basalt",
    "minecraft:shroomlight",
    "minecraft:red_terracotta",
    "minecraft:quartz_stairs",
    "minecraft:white_wool",
    "minecraft:cauldron",
    "minecraft:brewing_stand",
    "minecraft:red_concrete",
    "minecraft:yellow_terracotta",
    "minecraft:polished_blackstone",
    "minecraft:end_rod",
    "minecraft:bookshelf",
    "minecraft:spruce_planks",
    "minecraft:oak_planks",
    "minecraft:stripped_oak_wood",
    "minecraft:target",
    "minecraft:iron_bars",
    "minecraft:birch_leaves",
    "minecraft:podzol",
    "minecraft:glowstone",
    "minecraft:jukebox",
    ...Object.values(FLOORS)
].map((id) => id.replace(/\[.*$/, ""));
