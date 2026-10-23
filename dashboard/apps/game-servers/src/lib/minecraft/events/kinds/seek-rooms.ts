/**
 * The rooms hide and seek's manor (`seek-manor.ts`) is put together from: a
 * library of hand-made templates, each with its own look and its own hiding
 * places, set into the house turned any of four ways and mirrored: a grid of
 * rooms filled from templates that fit the openings a path through it needs,
 * the pieces joined at matching connectors.
 *
 * A template draws in its room's own terms: `u` across, `v` deep, 0 to 13, the
 * north side at `v` 0; levels from the floor, 1 to 10 inside, the cellars down
 * to -3 (the pond to -5). Its facings are its own too; the canvas turns them
 * with the room. What a template draws first wins, as in the rest of the house:
 * the doorways in front of each opening are kept clear before it draws, so
 * nothing it puts down blocks one.
 *
 * Besides its blocks a template hands over:
 *
 * - `hook`s: where a key to a secret could be - a button on the furniture, a
 *   rug to crouch on, a lit tile under a lamp to look up from, a head on a
 *   shelf to stare at. The manor picks keys among them (`seek-manor.ts`); the
 *   rest stay as they are, so a button or a rug that does nothing looks the
 *   same as one that opens something.
 * - `spot`s: each hiding place, by a place to stand in it, which the rules
 *   check can be reached.
 * - what the wall nooks round it are opened by (`entrances`): a painting, a
 *   panel of the wall's own blocks, a door, a wall you can walk through (from
 *   1.19.4), or a waterfall.
 * - `pad`s (from design 5): slime blocks in the floor the data pack throws a
 *   player up from (`secret-panels.ts`).
 *
 * A template added in a later design says so (`since`): a house an older
 * design built never draws it, so it is drawn exactly as it was. One made for
 * a season says which (`season`), and only a house built in it draws it.
 *
 * Every piece of furniture of a kind has the same size wherever it stands,
 * whether or not it hides anything: a hollow crate stack and a full one, a
 * wardrobe with room in it and one without, look and measure the same.
 *
 * Pure.
 */

import * as maze from "./seek-maze";
import type { Era } from "./seek-grid";
import type { Material } from "./secret-panels";
import type { Decoration } from "../../seasonal";

export type Side = "north" | "south" | "east" | "west";
export const SIDES: readonly Side[] = ["north", "south", "east", "west"];
/** Where along a side its doorway may start: in line with a maze's corridors. */
export const SLOTS = [3, 6, 9] as const;
/** The last cell of a room, either way. */
export const LAST = 13;

export type Entrance = "painting" | "panel" | "door" | "veil" | "falls";

export type HookKind = "btn" | "rug" | "tile" | "gaze";
export interface Hook {
    readonly kind: HookKind;
    readonly u: number;
    readonly level: number;
    readonly v: number;
    /** Where somebody stands to use it: in front of a button, on a rug or a
     *  tile, a few blocks from what is stared at. */
    readonly from: { readonly u: number; readonly v: number };
}

export interface Style {
    /** The rooms' side of the walls: what a panel or a walk-through wall in
     *  them is made of. */
    readonly face: Material;
    readonly floor: string;
    /** How its walls' nooks open, in order of preference. */
    readonly entrances: readonly Entrance[];
}

/** What a template draws with: its room, turned into the house. */
export interface Canvas {
    readonly random: () => number;
    readonly era: Era;
    /** The house's design (`seek-manor.DESIGN`). */
    readonly design: number;
    readonly style: Style;
    /** Its doorways, by side and where along it they start (two wide). */
    readonly doors: readonly { readonly side: Side; readonly at: number }[];
    set(
        block: string,
        u1: number,
        l1: number,
        v1: number,
        u2?: number,
        l2?: number,
        v2?: number
    ): void;
    clear(u1: number, l1: number, v1: number, u2?: number, l2?: number, v2?: number): void;
    free(u: number, level: number, v: number): boolean;
    /** A floor panel the data pack opens (`secret-panels.ts`): its block, a
     *  ladder under it facing `facing`, and a button inside to get out. */
    floorPanel(
        u: number,
        v: number,
        facing: Side,
        inside: { u: number; level: number; v: number; facing: Side },
        bottom?: number
    ): void;
    /** A wall panel two high from `level` (from design 7, anywhere in the
     *  room: a loft, a tower), of the room's face, that the data pack opens
     *  into air: `facing` the way through it from where somebody stands to
     *  use it, and a button on the far side to get back out. False where
     *  there is no room for it. */
    wallPanel(
        u: number,
        level: number,
        v: number,
        facing: Side,
        inside: { u: number; level: number; v: number; facing: Side }
    ): boolean;
    /** A block shown by a display entity over air (from 1.19.4). */
    display(block: string, u: number, level: number, v: number): void;
    hook(hook: Hook): void;
    spot(u: number, feet: number, v: number): void;
    /** A launch pad in the floor (from design 5): a slime block the pack
     *  throws whoever stands on it up from. */
    pad(u: number, v: number): void;
    /** A painting hung over a gap (from design 9), as a nook's: at `u`,
     *  `level`, `v`, one wide and two high, facing `facing`, on what is behind
     *  it - banners, which hold it up and let a player walk through. */
    painting(u: number, level: number, v: number, facing: Side): void;
    /** A fish summoned once the house is built (from design 8): only ever
     *  into water sealed in on every side. */
    fish(u: number, level: number, v: number): void;
}

export interface Template {
    readonly name: string;
    readonly style: Style;
    /** Whether the server can show it at all. */
    readonly fits?: (era: Era) => boolean;
    /** The first design that draws it. */
    readonly since?: number;
    /** The only season a house draws it in (`SEASONAL`); never out of it. */
    readonly season?: Decoration;
    /** Whether it holds a fire: the season's touch (`dress`) puts nothing
     *  that burns in it. */
    readonly fire?: boolean;
    draw(canvas: Canvas): void;
}

// ------------------------------------------------------------------ helpers

const pick = <T>(random: () => number, list: readonly T[]): T =>
    list[Math.floor(random() * list.length)]!;

/** A list in a random order (Fisher-Yates). */
function shuffle<T>(random: () => number, list: readonly T[]): T[] {
    const out = [...list];
    for (let index = out.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [out[index], out[other]] = [out[other]!, out[index]!];
    }
    return out;
}

/** A local side's way, as a step. */
export const STEP: Readonly<Record<Side, readonly [number, number]>> = {
    north: [0, -1],
    south: [0, 1],
    west: [-1, 0],
    east: [1, 0]
};

export function opposite(side: Side): Side {
    return ({ north: "south", south: "north", east: "west", west: "east" } as const)[side];
}

const hasDoor = (c: Canvas, side: Side) => c.doors.some((door) => door.side === side);

/** A button on the block behind it, facing out at `facing`; a hook too. */
function button(c: Canvas, block: string, u: number, level: number, v: number, facing: Side): void {
    if (!c.free(u, level, v)) return;
    c.set(`${block}[face=wall,facing=${facing},powered=false]`, u, level, v);
    const [du, dv] = STEP[facing];
    c.hook({ kind: "btn", u, level, v, from: { u: u + du, v: v + dv } });
}

/** A rug to crouch on. */
function rug(c: Canvas, color: string, u: number, v: number): void {
    if (!c.free(u, 1, v)) return;
    c.set(`minecraft:${color}_carpet`, u, 1, v);
    c.hook({ kind: "rug", u, level: 1, v, from: { u, v } });
}

/** A pale rug under a lamp in the ceiling: somewhere to look up from. */
function tile(c: Canvas, u: number, v: number): void {
    if (!c.free(u, 1, v) || !c.free(u, 10, v)) return;
    c.set("minecraft:white_carpet", u, 1, v);
    c.set("minecraft:glowstone", u, 10, v);
    c.hook({ kind: "tile", u, level: 1, v, from: { u, v } });
}

/** Something to stare at, seen from `from`. */
function gaze(
    c: Canvas,
    block: string,
    u: number,
    level: number,
    v: number,
    from: { u: number; v: number }
): void {
    if (!c.free(u, level, v)) return;
    c.set(block, u, level, v);
    c.hook({ kind: "gaze", u, level, v, from });
}

/** A cellar under the floor, `u1..u2` by `v1..v2`, three high, lit in a corner. */
function cellar(c: Canvas, u1: number, v1: number, u2: number, v2: number): void {
    c.clear(u1, -3, v1, u2, -1, v2);
    c.set("minecraft:sea_lantern", u1, -4, v2);
    c.set("minecraft:sea_lantern", u2, -4, v1);
}

/** A trapdoor flush with the floor over a ladder down a cellar's side: the
 *  ladder and the open trapdoor face the same way, so it climbs. */
function hatch(c: Canvas, wood: string, u: number, v: number, facing: Side): void {
    c.set(`minecraft:${wood}_trapdoor[facing=${facing},half=top,open=false]`, u, 0, v);
    c.set(`minecraft:ladder[facing=${facing}]`, u, -3, v, u, -1, v);
}

