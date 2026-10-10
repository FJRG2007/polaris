/**
 * Nothing in a hide and seek house hangs on nothing. A block the game holds up
 * by another - a button or a ladder on a wall, a carpet on the floor, a door on
 * what is under it - is put down by a fill that never asks whether it can
 * stand, so one placed without its support floats until something next to it
 * changes, and then falls off as an item.
 *
 * Every house the generators can draw is walked block by block: the manor
 * (design 4) at every size, on every server age, over many seeds and every
 * draw, and the two halls older runs still rebuild (designs 2 and 3).
 */

import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as rooms from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-rooms";

type Pos = readonly [number, number, number];

interface World {
    /** The block at a place: null or "" for air. */
    get(x: number, y: number, z: number): string | null;
    /** Whether the block there is taken away while the house is played: a
     *  panel the data pack opens. */
    opens(x: number, y: number, z: number): boolean;
}

const STEP: Readonly<Record<string, readonly [number, number]>> = {
    north: [0, -1],
    south: [0, 1],
    west: [-1, 0],
    east: [1, 0]
};

/** Blocks whose side is not a whole, sturdy face: nothing hangs on them. */
const NOT_STURDY =
    /(_button|_carpet|_banner|torch|poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|allium|fern|grass$|_sapling|_pressure_plate|_sign|ladder|_door|_trapdoor|_fence|_wall$|iron_bars|glass_pane|water|lava|scaffolding|_slab|_stairs|anvil|cauldron|_bed|_skull|_head|:lantern|soul_lantern|vine|lectern|chest|powder_snow|cobweb|flower_pot|candle|chain|piston_head|structure_void|lever)$/;
const FLOWER = /(poppy|dandelion|cornflower|azure_bluet|oxeye_daisy|allium)$/;
const SOIL = /(grass_block|dirt|podzol|moss_block|coarse_dirt|rooted_dirt)$/;

function sturdy(world: World, [x, y, z]: Pos): boolean {
    const block = world.get(x, y, z);
    return !!block && !world.opens(x, y, z) && !NOT_STURDY.test(model.bare(block));
}

function solidThere(world: World, [x, y, z]: Pos): boolean {
    return !!world.get(x, y, z) && !world.opens(x, y, z);
}

const behind = (x: number, y: number, z: number, facing: string): Pos => [
    x - STEP[facing]![0],
    y,
    z - STEP[facing]![1]
];

/** Why the block at a place has nothing to stand on, or null when it has. */
function unheld(world: World, x: number, y: number, z: number): string | null {
    const block = world.get(x, y, z);
    if (!block) return null;
    const id = model.bare(block);
    const facing = /facing=(north|south|east|west)/.exec(block)?.[1];
    const below: Pos = [x, y - 1, z];
    if (/(_button|lever)$/.test(id)) {
        const face = /face=(wall|floor|ceiling)/.exec(block)?.[1] ?? "wall";
        const on: Pos =
            face === "floor"
                ? below
                : face === "ceiling"
                  ? [x, y + 1, z]
                  : behind(x, y, z, facing ?? "north");
        return sturdy(world, on) ? null : `on ${face} with nothing at ${on.join(" ")}`;
    }
    if (/(ladder|wall_torch|wall_banner|wall_sign|wall_hanging_sign)$/.test(id)) {
        const on = behind(x, y, z, facing ?? "north");
        return sturdy(world, on) ? null : `nothing behind it at ${on.join(" ")}`;
    }
    if (/_door$/.test(id)) {
        if (/half=upper/.test(block))
            return /_door$/.test(model.bare(world.get(...below) ?? "")) ? null : "no lower half";
        return sturdy(world, below) ? null : `nothing under it at ${below.join(" ")}`;
    }
    if (/(_carpet|_pressure_plate|(^|:)torch|_sign|_banner)$/.test(id))
        return solidThere(world, below) ? null : `nothing under it at ${below.join(" ")}`;
    if (FLOWER.test(id))
        return SOIL.test(model.bare(world.get(...below) ?? "")) ? null : "not on soil";
    return null;
}

function gridWorld(house: manor.Manor): World {
    const { grid } = house;
    return {
        get: (x, y, z) => grid.get(x, y, z),
        opens: (x, y, z) => grid.panelAt(x, y, z) !== null
    };
}

/** Where a house cell is in its room's own terms, for a readable failure. */
function whereIn(house: manor.Manor, x: number, z: number): string {
    const span = model.ROOM + model.WALL;
    const i = Math.floor((x - model.WALL) / span);
    const j = Math.floor((z - model.WALL) / span);
    const plan = house.rooms.find((one) => one.i === i && one.j === j);
    if (!plan) return "a wall";
    const L = rooms.LAST;
    for (let u = 0; u <= L; u += 1)
        for (let v = 0; v <= L; v += 1) {
            const a = plan.mirror ? L - u : u;
            const [dx, dz] =
                plan.turn === 1
                    ? [L - v, a]
                    : plan.turn === 2
                      ? [L - a, L - v]
                      : plan.turn === 3
                        ? [v, L - a]
                        : [a, v];
            if (model.WALL + i * span + dx === x && model.WALL + j * span + dz === z)
                return `${plan.template} u ${u} v ${v}`;
        }
    return `the wall of ${plan.template}`;
}

