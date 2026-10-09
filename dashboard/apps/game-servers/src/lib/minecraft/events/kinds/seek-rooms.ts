/**
 * The rooms hide and seek's manor (`seek-manor.ts`) is put together from: a
 * library of hand-made templates, each with its own look and its own hiding
 * places, set into the house turned any of four ways and mirrored, the way
 * Spelunky fills its grid of rooms from templates that fit the openings a
 * path needs (Derek Yu, "Spelunky", Boss Fight Books 2016; Darius Kazemi,
 * "Spelunky Generator Lessons", 2013) and Minecraft's jigsaw structures join
 * pieces at matching connectors.
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
    readonly style: Style;
    /** Its doorways, by side and where along it they start (two wide). */
    readonly doors: readonly { readonly side: Side; readonly at: number }[];
    set(block: string, u1: number, l1: number, v1: number, u2?: number, l2?: number, v2?: number): void;
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
    /** A block shown by a display entity over air (from 1.19.4). */
    display(block: string, u: number, level: number, v: number): void;
    hook(hook: Hook): void;
    spot(u: number, feet: number, v: number): void;
}

export interface Template {
    readonly name: string;
    readonly style: Style;
    /** Whether the server can show it at all. */
    readonly fits?: (era: Era) => boolean;
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

// ------------------------------------------------------------------ the library

/** The middle room: the seekers' cage and the hiders' ring round it, kept
 *  clear, columns in the corners and the walls' nooks to find. */
export const FOYER: Template = {
    name: "foyer",
    style: { face: "minecraft:quartz_block", floor: "minecraft:polished_andesite", entrances: ["painting", "veil", "panel"] },
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
    style: { face: "minecraft:bookshelf", floor: "minecraft:dark_oak_planks", entrances: ["panel", "veil", "painting"] },
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
    style: { face: "minecraft:bricks", floor: "minecraft:polished_andesite", entrances: ["door", "painting", "panel"] },
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
    // Nothing that burns within reach of the lava.
    style: { face: "minecraft:stone_bricks", floor: "minecraft:smooth_stone", entrances: ["panel", "painting"] },
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
        button(c, "minecraft:stone_button", 10, 2, 4, "south");
        button(c, "minecraft:stone_button", 12, 1, 3, "east");
        c.set("minecraft:cobblestone", 10, 1, 10, 11, 2, 11);
        button(c, "minecraft:stone_button", 9, 1, 10, "west");
        gaze(c, "minecraft:jack_o_lantern[facing=north]", 10, 3, 10, { u: 10, v: 6 });
        tile(c, 12, 12);
    }
};

const GARDEN: Template = {
    name: "garden",
    style: { face: "minecraft:mossy_stone_bricks", floor: "minecraft:grass_block", entrances: ["falls", "veil", "painting"] },
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
    style: { face: "minecraft:stone_bricks", floor: "minecraft:grass_block", entrances: ["painting", "veil", "panel"] },
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
    style: { face: "minecraft:spruce_planks", floor: "minecraft:spruce_planks", entrances: ["painting", "panel"] },
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
                if (cx < 4 && maze.open(carved, cx, cz, 1, 0)) c.clear(u + 2, 1, v, u + 2, 4, v + 1);
                if (cz < 4 && maze.open(carved, cx, cz, 0, 1)) c.clear(u, 1, v + 2, u + 1, 4, v + 2);
                if (!dark || (cx + cz) % 2 === 0) c.set("minecraft:sea_lantern", u + (cz % 2), 0, v + (cx % 2));
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
    style: { face: "minecraft:quartz_block", floor: "minecraft:dark_oak_planks", entrances: ["painting", "veil", "panel"] },
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
            const crate = c.era.scaffold ? "minecraft:barrel[facing=up]" : "minecraft:spruce_planks";
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
            gaze(c, `minecraft:skeleton_skull[rotation=${rotation}]`, u, 3, v, { u, v: v + (v === 7 ? 3 : -3) });
            button(c, "minecraft:stone_button", u - 1, 1, v, "west");
        }
        rug(c, "purple", 6, 9);
        tile(c, 7, 4);
    }
};

const WORKSHOP: Template = {
    name: "workshop",
    style: { face: "minecraft:spruce_planks", floor: "minecraft:oak_planks", entrances: ["panel", "door", "painting"] },
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
        // before.
        const climb = c.era.scaffold ? "minecraft:scaffolding[distance=0,bottom=false]" : "minecraft:ladder[facing=west]";
        c.set(climb, 12, 1, 11, 12, 8, 11);
        c.set("minecraft:spruce_log", 13, 1, 11, 13, 7, 11);
        c.set("minecraft:birch_planks", 12, 8, 7, 13, 8, 10);
        c.set("minecraft:birch_planks", 13, 8, 11);
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
    style: { face: "minecraft:birch_planks", floor: "minecraft:oak_planks", entrances: ["door", "painting", "veil"] },
    draw(c) {
        // Three wardrobes, three across, two deep and three high, all alike: a
        // door in the front, and behind it room for one - or, in one of them,
        // its back.
        const wardrobes = [
            [2, 2],
            [7, 2],
            [2, 10]
        ] as const;
        const solid = Math.floor(c.random() * wardrobes.length);
        wardrobes.forEach(([u, v], index) => {
            c.set("minecraft:oak_door[facing=south,half=lower,hinge=left,open=false]", u + 1, 1, v + 1);
            c.set("minecraft:oak_door[facing=south,half=upper,hinge=left,open=false]", u + 1, 2, v + 1);
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
    style: { face: "minecraft:snow_block", floor: "minecraft:snow_block", entrances: ["panel", "painting"] },
    draw(c) {
        // Drifts of powder snow, which looks like the floor round it: step on
        // one and you sink - into nothing, or, on one of them, down into a
        // hollow under the floor. Its way out is a panel of the floor.
        for (const [u, v] of [
            [4, 4],
            [9, 4],
            [4, 9]
        ] as const)
            c.set("minecraft:powder_snow", u, 0, v);
        c.set("minecraft:powder_snow", 9, 0, 9);
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
    SNOW
];

/** A plain room, for a house that falls back to its bare walls. */
export const PLAIN: Template = {
    name: "plain",
    style: { face: "minecraft:stone_bricks", floor: "minecraft:smooth_stone", entrances: ["painting"] },
    draw() {}
};