/**
 * A way in one wide on the south side of a little house, at `u`, `v`: banners
 * of `colour` in the gap, hung on its west side. Up to design 8 that was all,
 * and the gap stood open with a banner edge-on in it; from design 9
 * (`PAINTED_SINCE`) a painting hangs over the gap on them, as on a nook's, and
 * the air in front of it is kept clear for it.
 */
function curtain(c: Canvas, colour: string, u: number, v: number): void {
    c.set(`minecraft:${colour}_wall_banner[facing=east]`, u, 1, v, u, 2, v);
    if (c.design < PAINTED_SINCE) return;
    c.clear(u, 1, v + 1, u, 2, v + 1);
    c.painting(u, 1, v + 1, "south");
}

// ------------------------------------------------------------------ the library

/** The middle room: the seekers' cage and the hiders' ring round it, kept
 *  clear, columns in the corners and the walls' nooks to find. */
export const FOYER: Template = {
    name: "foyer",
    style: {
        face: "minecraft:quartz_block",
        floor: "minecraft:polished_andesite",
        entrances: ["painting", "veil", "panel"]
    },
    draw(c) {
        for (const [u, v] of [
            [1, 1],
            [1, 12],
            [12, 1],
            [12, 12]
        ] as const) {
            c.set("minecraft:quartz_pillar", u, 1, v, u, 9, v);
            c.set("minecraft:sea_lantern", u, 10, v);
        }
        button(c, "minecraft:stone_button", 2, 2, 1, "east");
        button(c, "minecraft:stone_button", 11, 2, 12, "west");
        button(c, "minecraft:stone_button", 1, 2, 2, "south");
        tile(c, 1, 6);
        tile(c, 12, 7);
    }
};

const LIBRARY: Template = {
    name: "library",
    style: {
        face: "minecraft:bookshelf",
        floor: "minecraft:dark_oak_planks",
        entrances: ["panel", "veil", "painting"]
    },
    draw(c) {
        // Two rows of shelves, every one a block deep and three high.
        for (const v of [4, 9])
            for (const [u1, u2] of [
                [3, 5],
                [8, 10]
            ] as const) {
                c.set("minecraft:bookshelf", u1, 1, v, u2, 3, v);
                button(c, "minecraft:oak_button", u1 - 1, 2, v, "west");
            }
        gaze(c, "minecraft:skeleton_skull[rotation=8]", 4, 4, 4, { u: 4, v: 7 });
        gaze(c, "minecraft:skeleton_skull[rotation=0]", 9, 4, 9, { u: 9, v: 6 });
        rug(c, "red", 6, 7);
        tile(c, 7, 6);
        // A reading cellar under a rug-coloured trapdoor in the dark floor.
        if (c.random() < 0.7) {
            cellar(c, 11, 10, 12, 12);
            hatch(c, "dark_oak", 11, 11, "east");
            c.spot(12, -3, 12);
        }
    }
};

const KITCHEN: Template = {
    name: "kitchen",
    style: {
        face: "minecraft:bricks",
        floor: "minecraft:polished_andesite",
        entrances: ["door", "painting", "panel"]
    },
    draw(c) {
        // An island in the middle: worktop, stove, sink.
        c.set("minecraft:smooth_stone", 5, 1, 6, 8, 1, 7);
        c.set("minecraft:furnace[facing=north]", 5, 1, 6);
        c.set("minecraft:cauldron", 8, 1, 6);
        c.set("minecraft:crafting_table", 8, 1, 7);
        button(c, "minecraft:stone_button", 4, 1, 7, "west");
        button(c, "minecraft:stone_button", 9, 1, 6, "east");
        gaze(c, "minecraft:jack_o_lantern[facing=south]", 6, 2, 7, { u: 6, v: 11 });
        // Tables with a cloth.
        for (const [u, v] of [
            [3, 3],
            [10, 10]
        ] as const) {
            c.set("minecraft:oak_fence", u, 1, v);
            c.set("minecraft:white_carpet", u, 2, v);
        }
        rug(c, "orange", 3, 10);
        tile(c, 10, 3);
        // A root cellar, opened from the room.
        cellar(c, 1, 10, 3, 12);
        c.floorPanel(1, 11, "east", { u: 2, level: -2, v: 12, facing: "north" });
        c.spot(3, -3, 12);
    }
};

const FORGE: Template = {
    name: "forge",
    fire: true,
    // Nothing that burns within reach of the lava.
    style: {
        face: "minecraft:stone_bricks",
        floor: "minecraft:smooth_stone",
        entrances: ["panel", "painting"]
    },
    draw(c) {
        // A trough of real lava in the floor; one of its three has a ladder down
        // under it to a cellar. Hiders cross it on fire resistance; a seeker who
        // steps in is sent back to the middle (`secret-panels.burnt`).
        c.set("minecraft:lava", 5, 0, 6, 7, 0, 6);
        c.set("minecraft:ladder[facing=south]", 6, -3, 6, 6, -1, 6);
        c.clear(4, -3, 7, 8, -1, 8);
        c.set("minecraft:sea_lantern", 4, -4, 8);
        // The cellar's other way in: a panel of the floor at its far end from
        // the furnaces, so their keys are well away from it.
        c.floorPanel(4, 8, "east", { u: 5, level: -2, v: 8, facing: "north" });
        c.spot(8, -3, 8);
        c.set("minecraft:iron_bars", 4, 1, 5, 8, 1, 5);
        c.set("minecraft:anvil[facing=east]", 3, 1, 10);
        c.set("minecraft:furnace[facing=south]", 10, 1, 3);
        c.set("minecraft:furnace[facing=south]", 11, 1, 3);
        // On the furnace's front: a block higher, nothing held it up.
        button(c, "minecraft:stone_button", 10, 1, 4, "south");
        button(c, "minecraft:stone_button", 12, 1, 3, "east");
        c.set("minecraft:cobblestone", 10, 1, 10, 11, 2, 11);
        button(c, "minecraft:stone_button", 9, 1, 10, "west");
        gaze(c, "minecraft:jack_o_lantern[facing=north]", 10, 3, 10, { u: 10, v: 6 });
        tile(c, 12, 12);
    }
};

const GARDEN: Template = {
    name: "garden",
    style: {
        face: "minecraft:mossy_stone_bricks",
        floor: "minecraft:grass_block",
        entrances: ["falls", "veil", "painting"]
    },
    draw(c) {
        const leaves = "minecraft:oak_leaves[persistent=true]";
        // A tree: a trunk three across, hollow, a ladder up the middle into a
        // room in its crown. From 1.19.4 one of its logs is a picture of one
        // you walk through; before, the ladder is round the back.
        c.clear(10, 7, 10, 10, 8, 10);
        c.clear(9, 7, 9, 11, 8, 11);
        c.set("minecraft:sea_lantern", 9, 6, 9);
        c.set("minecraft:ladder[facing=north]", 10, 1, 10, 10, 6, 10);
        if (c.era.display) {
            c.display("minecraft:oak_log", 10, 1, 9);
            c.display("minecraft:oak_log", 10, 2, 9);
            c.clear(10, 1, 9, 10, 2, 9);
        } else {
            c.set("minecraft:ladder[facing=east]", 12, 1, 10, 12, 6, 10);
            c.clear(12, 7, 10, 12, 8, 10);
        }
        c.set("minecraft:oak_log", 9, 1, 9, 11, 6, 11);
        c.set(leaves, 7, 7, 7, 13, 9, 13);
        c.spot(9, 7, 9);
        // Hedges to crouch behind.
        c.set(leaves, 2, 1, 3, 5, 2, 3);
        c.set(leaves, 2, 1, 4, 2, 2, 6);
        c.set(leaves, 6, 1, 10, 6, 2, 12);
        c.set("minecraft:poppy", 3, 1, 5);
        c.set("minecraft:dandelion", 4, 1, 5);
        c.set("minecraft:oak_fence", 3, 1, 9);
        gaze(c, "minecraft:jack_o_lantern[facing=east]", 3, 2, 9, { u: 6, v: 8 });
        button(c, "minecraft:oak_button", 8, 1, 10, "west");
        rug(c, "green", 4, 8);
        tile(c, 9, 4);
    }
};

