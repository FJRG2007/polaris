/**
 * Every way into a hide and seek manor's hiding places has a way back out, as
 * a player meets it:
 *
 * - from every hiding place, with every secret panel shut, a player gets back
 *   to the middle opening only the panels whose key they can reach from where
 *   they are - the button inside a nook, the lever across the room once they
 *   are out - never one somebody outside has to open for them;
 * - every door opens onto somewhere to stand on both sides, never onto wall;
 * - every ladder's top lets a player off it, onto a floor with room to stand,
 *   or up through a hatch or a panel;
 * - the spots under the lava are among them.
 */

import { describe, expect, it } from "vitest";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as rooms from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-rooms";

const ERAS: readonly model.Era[] = [
    model.OLDEST,
    { scaffold: true, snow: true, display: false },
    model.NEWEST
];

const STEP: Readonly<Record<string, readonly [number, number]>> = {
    north: [0, -1],
    south: [0, 1],
    west: [-1, 0],
    east: [1, 0]
};

/** The template a cell of the house belongs to, for a readable failure. */
function roomAt(house: manor.Manor, x: number, z: number): string {
    const span = model.ROOM + model.WALL;
    const i = Math.floor((x - model.WALL) / span);
    const j = Math.floor((z - model.WALL) / span);
    const plan = house.rooms.find((one) => one.i === i && one.j === j);
    return plan ? plan.template : "a wall";
}

/** The grid cells of each panel, by its number. */
function panelCells(house: manor.Manor): Map<number, number[]> {
    const { grid } = house;
    const out = new Map<number, number[]>();
    for (const panel of house.panels)
        out.set(
            panel.id,
            (panel.shape === "wall" ? [panel.level, panel.level + 1] : [panel.level]).map((level) =>
                grid.index(panel.x, level, panel.z)
            )
        );
    return out;
}

/** Whether a player standing at `place` works `key`: within arm's reach of a
 *  button or a lever, on the rug or tile, or where the thing is stared at
 *  from. */
function works(key: manor.Key, place: { x: number; feet: number; z: number }): boolean {
    if (key.kind === "btn" || key.kind === "lever") {
        const eye = { x: place.x + 0.5, y: place.feet + 1.62, z: place.z + 0.5 };
        return (
            Math.hypot(eye.x - (key.x + 0.5), eye.y - (key.level + 0.5), eye.z - (key.z + 0.5)) <=
            4.5
        );
    }
    return place.x === key.from.x && place.z === key.from.z;
}

/**
 * Whether a player at `from` gets back to the middle with every panel shut,
 * opening each only once they stand where one of its keys works.
 */
function escapes(house: manor.Manor, from: { x: number; feet: number; z: number }): boolean {
    const { grid } = house;
    const cells = panelCells(house);
    const saved = new Map(grid.panels);
    const open = new Set<number>();
    const home = manor.hiderCells(house)[0]!;
    const homeIndex = grid.index(home.x, 1, home.z);
    try {
        for (;;) {
            grid.panels.clear();
            for (const id of open)
                for (const index of cells.get(id) ?? []) {
                    const shape = saved.get(index);
                    if (shape) grid.panels.set(index, shape);
                }
            const steps = model.walk(grid, from, "seeker");
            if (steps[homeIndex]! >= 0) return true;
            let opened = false;
            for (const key of house.keys) {
                if (open.has(key.id)) continue;
                for (let index = 0; index < steps.length; index += 1) {
                    if (steps[index]! < 0) continue;
                    if (works(key, grid.place(index))) {
                        open.add(key.id);
                        opened = true;
                        break;
                    }
                }
            }
            if (!opened) return false;
        }
    } finally {
        grid.panels.clear();
        for (const [index, shape] of saved) grid.panels.set(index, shape);
    }
}

function housesOf(seeds: number, design = manor.DESIGN): manor.Manor[] {
    const out: manor.Manor[] = [];
    for (const era of ERAS)
        for (const count of [3, 4])
            for (let seed = 0; seed < seeds; seed += 1)
                out.push(manor.manorFor(`escape-${count}-${seed}`, count, era, design));
    return out;
}