function problemsOf(house: manor.Manor): string[] {
    const world = gridWorld(house);
    const out: string[] = [];
    for (let level = model.DEEP; level < model.ROOF; level += 1)
        for (let x = 0; x < house.grid.size; x += 1)
            for (let z = 0; z < house.grid.size; z += 1) {
                const why = unheld(world, x, level, z);
                if (why)
                    out.push(
                        `${whereIn(house, x, z)} level ${level}: ${world.get(x, level, z)} - ${why}`
                    );
            }
    return out;
}

const ERAS: readonly model.Era[] = [
    model.OLDEST,
    { scaffold: true, snow: false, display: false },
    { scaffold: true, snow: true, display: false },
    model.NEWEST
];

describe("what hangs on something in a hide and seek house", () => {
    it("finds a button with nothing behind it, a carpet on air and a ladder on a door", () => {
        const cells = new Map<string, string>([
            ["0,1,0", "minecraft:stone_button[face=wall,facing=south,powered=false]"],
            ["5,1,5", "minecraft:white_carpet"],
            ["9,1,9", "minecraft:ladder[facing=east]"],
            ["8,1,9", "minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]"],
            ["8,0,9", "minecraft:stone"],
            ["2,1,2", "minecraft:oak_button[face=wall,facing=east,powered=false]"],
            ["1,1,2", "minecraft:bookshelf"]
        ]);
        const world: World = {
            get: (x, y, z) => cells.get(`${x},${y},${z}`) ?? null,
            opens: () => false
        };
        expect(unheld(world, 0, 1, 0)).toMatch(/nothing at 0 1 -1/);
        expect(unheld(world, 5, 1, 5)).toMatch(/nothing under it/);
        expect(unheld(world, 9, 1, 9)).toMatch(/nothing behind it at 8 1 9/);
        expect(unheld(world, 8, 1, 9)).toBeNull();
        expect(unheld(world, 2, 1, 2)).toBeNull();
        // A panel the data pack opens holds nothing up.
        const opening: World = { ...world, opens: (x) => x === 1 };
        expect(unheld(opening, 2, 1, 2)).toMatch(/nothing at 1 1 2/);
    });

    it("holds up everything in every manor, at every size, on every server age", () => {
        const seen = new Set<string>();
        const problems = new Set<string>();
        for (const count of [3, 4, 5])
            for (const era of ERAS)
                for (let seed = 0; seed < 12; seed += 1) {
                    for (let draw = 0; draw < 3; draw += 1) {
                        const house = manor.drawManor(`supports-${seed}`, count, era, draw);
                        for (const plan of house.rooms) seen.add(plan.template);
                        for (const one of problemsOf(house)) problems.add(one);
                    }
                    const plain = manor.drawManor(`supports-${seed}`, count, era, 0, true);
                    for (const one of problemsOf(plain)) problems.add(one);
                }
        expect([...problems]).toEqual([]);
        // Every room the library has was drawn, the middle one included.
        for (const template of [rooms.FOYER, ...rooms.TEMPLATES])
            expect(seen).toContain(template.name);
    }, 120_000);

    it("holds up everything in the manors a run actually gets", () => {
        for (const era of ERAS)
            for (let seed = 0; seed < 6; seed += 1) {
                const house = manor.manorFor(`run-${seed}`, 3, era);
                expect(problemsOf(house)).toEqual([]);
            }
    }, 120_000);

    it("holds up everything in the halls older runs still rebuild", () => {
        const box = { x1: 0, y1: 0, z1: 0, x2: 40, y2: 20, z2: 40 };
        for (const design of [2, 3])
            for (let seed = 0; seed < 16; seed += 1) {
                const cells = new Map<string, string>();
                // Each fill only into air, as the build is: what came first stays.
                for (const fill of hs.hallFills(box, hs.layoutFor(`hall-${seed}`, design))) {
                    const b = fill.box;
                    for (let x = b.x1; x <= b.x2; x += 1)
                        for (let y = b.y1; y <= b.y2; y += 1)
                            for (let z = b.z1; z <= b.z2; z += 1) {
                                const key = `${x},${y},${z}`;
                                if (!cells.has(key)) cells.set(key, fill.block);
                            }
                }
                const world: World = {
                    get: (x, y, z) => cells.get(`${x},${y},${z}`) ?? null,
                    opens: () => false
                };
                const problems: string[] = [];
                for (const key of cells.keys()) {
                    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
                    const why = unheld(world, x, y, z);
                    if (why) problems.push(`design ${design} ${key}: ${cells.get(key)} - ${why}`);
                }
                expect(problems).toEqual([]);
            }
    }, 120_000);
});