const POND: Template = {
    name: "pond",
    style: {
        face: "minecraft:stone_bricks",
        floor: "minecraft:grass_block",
        entrances: ["painting", "veil", "panel"]
    },
    draw(c) {
        // A pond six deep; a tunnel from its bottom under the floor to a shaft
        // that comes up into a dry cave. Water only ever in still sources, every
        // side of them stone, so it never runs.
        c.set("minecraft:water", 4, -5, 5, 6, 0, 7);
        c.set("minecraft:sea_lantern", 5, -6, 6);
        c.set("minecraft:water", 7, -5, 6, 9, -4, 6);
        c.set("minecraft:water", 10, -5, 6, 10, -3, 6);
        c.clear(9, -2, 5, 11, -1, 7);
        c.set("minecraft:sea_lantern", 11, -3, 7);
        c.spot(9, -2, 5);
        // Flowers round it; from 1.19.4 one patch is over a drop to a hollow.
        for (const [u, v, flower] of [
            [3, 4, "poppy"],
            [7, 4, "dandelion"],
            [3, 8, "cornflower"],
            [7, 8, "azure_bluet"]
        ] as const)
            c.set(`minecraft:${flower}`, u, 1, v);
        if (c.era.display) {
            c.clear(2, -3, 10, 3, -1, 11);
            c.set("minecraft:sea_lantern", 3, -4, 11);
            c.set("minecraft:ladder[facing=east]", 2, -3, 10, 2, 0, 10);
            c.display("minecraft:grass_block", 2, 0, 10);
            c.display("minecraft:poppy", 2, 1, 10);
            c.spot(3, -3, 11);
        }
        c.set("minecraft:oak_log", 10, 1, 10);
        c.set("minecraft:oak_leaves[persistent=true]", 10, 1, 10, 12, 2, 11);
        button(c, "minecraft:oak_button", 9, 1, 10, "west");
        c.set("minecraft:oak_fence", 11, 1, 3);
        gaze(c, "minecraft:jack_o_lantern[facing=west]", 11, 2, 3, { u: 8, v: 3 });
        rug(c, "lime", 2, 2);
        tile(c, 8, 11);
    }
};

const MAZE_WALLS = [
    "minecraft:oak_leaves[persistent=true]",
    "minecraft:stone_bricks",
    "minecraft:bookshelf",
    "minecraft:glass",
    "minecraft:hay_block"
] as const;

const MAZE: Template = {
    name: "maze",
    style: {
        face: "minecraft:spruce_planks",
        floor: "minecraft:spruce_planks",
        entrances: ["painting", "panel"]
    },
    draw(c) {
        // Five by five cells two wide, walls one thick and four high: the
        // doorways line up with its corridors (`SLOTS`).
        const wall = pick(c.random, MAZE_WALLS);
        const dark = c.random() < 0.35;
        const carved = maze.carve(5, c.random);
        const cell = (n: number) => n * 3;
        // Keys in the corridors, away from the dead ends' hatches: two rugs
        // and a lit tile, put down before the corridors are cleared round them.
        const ends = new Set(maze.deadEnds(carved).map(([x, z]) => `${x},${z}`));
        const middles = shuffle(
            c.random,
            Array.from({ length: 25 }, (_, n) => [n % 5, Math.floor(n / 5)] as const).filter(
                ([x, z]) => !ends.has(`${x},${z}`)
            )
        );
        middles.slice(0, 3).forEach(([x, z], n) => {
            if (n === 1) tile(c, cell(x) + 1, cell(z) + 1);
            else rug(c, n === 0 ? "brown" : "gray", cell(x) + 1, cell(z) + 1);
        });
        for (let cz = 0; cz < 5; cz += 1)
            for (let cx = 0; cx < 5; cx += 1) {
                const u = cell(cx);
                const v = cell(cz);
                c.clear(u, 1, v, u + 1, 4, v + 1);
                if (cx < 4 && maze.open(carved, cx, cz, 1, 0))
                    c.clear(u + 2, 1, v, u + 2, 4, v + 1);
                if (cz < 4 && maze.open(carved, cx, cz, 0, 1))
                    c.clear(u, 1, v + 2, u + 1, 4, v + 2);
                if (!dark || (cx + cz) % 2 === 0)
                    c.set("minecraft:sea_lantern", u + (cz % 2), 0, v + (cx % 2));
            }
        // The dead ends hide trapdoors to a hollow under them.
        let hollows = 0;
        for (const [cx, cz] of maze.deadEnds(carved)) {
            if (hollows >= 2 || c.random() < 0.4) continue;
            const u = cell(cx);
            const v = cell(cz);
            if (!c.free(u, 0, v) || !c.free(u + 1, 0, v + 1)) continue;
            c.clear(u, -3, v, u + 1, -1, v + 1);
            c.set("minecraft:sea_lantern", u + 1, -4, v + 1);
            hatch(c, "spruce", u, v, "south");
            c.spot(u + 1, -3, v + 1);
            hollows += 1;
        }
        c.set(wall, 0, 1, 0, LAST, 4, LAST);
        // Above the maze, lamps under the roof.
        for (const at of [2, 7, 11]) c.set("minecraft:sea_lantern", at, 10, at);
        for (const [u, v] of [
            [2, 0],
            [11, 13]
        ] as const)
            if (c.free(u, 2, v)) c.set("minecraft:sea_lantern", u, 0, v);
    }
};

const GALLERY: Template = {
    name: "gallery",
    style: {
        face: "minecraft:quartz_block",
        floor: "minecraft:dark_oak_planks",
        entrances: ["painting", "veil", "panel"]
    },
    draw(c) {
        // A balcony along a side with no doorway, steps up to it at one end and
        // crates to hide behind on it and under it.
        const side = (["north", "south"] as const).find((one) => !hasDoor(c, one));
        if (side) {
            const v1 = side === "north" ? 0 : LAST - 2;
            const v2 = v1 + 2;
            const row = side === "north" ? v1 : v2;
            const edge = side === "north" ? v2 : v1;
            const front = edge + (side === "north" ? 1 : -1);
            const crate = c.era.scaffold
                ? "minecraft:barrel[facing=up]"
                : "minecraft:spruce_planks";
            // Steps: a block a level along the balcony's front, up to a gap in
            // its railing.
            for (let step = 1; step <= 3; step += 1)
                c.set("minecraft:dark_oak_planks", 1 + step, 1, front, 1 + step, step, front);
            c.clear(1, 1, front, 5, 6, front);
            c.clear(4, 5, edge, 4, 6, edge);
            c.set("minecraft:birch_planks", 0, 4, v1, LAST, 4, v2);
            c.set("minecraft:sea_lantern", 6, 4, row);
            c.set("minecraft:dark_oak_fence", 0, 5, edge, LAST, 5, edge);
            c.set(crate, 9, 5, row, 10, 6, row);
            c.set(crate, 10, 1, row, 11, 2, row);
            c.spot(11, 5, row);
        }
        // Statues to look at, on plinths down the middle.
        for (const [u, v, rotation] of [
            [4, 7, 4],
            [9, 6, 12]
        ] as const) {
            c.set("minecraft:quartz_pillar", u, 1, v, u, 2, v);
            gaze(c, `minecraft:skeleton_skull[rotation=${rotation}]`, u, 3, v, {
                u,
                v: v + (v === 7 ? 3 : -3)
            });
            button(c, "minecraft:stone_button", u - 1, 1, v, "west");
        }
        rug(c, "purple", 6, 9);
        tile(c, 7, 4);
    }
};

const WORKSHOP: Template = {
    name: "workshop",
    style: {
        face: "minecraft:spruce_planks",
        floor: "minecraft:oak_planks",
        entrances: ["panel", "door", "painting"]
    },
    draw(c) {
        const crate = c.era.scaffold ? "minecraft:barrel[facing=up]" : "minecraft:spruce_planks";
        // Three stacks of crates three across and three high, all alike; from
        // 1.19.4 one is hollow, its way in a crate you walk through.
        const stacks = [
            [2, 2],
            [9, 2],
            [2, 9]
        ] as const;
        const hollow = c.era.display ? Math.floor(c.random() * stacks.length) : -1;
        stacks.forEach(([u, v], index) => {
            if (index === hollow) {
                c.clear(u + 1, 1, v + 1, u + 1, 2, v + 1);
                c.clear(u + 1, 1, v + 2, u + 1, 2, v + 2);
                c.display(crate, u + 1, 1, v + 2);
                c.display(crate, u + 1, 2, v + 2);
                c.set("minecraft:sea_lantern", u + 1, 0, v + 1);
                c.spot(u + 1, 1, v + 1);
            }
            c.set(crate, u, 1, v, u + 2, 3, v + 2);
        });
        button(c, "minecraft:oak_button", 5, 1, 3, "east");
        // A tower up to a shelf under the roof: scaffolding from 1.14, a ladder
        // before, on a post against the wall - or on the room's side of the
        // ladder where a nook or a door in that wall keeps the floor in front
        // of it clear, which left the lowest rungs hanging on nothing.
        const post = c.free(13, 1, 11) && c.free(13, 2, 11) ? 13 : 11;
        const climb = c.era.scaffold
            ? "minecraft:scaffolding[distance=0,bottom=false]"
            : `minecraft:ladder[facing=${post === 13 ? "west" : "east"}]`;
        c.set(climb, 12, 1, 11, 12, 8, 11);
        c.set("minecraft:spruce_log", post, 1, 11, post, 7, 11);
        c.set("minecraft:birch_planks", 12, 8, 7, 13, 8, 10);
        c.set("minecraft:birch_planks", 13, 8, 11);
        c.set("minecraft:birch_planks", post, 8, 11);
        c.set("minecraft:sea_lantern", 13, 8, 8);
        c.set(crate, 13, 9, 9, 13, 9, 9);
        c.spot(12, 9, 8);
        c.set("minecraft:crafting_table", 7, 1, 10);
        c.set("minecraft:anvil[facing=north]", 9, 1, 10);
        gaze(c, "minecraft:jack_o_lantern[facing=south]", 8, 1, 10, { u: 8, v: 6 });
        rug(c, "brown", 6, 6);
        tile(c, 10, 7);
    }
};