/** Every door's lower half, and the way it faces. */
function doorsOf(house: manor.Manor): { x: number; z: number; facing: string }[] {
    const { grid } = house;
    const out: { x: number; z: number; facing: string }[] = [];
    for (let x = 0; x < grid.size; x += 1)
        for (let z = 0; z < grid.size; z += 1) {
            const block = grid.get(x, 1, z) ?? "";
            if (!/_door\[/.test(block) || !/half=lower/.test(block)) continue;
            out.push({ x, z, facing: /facing=(\w+)/.exec(block)![1]! });
        }
    return out;
}

describe("getting out of a hide and seek manor's hiding places", () => {
    it("walks back to the middle from every hiding place with every panel shut, opening only what it reaches a key for", () => {
        const stuck: string[] = [];
        for (const house of housesOf(8))
            for (const spot of house.spots)
                if (!escapes(house, spot))
                    stuck.push(
                        `${roomAt(house, spot.x, spot.z)} ${spot.x},${spot.feet},${spot.z} (${house.count} rooms, era ${JSON.stringify(house.era)})`
                    );
        expect(stuck).toEqual([]);
    }, 300_000);

    it("never leaves anybody under a floor panel: the button below opens it", () => {
        for (const house of housesOf(6))
            for (const panel of house.panels.filter((one) => one.shape === "floor")) {
                // Down the ladder under it, as far as it goes.
                let feet = -1;
                while (
                    model.bare(house.grid.get(panel.x, feet - 1, panel.z) ?? "") ===
                    "minecraft:ladder"
                )
                    feet -= 1;
                expect(escapes(house, { x: panel.x, feet, z: panel.z })).toBe(true);
            }
    }, 300_000);

    it("opens every door onto somewhere to stand, on both sides", () => {
        const walls: string[] = [];
        for (const house of housesOf(10)) {
            const m = model.moves(house.grid, "seeker");
            for (const door of doorsOf(house)) {
                const [dx, dz] = STEP[door.facing]!;
                for (const way of [1, -1])
                    if (!m.held(door.x + way * dx, 1, door.z + way * dz))
                        walls.push(
                            `${roomAt(house, door.x, door.z)} door at ${door.x},${door.z} facing ${door.facing} opens onto ${house.grid.get(door.x + way * dx, 1, door.z + way * dz)}`
                        );
            }
        }
        expect(walls).toEqual([]);
    }, 120_000);

    it("lets a player off the top of every ladder", () => {
        const tops: string[] = [];
        for (const house of housesOf(10)) {
            const { grid } = house;
            // Everybody in a manor crosses its lava (`fireproofLines`): a
            // ladder up into it climbs out through it.
            const m = model.moves(grid, "hider");
            for (let x = 0; x < grid.size; x += 1)
                for (let z = 0; z < grid.size; z += 1)
                    for (let level = model.DEEP; level < model.ROOF - 1; level += 1) {
                        if (grid.cell(x, level, z) !== "climb") continue;
                        if (grid.cell(x, level + 1, z) === "climb") continue;
                        // Up through what opens over it: a hatch or a floor panel.
                        if (grid.cell(x, level + 1, z) === "hatch" || grid.panelAt(x, level + 1, z))
                            continue;
                        // Off it: a step to a floor beside it, at the top rung's
                        // height or a block over it, with room to stand.
                        const off = (
                            [
                                [1, 0],
                                [-1, 0],
                                [0, 1],
                                [0, -1]
                            ] as const
                        ).some(
                            ([dx, dz]) =>
                                m.held(x + dx, level, z + dz) ||
                                (m.held(x + dx, level + 1, z + dz) && m.open(x, level + 2, z))
                        );
                        // Or standing on its top: the rung over a floor.
                        if (!off && !m.held(x, level + 1, z))
                            tops.push(
                                `${roomAt(house, x, z)} ladder top at ${x},${level},${z} (${house.count} rooms)`
                            );
                    }
        }
        expect(tops).toEqual([]);
    }, 120_000);

    it("hides somebody under the forge's lava with a way back out", () => {
        let under = 0;
        for (const house of housesOf(10)) {
            if (!house.rooms.some((one) => one.template === "forge")) continue;
            for (const spot of house.spots) {
                let lava = false;
                for (let level = spot.feet + 2; level <= 1 && !lava; level += 1)
                    for (let dx = -3; dx <= 3; dx += 1)
                        for (let dz = -3; dz <= 3; dz += 1)
                            if (house.grid.cell(spot.x + dx, level, spot.z + dz) === "lava")
                                lava = true;
                if (!lava) continue;
                under += 1;
                expect(escapes(house, spot)).toBe(true);
            }
        }
        expect(under).toBeGreaterThan(0);
    }, 120_000);
});

describe("the escape test itself", () => {
    it("finds a hiding place nobody gets out of once its only key is taken away", () => {
        const house = manor.manorFor("escape-self", 3, model.NEWEST);
        const panel = house.panels.find((one) => one.shape === "wall")!;
        expect(panel).toBeDefined();
        const inside = {
            ...house,
            keys: house.keys.filter((key) => key.id !== panel.id || !key.inside)
        };
        const spot = house.spots.find(
            (one) => Math.hypot(one.x - panel.x, one.z - panel.z) <= 3 && one.feet === 1
        )!;
        expect(escapes(house, spot)).toBe(true);
        expect(escapes(inside, spot)).toBe(false);
        expect(rooms.TEMPLATES.length).toBeGreaterThan(0);
    });
});