const BEDROOM: Template = {
    name: "bedroom",
    style: {
        face: "minecraft:birch_planks",
        floor: "minecraft:oak_planks",
        entrances: ["door", "painting", "veil"]
    },
    draw(c) {
        // Three wardrobes, three across, two deep and three high, all alike: a
        // door in the front, and behind it room for one - or, in one of them,
        // its back.
        const wardrobes = [
            [2, 2],
            [7, 2],
            [2, 10]
        ] as const;
        const solid = c.design >= CLOSETS_SINCE ? -1 : Math.floor(c.random() * wardrobes.length);
        wardrobes.forEach(([u, v], index) => {
            c.set(
                "minecraft:oak_door[facing=south,half=lower,hinge=left,open=false]",
                u + 1,
                1,
                v + 1
            );
            c.set(
                "minecraft:oak_door[facing=south,half=upper,hinge=left,open=false]",
                u + 1,
                2,
                v + 1
            );
            if (index !== solid) {
                c.clear(u + 1, 1, v, u + 1, 2, v);
                c.spot(u + 1, 1, v);
            }
            c.set("minecraft:oak_planks", u, 1, v, u + 2, 3, v + 1);
        });
        for (const [u, v] of [
            [10, 8],
            [12, 8]
        ] as const) {
            if (c.design >= BEDLESS_SINCE) {
                // A bed's look without a bed: a frame, a red cover and a
                // white pillow. Nothing here sets a spawn point.
                c.set("minecraft:white_carpet", u, 2, v + 1);
                c.set("minecraft:red_carpet", u, 2, v);
                c.set("minecraft:oak_slab[type=top]", u, 1, v, u, 1, v + 1);
                continue;
            }
            c.set("minecraft:red_bed[facing=south,part=head,occupied=false]", u, 1, v + 1);
            c.set("minecraft:red_bed[facing=south,part=foot,occupied=false]", u, 1, v);
        }
        button(c, "minecraft:oak_button", 5, 2, 3, "east");
        gaze(c, "minecraft:jack_o_lantern[facing=west]", 13, 2, 5, { u: 9, v: 5 });
        rug(c, "light_blue", 7, 7);
        tile(c, 6, 11);
    }
};

const SNOW: Template = {
    name: "snow",
    fits: (era) => era.snow,
    style: {
        face: "minecraft:snow_block",
        floor: "minecraft:snow_block",
        entrances: ["panel", "painting"]
    },
    draw(c) {
        // A hollow under the snow, in and out through a panel of the floor.
        // Never powder snow: a player who sinks into it is held there, slowed
        // and freezing, and in a match that reads as stuck in the floor.
        c.clear(8, -2, 8, 10, -1, 10);
        c.set("minecraft:sea_lantern", 10, -3, 10);
        c.floorPanel(10, 8, "west", { u: 9, level: -2, v: 8, facing: "south" }, -2);
        c.spot(8, -2, 10);
        for (const [u, v] of [
            [2, 7],
            [11, 2]
        ] as const)
            c.set("minecraft:packed_ice", u, 1, v, u, 3, v);
        button(c, "minecraft:stone_button", 3, 2, 7, "east");
        c.set("minecraft:spruce_fence", 7, 1, 12);
        gaze(c, "minecraft:jack_o_lantern[facing=north]", 7, 2, 12, { u: 7, v: 8 });
        rug(c, "white", 6, 2);
        tile(c, 2, 11);
    }
};

/**
 * A tall hall built to climb (design 5): everything in it is seen from the
 * door and has to be reached.
 *
 * - a launch pad in the floor beside a ledge under the roof in one corner,
 *   with crates on it to crouch behind;
 * - two runs of posts, each a block higher than the last with a gap of one
 *   between, up to a crow's nest in each of the two far corners - a jump a
 *   player makes, never a step (`seek-grid.walk`'s jumps);
 * - a trapdoor into a cellar in the last corner.
 *
 * The posts run two blocks in from the walls, clear of every doorway's
 * landing, and the nests and the ledge are over the doorways' height.
 */
export const ATRIUM_SINCE = 5;

/**
 * From design 6 no room has a bed: a bed sets the spawn point of whoever
 * sleeps in or clicks it, so after the event a player could be sent back to a
 * house that is gone. The bedroom builds a look-alike instead.
 */
export const BEDLESS_SINCE = 6;

/**
 * From design 7 no door opens onto a wall: every wardrobe is hollow, and a
 * door hung on a room's solid wall (`seek-manor.ts`) has a closet behind it.
 * The themed rooms, the lofts with secret doors and the set dressing come in
 * with it.
 */
export const CLOSETS_SINCE = 7;

const ATRIUM: Template = {
    name: "atrium",
    since: ATRIUM_SINCE,
    style: {
        face: "minecraft:polished_andesite",
        floor: "minecraft:smooth_stone",
        entrances: ["panel", "painting", "door"]
    },
    draw(c) {
        const deck = "minecraft:spruce_planks";
        const crate = c.era.scaffold ? "minecraft:barrel[facing=up]" : "minecraft:oak_planks";
        const post = "minecraft:stone_bricks";
        // The ledge in the north-west corner, and the pad that throws you up
        // beside it.
        c.set(deck, 0, 5, 0, 3, 5, 2);
        c.set(crate, 0, 6, 2, 1, 7, 2);
        c.spot(0, 6, 0);
        c.pad(2, 3);
        // Posts along the south side up to a nest in the south-east corner...
        for (const [step, u] of [3, 5, 7, 9].entries()) c.set(post, u, 1, 11, u, step + 1, 11);
        c.set(deck, 11, 5, 11, 13, 5, 13);
        c.set(crate, 12, 6, 11, 13, 7, 11);
        c.spot(13, 6, 12);
        // ...and along the east side up to one in the north-east corner.
        for (const [step, v] of [9, 7, 5, 3].entries()) c.set(post, 11, 1, v, 11, step + 1, v);
        c.set(deck, 11, 5, 0, 13, 5, 1);
        c.set(crate, 12, 6, 1, 13, 7, 1);
        c.spot(13, 6, 0);
        // A cellar under a trapdoor in the south-west corner.
        cellar(c, 1, 10, 3, 12);
        hatch(c, "oak", 1, 11, "east");
        c.spot(3, -3, 12);
        rug(c, "cyan", 5, 7);
        tile(c, 7, 4);
    }
};

// ------------------------------------------------------------------ design 7

/**
 * The themed rooms (design 7). Each keeps the house's rules: a way out of
 * every hiding place, nothing that traps or hurts, no bed, light everywhere
 * anybody stands, and only what the server can show. Several hide a place
 * inside another: a cellar under a hut, a room behind a frame with a hatch in
 * its floor, a chamber reached through a secret door high in a tower.
 */

/** A ruined nether hut with a cellar under its floor panel, outcrops of
 *  netherrack and glowstone, and fence posts topped with skulls. */
const NETHER: Template = {
    name: "nether",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:nether_bricks",
        floor: "minecraft:red_nether_bricks",
        entrances: ["panel", "painting"]
    },
    draw(c) {
        // The hut: three by three inside, its way in on the south side.
        c.clear(3, 1, 3, 5, 3, 5);
        c.clear(4, 1, 6, 4, 2, 6);
        c.set("minecraft:glowstone", 4, 4, 4);
        c.spot(5, 1, 3);
        // Under it, through a panel of its floor: the cellar, and the button
        // to get back out.
        cellar(c, 3, 3, 5, 5);
        c.floorPanel(3, 3, "south", { u: 4, level: -2, v: 3, facing: "south" });
        c.spot(5, -3, 5);
        c.set("minecraft:nether_bricks", 2, 1, 2, 6, 4, 6);
        // Outcrops to crouch behind, lit through glowstone.
        c.set("minecraft:netherrack", 9, 1, 3, 11, 2, 4);
        c.set("minecraft:glowstone", 10, 3, 3);
        c.set("minecraft:netherrack", 3, 1, 10, 4, 2, 11);
        c.set("minecraft:nether_wart_block", 9, 1, 9, 10, 3, 10);
        c.set("minecraft:nether_brick_fence", 11, 1, 11);
        gaze(c, "minecraft:wither_skeleton_skull[rotation=8]", 11, 2, 11, { u: 11, v: 7 });
        button(c, "minecraft:stone_button", 8, 1, 9, "west");
        rug(c, "red", 7, 4);
        tile(c, 7, 11);
    }
};

/**
 * A deep dark ruin (from 1.19.4): sculk underfoot, a frame of reinforced
 * deepslate on a side with no doorway whose middle is only a picture of
 * deepslate - walked through, a room behind with a hatch to a hollow under
 * it - and spore blossoms and dripstone under the ceiling.
 */
const DEEP: Template = {
    name: "deep",
    since: CLOSETS_SINCE,
    fits: (era) => era.display,
    style: {
        face: "minecraft:cobblestone",
        floor: "minecraft:polished_andesite",
        entrances: ["veil", "panel", "painting"]
    },
    draw(c) {
        const side = (["south", "north"] as const).find((one) => !hasDoor(c, one));
        if (side) {
            // In the south's terms; turned round for the north.
            const v = (at: number) => (side === "south" ? at : LAST - at);
            c.clear(5, 1, v(11), 8, 3, v(12));
            c.clear(6, 1, v(10), 7, 2, v(10));
            for (const [u, level] of [
                [6, 1],
                [7, 1],
                [6, 2],
                [7, 2]
            ] as const)
                c.display("minecraft:deepslate_tiles", u, level, v(10));
            c.set("minecraft:sea_lantern", 8, 0, v(12));
            c.spot(8, 1, v(11));
            // A hatch in the hidden room's floor, to a hollow under it.
            cellar(c, 5, Math.min(v(11), v(12)), 6, Math.max(v(11), v(12)));
            hatch(c, "dark_oak", 5, v(11), side);
            c.spot(6, -3, v(12));
            c.set("minecraft:reinforced_deepslate", 4, 1, v(10), 9, 4, v(10));
            c.set("minecraft:deepslate_tiles", 4, 1, v(11), 9, 4, v(13));
        }
        // Sculk underfoot, set before the floor.
        for (const [u, at] of [
            [2, 2],
            [3, 2],
            [2, 3],
            [10, 4],
            [11, 4],
            [11, 5],
            [6, 6],
            [7, 7]
        ] as const)
            c.set("minecraft:sculk", u, 0, at);
        // Pillars of deepslate with a skull to stare at.
        c.set("minecraft:deepslate_tiles", 2, 1, 7, 2, 3, 7);
        gaze(c, "minecraft:skeleton_skull[rotation=4]", 2, 4, 7, { u: 6, v: 7 });
        c.set("minecraft:deepslate_tiles", 11, 1, 8, 11, 2, 8);
        button(c, "minecraft:stone_button", 10, 1, 8, "west");
        // Set dressing under the ceiling: dust that floats down, and drips.
        c.set("minecraft:spore_blossom", 7, 10, 3);
        c.set("minecraft:spore_blossom", 4, 10, 9);
        c.set("minecraft:pointed_dripstone[vertical_direction=down,thickness=tip]", 11, 10, 11);
        c.set("minecraft:pointed_dripstone[vertical_direction=down,thickness=tip]", 2, 10, 5);
        rug(c, "gray", 9, 6);
        tile(c, 5, 3);
    }
};

/**
 * An end island: a tower of purpur with a ladder inside up to a hatch onto
 * its roof, behind iron bars; a cellar under a panel of its floor; pillars of
 * purpur and a dragon's head to stare at.
 */
const END: Template = {
    name: "end",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:end_stone_bricks",
        floor: "minecraft:end_stone",
        entrances: ["panel", "painting", "veil"]
    },
    draw(c) {
        // The tower, eight to eleven across and two to five deep, its way in
        // on the south side.
        c.clear(9, 1, 3, 10, 6, 4);
        c.clear(9, 1, 5, 9, 2, 5);
        c.set("minecraft:ladder[facing=south]", 10, 1, 3, 10, 6, 3);
        c.set("minecraft:birch_trapdoor[facing=south,half=top,open=false]", 10, 7, 3);
        c.set("minecraft:sea_lantern", 10, 0, 4);
        // Under the tower, through a panel of its floor.
        cellar(c, 9, 4, 11, 6);
        c.floorPanel(9, 4, "south", { u: 10, level: -2, v: 4, facing: "south" });
        c.spot(11, -3, 6);
        c.set("minecraft:purpur_block", 8, 1, 2, 11, 7, 5);
        // On its roof, behind bars: somewhere to lie low under the lamps.
        for (let u = 8; u <= 11; u += 1)
            for (let at = 2; at <= 5; at += 1)
                if (u === 8 || u === 11 || at === 2 || at === 5)
                    c.set("minecraft:iron_bars", u, 8, at);
        c.spot(9, 8, 4);
        // Pillars, and a dragon's head on one.
        for (const [u, at] of [
            [3, 3],
            [3, 10],
            [10, 10]
        ] as const)
            c.set("minecraft:purpur_pillar", u, 1, at, u, 2, at);
        gaze(c, "minecraft:dragon_head[rotation=0]", 3, 3, 10, { u: 3, v: 6 });
        button(c, "minecraft:stone_button", 2, 1, 3, "west");
        c.set("minecraft:obsidian", 6, 1, 8, 7, 1, 9);
        rug(c, "purple", 6, 11);
        tile(c, 5, 6);
    }
};

/**
 * A bell tower (from 1.14, the bell's release): a stone tower in the middle
 * with a hatch to a cellar at its foot and a ladder up to the bell. High in
 * its east wall is a secret door to a chamber only it reaches, opened by a key
 * across the room and by a button inside to get back out.
 */
const BELFRY: Template = {
    name: "belfry",
    since: CLOSETS_SINCE,
    fits: (era) => era.scaffold,
    style: {
        face: "minecraft:stone_bricks",
        floor: "minecraft:polished_andesite",
        entrances: ["painting", "panel", "door"]
    },
    draw(c) {
        // The tower: four to nine either way, its way in on the north.
        c.set("minecraft:bell[attachment=floor,facing=north]", 6, 7, 6);
        c.clear(5, 1, 5, 8, 5, 8);
        c.clear(5, 7, 5, 8, 9, 8);
        c.clear(6, 1, 4, 7, 2, 4);
        c.set("minecraft:ladder[facing=north]", 6, 1, 8, 6, 6, 8);
        c.set("minecraft:sea_lantern", 8, 6, 5);
        c.set("minecraft:sea_lantern", 8, 0, 7);
        c.set("minecraft:spruce_planks", 5, 6, 5, 8, 6, 8);
        c.spot(5, 7, 8);
        // Openings at the top, on its north and west faces.
        c.clear(6, 8, 4, 7, 8, 4);
        c.clear(4, 8, 6, 4, 8, 7);
        // The chamber, out of sight east of the tower, and its secret door.
        c.clear(10, 7, 6, 12, 8, 7);
        c.set("minecraft:sea_lantern", 12, 6, 7);
        if (c.wallPanel(9, 7, 6, "east", { u: 10, level: 8, v: 7, facing: "east" }))
            c.spot(11, 7, 6);
        c.set("minecraft:stone_bricks", 10, 6, 5, 13, 9, 8);
        // A hatch at the tower's foot, to a cellar under it.
        cellar(c, 5, 5, 7, 7);
        hatch(c, "spruce", 5, 5, "south");
        c.spot(7, -3, 7);
        c.set("minecraft:stone_bricks", 4, 1, 4, 9, 9, 9);
        // Round it: a bench, a post with a head, a rug and a tile.
        c.set("minecraft:spruce_planks", 1, 1, 11, 3, 1, 11);
        button(c, "minecraft:oak_button", 1, 1, 12, "south");
        c.set("minecraft:oak_fence", 2, 1, 2);
        gaze(c, "minecraft:skeleton_skull[rotation=0]", 2, 2, 2, { u: 2, v: 5 });
        rug(c, "blue", 11, 11);
        tile(c, 12, 12);
    }
};

/**
 * A village under one roof: two little houses - one hung with a curtain, one
 * with a door, each a place to hide and the first with a hatch to a cellar -
 * a well whose shaft goes on down into a dry cave, hay bales and a lamp post.
 */
const VILLAGE: Template = {
    name: "village",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:oak_planks",
        floor: "minecraft:grass_block",
        entrances: ["door", "painting", "panel"]
    },
    draw(c) {
        // The first house, its way in behind a painting on banners.
        curtain(c, "red", 4, 6);
        c.clear(3, 1, 3, 5, 3, 5);
        c.set("minecraft:glowstone", 4, 4, 4);
        c.spot(5, 1, 3);
        if (c.design < PAINTED_SINCE) {
            cellar(c, 3, 3, 5, 5);
            hatch(c, "spruce", 3, 3, "south");
            c.spot(5, -3, 5);
        }
        c.set("minecraft:spruce_planks", 2, 1, 2, 6, 4, 6);
        // The second, with a door.
        c.clear(8, 1, 9, 10, 3, 11);
        c.set("minecraft:oak_door[facing=north,half=lower,hinge=left,open=false]", 9, 1, 8);
        c.set("minecraft:oak_door[facing=north,half=upper,hinge=left,open=false]", 9, 2, 8);
        c.set("minecraft:glowstone", 9, 4, 10);
        c.spot(10, 1, 11);
        c.set("minecraft:birch_planks", 7, 1, 8, 11, 4, 12);
        // The well: its water up to the top of its rim, so whoever comes up
        // steps out onto the rim; down its shaft, along a tunnel two high
        // under the floor - room to swim - and up into a cave.
        c.set("minecraft:water", 3, -5, 10, 3, 1, 10);
        c.set("minecraft:water", 4, -5, 10, 5, -4, 10);
        c.set("minecraft:water", 6, -5, 10, 6, -3, 10);
        c.set("minecraft:sea_lantern", 3, -6, 10);
        c.clear(5, -2, 9, 7, -1, 11);
        c.set("minecraft:sea_lantern", 7, -3, 11);
        c.spot(5, -2, 9);
        c.set("minecraft:cobblestone", 2, 1, 9, 4, 1, 11);
        // Hay, a lamp post, a pumpkin to stare at.
        c.set("minecraft:hay_block", 11, 1, 2, 12, 2, 3);
        c.set("minecraft:oak_fence", 7, 1, 2, 7, 2, 2);
        c.set("minecraft:sea_lantern", 7, 3, 2);
        c.set("minecraft:hay_block", 12, 1, 6);
        gaze(c, "minecraft:jack_o_lantern[facing=west]", 12, 2, 6, { u: 8, v: 6 });
        button(c, "minecraft:oak_button", 10, 1, 3, "west");
        rug(c, "green", 1, 7);
        tile(c, 6, 12);
    }
};
// ------------------------------------------------------------------ design 8

/** From design 8 the house can have an aquarium (`AQUARIUM`). */
export const AQUARIUM_SINCE = 8;

/**
 * From design 9 a little house's way in (the village's, the diving bell's, the
 * huts') is a painting over banners, as a nook's painting is, and the house is
 * one hiding place, with no cellar under it: a gap hung with a banner alone
 * stood open, and a hatch inside a house nobody could see into was a hiding
 * place inside a hiding place.
 */
export const PAINTED_SINCE = 9;

/** Where a cell of a wall's tank is: `along` the side, `depth` in from it. */
function onSide(side: Side, along: number, depth: number): [number, number] {
    if (side === "north") return [along, depth];
    if (side === "south") return [along, LAST - depth];
    if (side === "west") return [depth, along];
    return [LAST - depth, along];
}

const CORALS = ["tube", "brain", "bubble", "fire", "horn"] as const;

/**
 * Fish tanks along a room's walls: a back of dark prismarine, a row of water
 * one deep and four high on a bed of coral a block up, with kelp and sea
 * pickles in it, glass in front and at both ends, and a lid with lamps in it.
 * The water starts over anybody's feet, so nothing in the tank reads as a
 * place to stand that nobody can get to. Only where
 * every block of a stretch is still free - never across a doorway, a nook or
 * anything else - so the water is sealed in on every side by blocks of the
 * tank's own, and nobody ever walks in it.
 */
function tanks(c: Canvas): void {
    for (const side of SIDES) {
        const fits = (along: number) => {
            for (let depth = 0; depth <= 2; depth += 1)
                for (let level = 0; level <= 6; level += 1) {
                    const [u, v] = onSide(side, along, depth);
                    if (!c.free(u, level, v)) return false;
                }
            return true;
        };
        // Stretches of at least three, clear of the corners: a way stays open
        // into each, past the ends of the tanks either side of it.
        const runs: [number, number][] = [];
        for (let along = 4; along <= 9; along += 1) {
            if (!fits(along)) continue;
            const last = runs[runs.length - 1];
            if (last && last[1] === along - 1) last[1] = along;
            else runs.push([along, along]);
        }
        for (const [a, b] of runs) {
            if (b - a < 2) continue;
            for (let along = a; along <= b; along += 1) {
                const end = along === a || along === b;
                const [bu, bv] = onSide(side, along, 0);
                const [wu, wv] = onSide(side, along, 1);
                const [gu, gv] = onSide(side, along, 2);
                c.set("minecraft:dark_prismarine", bu, 0, bv, bu, 6, bv);
                c.set("minecraft:dark_prismarine", wu, 0, wv);
                c.set("minecraft:glass", gu, 1, gv, gu, 5, gv);
                c.set("minecraft:prismarine_bricks", gu, 0, gv);
                c.set("minecraft:prismarine_bricks", gu, 6, gv);
                if (end) {
                    c.set("minecraft:glass", wu, 2, wv, wu, 5, wv);
                    c.set("minecraft:prismarine", wu, 1, wv);
                    c.set("minecraft:prismarine", wu, 6, wv);
                    continue;
                }
                c.set(`minecraft:${CORALS[along % CORALS.length]}_coral_block`, wu, 1, wv);
                c.set(
                    along % 2 === 0 ? "minecraft:sea_lantern" : "minecraft:prismarine",
                    wu,
                    6,
                    wv
                );
                if (along % 3 === 0) c.set("minecraft:kelp[age=25]", wu, 2, wv);
                if (along % 3 === 1)
                    c.set("minecraft:sea_pickle[pickles=3,waterlogged=true]", wu, 2, wv);
                c.set("minecraft:water", wu, 2, wv, wu, 5, wv);
            }
            const [fu, fv] = onSide(side, Math.floor((a + b) / 2), 1);
            c.fish(fu, 3, fv);
        }
    }
}

/**
 * An aquarium (design 8): fish tanks along its walls behind glass, a floor of
 * prismarine and a ceiling of it set with lamps, and in the middle a diving
 * bell of prismarine bricks with portholes - room for one inside, a cellar
 * under a hatch in its floor - beside a lamp on a pillar to stare at.
 */
const AQUARIUM: Template = {
    name: "aquarium",
    since: AQUARIUM_SINCE,
    style: {
        face: "minecraft:quartz_block",
        floor: "minecraft:prismarine_bricks",
        entrances: ["painting", "veil", "panel"]
    },
    draw(c) {
        // The diving bell, its way in on the south side behind a painting.
        curtain(c, "cyan", 7, 8);
        c.clear(6, 1, 5, 8, 3, 7);
        c.set("minecraft:sea_lantern", 7, 4, 6);
        c.spot(8, 1, 5);
        if (c.design < PAINTED_SINCE) {
            cellar(c, 6, 5, 8, 7);
            hatch(c, "spruce", 6, 5, "south");
            c.spot(8, -3, 7);
        }
        c.set("minecraft:glass", 5, 2, 6);
        c.set("minecraft:glass", 9, 2, 6);
        c.set("minecraft:prismarine_bricks", 5, 1, 4, 9, 4, 8);
        button(c, "minecraft:stone_button", 4, 2, 5, "west");
        button(c, "minecraft:stone_button", 10, 2, 5, "east");
        c.set("minecraft:prismarine_bricks", 3, 1, 6, 3, 2, 6);
        gaze(c, "minecraft:sea_lantern", 3, 3, 6, { u: 3, v: 10 });
        rug(c, "cyan", 3, 9);
        tile(c, 4, 3);
        tanks(c);
        // The ceiling: prismarine set with lamps, under the house's roof.
        for (let u = 0; u <= LAST; u += 1)
            for (let v = 0; v <= LAST; v += 1)
                c.set(
                    u % 3 === 1 && v % 3 === 1 ? "minecraft:sea_lantern" : "minecraft:prismarine",
                    u,
                    10,
                    v
                );
    }
};

/** Every template but the foyer, which is only ever the middle room. */
export const TEMPLATES: readonly Template[] = [
    LIBRARY,
    KITCHEN,
    FORGE,
    GARDEN,
    POND,
    MAZE,
    GALLERY,
    WORKSHOP,
    BEDROOM,
    SNOW,
    ATRIUM,
    NETHER,
    DEEP,
    END,
    BELFRY,
    VILLAGE,
    AQUARIUM
];

// ------------------------------------------------------------------ the seasons

/**
 * Rooms only a house built in their season draws (`seek-manor.drawManor`):
 * the season is the one the server is dressed for (`seasonal.ts`), read once
 * when the run's house is built and kept with it. Each keeps every rule the
 * others do - a hiding place or more, keys to find, light everywhere anybody
 * stands - and nothing in them falls, burns or holds a player: no powder
 * snow, no sand or gravel, and the one fire, the cabin's hearth, behind bars
 * with nothing that burns within reach.
 */

/** A wardrobe three across, two deep and three high, with a door in its
 *  front and room for one behind it, as the bedroom's. */
function wardrobe(c: Canvas, block: string, door: string, u: number, v: number): void {
    c.set(`minecraft:${door}_door[facing=south,half=lower,hinge=left,open=false]`, u + 1, 1, v + 1);
    c.set(`minecraft:${door}_door[facing=south,half=upper,hinge=left,open=false]`, u + 1, 2, v + 1);
    c.clear(u + 1, 1, v, u + 1, 2, v);
    c.spot(u + 1, 1, v);
    c.set(block, u, 1, v, u + 2, 3, v + 1);
}

/** A hut five by five, its way in on the south side behind a painting on
 *  banners, as the village's first house (up to design 8 a banner alone, and
 *  a cellar under a hatch in its floor). */
function hut(c: Canvas, u: number, walls: string, banner: string): void {
    curtain(c, banner, u + 2, 6);
    c.clear(u + 1, 1, 3, u + 3, 3, 5);
    c.set("minecraft:glowstone", u + 2, 4, 4);
    c.spot(u + 3, 1, 3);
    if (c.design < PAINTED_SINCE) {
        cellar(c, u + 1, 3, u + 3, 5);
        hatch(c, "spruce", u + 1, 3, "south");
        c.spot(u + 3, -3, 5);
    }
    c.set(walls, u, 1, 2, u + 4, 4, 6);
}

/** A shed with a door on its north side and room inside, as the village's
 *  second house. */
function shed(c: Canvas, walls: string, door: string): void {
    c.clear(8, 1, 9, 10, 3, 11);
    c.set(`minecraft:${door}_door[facing=north,half=lower,hinge=left,open=false]`, 9, 1, 8);
    c.set(`minecraft:${door}_door[facing=north,half=upper,hinge=left,open=false]`, 9, 2, 8);
    c.set("minecraft:glowstone", 9, 4, 10);
    c.spot(10, 1, 11);
    c.set(walls, 7, 1, 8, 11, 4, 12);
}

/** A haunted parlour: webs in every corner under the ceiling, two tall
 *  clocks with room inside, pumpkins on posts and a cellar under a hatch. */
const PARLOUR: Template = {
    name: "parlour",
    season: "halloween",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:dark_oak_planks",
        floor: "minecraft:dark_oak_planks",
        entrances: ["door", "painting", "panel"]
    },
    draw(c) {
        // Webs in the corners, up under the ceiling where nobody walks into one.
        for (const u of [0, LAST])
            for (const v of [0, LAST]) {
                c.set("minecraft:cobweb", u, 9, v, u, 10, v);
                c.set("minecraft:cobweb", u === 0 ? 1 : LAST - 1, 10, v);
                c.set("minecraft:cobweb", u, 10, v === 0 ? 1 : LAST - 1);
            }
        wardrobe(c, "minecraft:dark_oak_planks", "dark_oak", 2, 2);
        wardrobe(c, "minecraft:dark_oak_planks", "dark_oak", 2, 10);
        button(c, "minecraft:dark_oak_button", 5, 2, 3, "east");
        button(c, "minecraft:dark_oak_button", 5, 2, 10, "east");
        // A table with a pumpkin lantern on it, and pumpkins on posts.
        c.set("minecraft:dark_oak_fence", 7, 1, 6);
        gaze(c, "minecraft:jack_o_lantern[facing=south]", 7, 2, 6, { u: 7, v: 10 });
        c.set("minecraft:dark_oak_fence", 11, 1, 2);
        c.set("minecraft:carved_pumpkin[facing=south]", 11, 2, 2);
        c.set("minecraft:dark_oak_fence", 11, 1, 7);
        gaze(c, "minecraft:skeleton_skull[rotation=4]", 11, 2, 7, { u: 7, v: 8 });
        // A cellar under a trapdoor in the dark floor, as the library's.
        cellar(c, 11, 10, 12, 12);
        hatch(c, "dark_oak", 11, 11, "east");
        c.spot(12, -3, 12);
        rug(c, "black", 7, 8);
        tile(c, 10, 6);
    }
};

/** A witch's den: her hut with purple glass in its windows and a cellar
 *  under it, cauldrons and brewing stands, and a larder with a door. */
const WITCH: Template = {
    name: "witch",
    season: "halloween",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:mossy_stone_bricks",
        floor: "minecraft:podzol",
        entrances: ["panel", "painting", "door"]
    },
    draw(c) {
        for (const [u, v] of [
            [2, 4],
            [6, 4],
            [4, 2]
        ] as const)
            c.set("minecraft:purple_stained_glass", u, 2, v);
        hut(c, 2, "minecraft:spruce_planks", "purple");
        button(c, "minecraft:oak_button", 7, 2, 3, "east");
        // Her brewing: a row of cauldrons and a stand, and one more by the larder.
        c.set("minecraft:cauldron", 9, 1, 3, 10, 1, 3);
        c.set("minecraft:brewing_stand", 11, 1, 3);
        c.set("minecraft:cauldron", 12, 1, 7);
        shed(c, "minecraft:mossy_cobblestone", "spruce");
        button(c, "minecraft:stone_button", 12, 1, 10, "east");
        c.set("minecraft:oak_fence", 8, 1, 2);
        gaze(c, "minecraft:jack_o_lantern[facing=south]", 8, 2, 2, { u: 8, v: 6 });
        rug(c, "purple", 9, 6);
        tile(c, 5, 11);
    }
};

/** A pumpkin patch over a root cellar: rows of pumpkins, a scarecrow to
 *  stare at, a haystack with a door, and the cellar under a hatch. */
const PUMPKINS: Template = {
    name: "pumpkins",
    season: "halloween",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:spruce_planks",
        floor: "minecraft:coarse_dirt",
        entrances: ["door", "panel", "painting"]
    },
    draw(c) {
        // The root cellar, four by four, its ladder under a hatch.
        cellar(c, 2, 9, 5, 12);
        hatch(c, "spruce", 2, 10, "east");
        c.spot(5, -3, 12);
        c.spot(5, -3, 9);
        // The patch.
        for (const [u, v] of [
            [7, 3],
            [9, 2],
            [11, 3],
            [8, 5],
            [10, 5]
        ] as const)
            c.set("minecraft:pumpkin", u, 1, v);
        c.set("minecraft:carved_pumpkin[facing=south]", 3, 1, 3);
        c.set("minecraft:pumpkin", 2, 1, 4);
        button(c, "minecraft:stone_button", 4, 1, 3, "east");
        // The scarecrow: a post, a body of hay, arms and a carved head.
        c.set("minecraft:oak_fence", 5, 1, 6, 5, 2, 6);
        c.set("minecraft:oak_fence", 5, 3, 5);
        c.set("minecraft:oak_fence", 5, 3, 7);
        gaze(c, "minecraft:carved_pumpkin[facing=east]", 5, 4, 6, { u: 9, v: 6 });
        c.set("minecraft:hay_block", 5, 3, 6);
        shed(c, "minecraft:hay_block", "spruce");
        button(c, "minecraft:oak_button", 12, 1, 10, "east");
        rug(c, "orange", 3, 6);
        tile(c, 11, 7);
    }
};

/** A room of presents round a decorated tree: lights in its branches, room
 *  to crouch under it, wrapped boxes, two big enough to hide in. */
const PRESENTS: Template = {
    name: "presents",
    season: "winter",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:white_wool",
        floor: "minecraft:spruce_planks",
        entrances: ["door", "painting", "veil"]
    },
    draw(c) {
        // The lights, then the trunk and the star, then the branches round them.
        for (const [u, level, v, light] of [
            [4, 3, 6, "glowstone"],
            [8, 3, 6, "sea_lantern"],
            [6, 3, 4, "sea_lantern"],
            [6, 4, 8, "glowstone"],
            [4, 4, 4, "sea_lantern"],
            [8, 4, 8, "sea_lantern"],
            [5, 5, 7, "glowstone"],
            [7, 6, 5, "glowstone"]
        ] as const)
            c.set(`minecraft:${light}`, u, level, v);
        c.set("minecraft:spruce_log", 6, 1, 6, 6, 7, 6);
        c.set("minecraft:glowstone", 6, 8, 6);
        const leaves = "minecraft:spruce_leaves[persistent=true]";
        c.set(leaves, 4, 3, 4, 8, 4, 8);
        c.set(leaves, 5, 5, 5, 7, 6, 7);
        for (const [du, dv] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1]
        ] as const)
            c.set(leaves, 6 + du, 7, 6 + dv);
        // Under the branches: presents round the trunk, and room to crouch.
        c.spot(5, 1, 5);
        // Wrapped boxes, a bow on each: under the tree and by the walls.
        for (const [u, v, box, bow] of [
            [4, 7, "red_wool", "yellow"],
            [8, 5, "green_wool", "white"],
            [7, 8, "blue_concrete", "red"],
            [10, 1, "red_concrete", "white"],
            [11, 1, "lime_concrete", "red"],
            [12, 2, "white_wool", "red"],
            [1, 5, "yellow_concrete", "blue"]
        ] as const) {
            c.set(`minecraft:${bow}_carpet`, u, 2, v);
            c.set(`minecraft:${box}`, u, 1, v);
        }
        // Two presents big enough to hide in, a door in the front of each.
        c.set("minecraft:yellow_carpet", 3, 4, 10, 3, 4, 11);
        wardrobe(c, "minecraft:red_wool", "spruce", 2, 10);
        c.set("minecraft:white_carpet", 10, 4, 10, 10, 4, 11);
        wardrobe(c, "minecraft:green_wool", "spruce", 9, 10);
        button(c, "minecraft:spruce_button", 5, 2, 10, "east");
        button(c, "minecraft:spruce_button", 8, 2, 11, "west");
        // A snowman to stare at.
        c.set("minecraft:snow_block", 2, 1, 2, 2, 2, 2);
        gaze(c, "minecraft:carved_pumpkin[facing=south]", 2, 3, 2, { u: 2, v: 6 });
        rug(c, "red", 11, 6);
        tile(c, 12, 8);
    }
};

/** A cozy cabin (from 1.14, the campfire's release): a hearth with its fire
 *  behind bars, a window onto the snow, red and white rugs, a coat closet and
 *  a cellar under a hatch. */
const CABIN: Template = {
    name: "cabin",
    fire: true,
    season: "winter",
    since: CLOSETS_SINCE,
    fits: (era) => era.scaffold,
    style: {
        face: "minecraft:spruce_planks",
        floor: "minecraft:spruce_planks",
        entrances: ["door", "painting", "panel"]
    },
    draw(c) {
        // The hearth: the fire behind bars, in brick to the ceiling, on a
        // brick floor. Nothing that burns stands within four of it
        // (`seek-manor.manorProblems`).
        c.set("minecraft:campfire[facing=south,lit=true]", 6, 1, 6);
        c.set("minecraft:iron_bars", 6, 1, 7);
        c.set("minecraft:bricks", 4, 0, 4, 8, 0, 8);
        c.set("minecraft:bricks", 5, 1, 5, 7, 3, 6);
        c.set("minecraft:bricks", 6, 4, 5, 6, 10, 6);
        button(c, "minecraft:stone_button", 4, 2, 5, "west");
        // A window onto the snow, on a side with no doorway: glass in a frame
        // of logs, over everybody's head, and snow piled behind it.
        const side = (["north", "south"] as const).find((one) => !hasDoor(c, one));
        if (side) {
            const v = (at: number) => (side === "north" ? at : LAST - at);
            c.set("minecraft:glass", 5, 4, v(1), 8, 5, v(1));
            c.set("minecraft:spruce_log", 4, 3, v(1), 9, 3, v(1));
            c.set("minecraft:spruce_log", 4, 6, v(1), 9, 6, v(1));
            c.set("minecraft:spruce_log", 4, 4, v(1), 4, 5, v(1));
            c.set("minecraft:spruce_log", 9, 4, v(1), 9, 5, v(1));
            c.set("minecraft:snow_block", 4, 1, v(0), 9, 6, v(0));
        }
        // Rugs of red and white, all well away from the fire.
        rug(c, "red", 7, 11);
        for (let u = 6; u <= 8; u += 1)
            for (let v = 10; v <= 12; v += 1)
                c.set(`minecraft:${(u + v) % 2 === 0 ? "white" : "red"}_carpet`, u, 1, v);
        wardrobe(c, "minecraft:spruce_planks", "spruce", 2, 10);
        button(c, "minecraft:spruce_button", 5, 2, 10, "east");
        cellar(c, 10, 10, 12, 12);
        hatch(c, "spruce", 10, 11, "east");
        c.spot(12, -3, 12);
        // A snowman by the wall to stare at.
        c.set("minecraft:snow_block", 12, 1, 7, 12, 2, 7);
        gaze(c, "minecraft:carved_pumpkin[facing=west]", 12, 3, 7, { u: 8, v: 9 });
        tile(c, 11, 2);
    }
};

/** A toy workshop: a stall with a striped roof and a cellar under it,
 *  workbenches, stacks of toy blocks and a toy cupboard to hide in. */
const TOYS: Template = {
    name: "toys",
    season: "winter",
    since: CLOSETS_SINCE,
    style: {
        face: "minecraft:birch_planks",
        floor: "minecraft:oak_planks",
        entrances: ["panel", "door", "painting"]
    },
    draw(c) {
        // The stall's striped roof, round the lamp in its middle.
        for (let u = 7; u <= 11; u += 1)
            if (u !== 9) c.set(`minecraft:${u % 2 === 0 ? "red" : "white"}_wool`, u, 4, 2, u, 4, 6);
        hut(c, 7, "minecraft:spruce_planks", "red");
        button(c, "minecraft:oak_button", 12, 2, 4, "east");
        // Workbenches along one side, toy blocks stacked by the other.
        c.set("minecraft:crafting_table", 2, 1, 6, 4, 1, 6);
        button(c, "minecraft:oak_button", 5, 1, 6, "east");
        for (const [u, level, v, block] of [
            [2, 1, 2, "red_wool"],
            [3, 1, 2, "blue_wool"],
            [2, 2, 2, "yellow_wool"],
            [4, 1, 3, "lime_concrete"],
            [2, 1, 3, "orange_concrete"]
        ] as const)
            c.set(`minecraft:${block}`, u, level, v);
        wardrobe(c, "minecraft:birch_planks", "oak", 2, 10);
        button(c, "minecraft:oak_button", 5, 2, 10, "east");
        // A toy on a post to stare at.
        c.set("minecraft:spruce_fence", 11, 1, 9);
        gaze(c, "minecraft:creeper_head[rotation=4]", 11, 2, 9, { u: 7, v: 9 });
        rug(c, "lime", 7, 10);
        tile(c, 12, 12);
    }
};

/** The seasons' rooms: a house draws them only in their season. */
export const SEASONAL: readonly Template[] = [PARLOUR, WITCH, PUMPKINS, PRESENTS, CABIN, TOYS];

/** The season's colours, for its banners. */
const COLOURS: Readonly<Record<Decoration, readonly [string, string]>> = {
    halloween: ["orange", "purple"],
    winter: ["red", "green"]
};

/** The lowest level under a web at level 9 that must hold nothing to stand
 *  on: whoever stands on it reaches the web with a jump. */
const WEB_REACH = 5;

/**
 * A touch of the season for the house's own rooms, while it lasts
 * (`seek-manor.drawManor`): in each corner, out of everybody's way, webs or
 * greenery up under the ceiling, a banner in the season's colours, and a
 * pumpkin lantern or a present on the floor. Only into what the room left
 * free - never a doorway, a nook, a hiding place or what stands over one -
 * and nothing that burns in a room with a fire.
 */
export function dress(c: Canvas, season: Decoration, template: Template): void {
    const burns = template.fire !== true;
    const corners = [
        [0, 0],
        [LAST, 0],
        [0, LAST],
        [LAST, LAST]
    ] as const;
    corners.forEach(([u, v], index) => {
        const facing: Side = v === 0 ? "south" : "north";
        const free = (from: number, to: number, a: number = u, b: number = v) => {
            for (let level = from; level <= to; level += 1) if (!c.free(a, level, b)) return false;
            return true;
        };
        const near = [u, u === 0 ? 1 : LAST - 1].flatMap((a) =>
            [v, v === 0 ? 1 : LAST - 1].map((b) => [a, b] as const)
        );
        // Up under the ceiling, with nothing under it anybody stands on.
        if (free(9, 10) && near.every(([a, b]) => free(WEB_REACH, 8, a, b))) {
            if (season === "halloween") c.set("minecraft:cobweb", u, 9, v, u, 10, v);
            else if (burns) c.set("minecraft:spruce_leaves[persistent=true]", u, 9, v, u, 10, v);
        }
        // A banner on the wall the corner's side shares with no doorway or nook.
        if (burns && free(4, 4))
            c.set(`minecraft:${COLOURS[season][index % 2]}_wall_banner[facing=${facing}]`, u, 4, v);
        // On the floor of a corner with nothing in, under or over it.
        if (!free(0, 3)) return;
        if (season === "halloween") c.set(`minecraft:jack_o_lantern[facing=${facing}]`, u, 1, v);
        else if (burns) {
            c.set(`minecraft:${index % 2 === 0 ? "yellow" : "white"}_carpet`, u, 2, v);
            c.set(`minecraft:${index % 2 === 0 ? "red" : "green"}_wool`, u, 1, v);
        }
    });
}

/** A plain room, for a house that falls back to its bare walls. */
export const PLAIN: Template = {
    name: "plain",
    style: {
        face: "minecraft:stone_bricks",
        floor: "minecraft:smooth_stone",
        entrances: ["painting"]
    },
    draw() {}
};
