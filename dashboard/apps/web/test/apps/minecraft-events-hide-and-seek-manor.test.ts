/**
 * Hide and seek's manor (design 4): the house drawn from a library of rooms,
 * its walls all one thickness, its secrets opened by keys across the room, and
 * what the events data pack does with them.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import { seeded } from "@polaris-app/game-servers/src/lib/minecraft/events/trivia-bank";
import * as maze from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-maze";
import * as model from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-grid";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as manor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-manor";
import * as rooms from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/seek-rooms";
import * as pack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";
import * as panels from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/secret-panels";

const box = manor.hallBox({ x: 1000, z: -2000 }, 100, 3);

describe("hide and seek's manor", () => {
    it("keeps every rule, with every room template in use, on every server age", () => {
        const used = new Set<string>();
        let plain = 0;
        for (const era of [
            model.NEWEST,
            model.OLDEST,
            { scaffold: true, snow: true, display: false }
        ])
            for (let seed = 0; seed < 24; seed += 1) {
                const house = manor.manorFor(`run-${seed}`, 3, era);
                if (house.bare) plain += 1;
                expect(manor.manorProblems(house)).toEqual([]);
                for (const room of house.rooms) used.add(room.template);
            }
        expect(plain).toBe(0);
        expect([...used].sort()).toEqual(
            [...rooms.TEMPLATES.map((one) => one.name), "foyer"].sort()
        );
    }, 120_000);

    it("grows with the players, or with the size asked for", () => {
        expect(manor.roomsFor(2)).toBe(3);
        expect(manor.roomsFor(8)).toBe(3);
        expect(manor.roomsFor(9)).toBe(4);
        expect(manor.roomsFor(17)).toBe(5);
        expect(manor.roomsFor(2, "large")).toBe(5);
        expect(manor.roomsFor(24, "small")).toBe(3);
        expect([3, 4, 5].map(manor.sizeOf)).toEqual([58, 76, 94]);
        for (const count of [4, 5]) {
            const house = manor.manorFor(`big-${count}`, count, model.NEWEST);
            expect(house.bare).toBe(false);
            expect(manor.manorProblems(house)).toEqual([]);
            expect(manor.countOf(manor.hallBox({ x: 0, z: 0 }, 64, count))).toBe(count);
        }
    });

    it("is the same house for the same run, and another for another", () => {
        const a = manor.manorFor("same", 3, model.NEWEST);
        const b = manor.manorFor("same", 3, model.NEWEST);
        expect(manor.manorFills(box, a)).toEqual(manor.manorFills(box, b));
        expect(a.rooms).not.toEqual(manor.manorFor("other", 3, model.NEWEST).rooms);
    });

    it("joins every room, its doorways through the walls into room on both sides", () => {
        for (let seed = 0; seed < 10; seed += 1) {
            const house = manor.manorFor(`links-${seed}`, 4, model.NEWEST);
            const reached = new Set([0]);
            const queue = [0];
            while (queue.length > 0) {
                const room = queue.pop()!;
                for (const link of house.links) {
                    const other = link.a === room ? link.b : link.b === room ? link.a : -1;
                    if (other >= 0 && !reached.has(other)) {
                        reached.add(other);
                        queue.push(other);
                    }
                }
            }
            expect(reached.size).toBe(16);
            expect(house.links.length).toBeGreaterThanOrEqual(15);
        }
    });

    it("has walls all four thick: solid or hollow, nothing measures different", () => {
        const house = manor.manorFor("walls", 3, model.NEWEST);
        const { grid } = house;
        const step = model.ROOM + model.WALL;
        // Along every wall line, at every level of the rooms, the two faces are
        // there wherever there is no doorway: a block, a panel, a door, a
        // painting's banner or a shown block, the falls - never a hole that
        // shows the core.
        const open = new Set(house.shown.map((one) => `${one.x},${one.level},${one.z}`));
        for (let line = 0; line <= 3; line += 1)
            for (let along = model.WALL; along < house.size - model.WALL; along += 1) {
                if ((along - model.WALL) % step >= model.ROOM) continue;
                for (const face of [line * step, line * step + model.WALL - 1])
                    for (let level = 4; level < model.ROOF; level += 1) {
                        for (const [x, z] of [
                            [face, along],
                            [along, face]
                        ] as const) {
                            const block = grid.get(x, level, z);
                            const ok =
                                (block && block.length > 0) || open.has(`${x},${level},${z}`);
                            if (!ok) expect(`${x},${level},${z} ${block}`).toBe("a face");
                        }
                    }
            }
        // Every hidden place is in a wall's core, under the floor, in a tree's
        // crown, in a crate stack or wardrobe the same size as its twins, or up
        // on a shelf or balcony.
        for (const spot of house.spots)
            expect(house.grid.inside(spot.x, spot.feet, spot.z)).toBe(true);
    });

    it("puts each key well away from its panel, and holds the panel open for the walk", () => {
        let keys = 0;
        for (let seed = 0; seed < 20; seed += 1) {
            const house = manor.manorFor(`keys-${seed}`, 3, model.NEWEST);
            for (const panel of house.panels) {
                const outside = house.keys.filter((key) => key.id === panel.id && !key.inside);
                expect(outside.length).toBe(1);
                for (const key of outside) {
                    keys += 1;
                    const distance = Math.hypot(
                        key.from.x - panel.front.x,
                        key.from.z - panel.front.z
                    );
                    expect(distance).toBeGreaterThanOrEqual(manor.KEY_DISTANCE);
                    const steps = model.walk(
                        house.grid,
                        { x: key.from.x, feet: 1, z: key.from.z },
                        "seeker"
                    )[house.grid.index(panel.front.x, panel.front.feet, panel.front.z)]!;
                    expect(steps).toBeGreaterThanOrEqual(manor.KEY_DISTANCE - 1);
                    // The walk at 4.3 blocks a second, and three seconds more.
                    expect(key.hold).toBeGreaterThanOrEqual(Math.ceil((steps * 20) / 4.317) + 60);
                    expect(key.hold).toBeGreaterThanOrEqual(manor.HOLD_MIN);
                }
                expect(house.keys.some((key) => key.id === panel.id && key.inside)).toBe(true);
            }
        }
        expect(keys).toBeGreaterThan(20);
        expect(manor.holdTicks(10)).toBe(Math.ceil(200 / 4.317) + 60);
        expect(manor.holdTicks(0)).toBe(manor.HOLD_MIN);
    });

    it("mixes the keys of a design 4 house: buttons, rugs, tiles to look up from, things to stare at", () => {
        const kinds = new Set<string>();
        for (let seed = 0; seed < 20; seed += 1)
            for (const key of manor.manorFor(`kinds-${seed}`, 3, model.NEWEST, 4).keys)
                if (!key.inside) kinds.add(key.kind);
        expect([...kinds].sort()).toEqual(["btn", "crouch", "gaze", "up"]);
    });

    it("spreads hiding places over every room, bigger and taller ones in the walls", () => {
        for (let seed = 0; seed < 10; seed += 1) {
            const house = manor.manorFor(`spots-${seed}`, 3, model.NEWEST);
            const counts = manor.placesByRoom(house);
            expect(counts.every((count) => count >= 1)).toBe(true);
            expect(house.nooks.every((nook) => nook.length >= 4)).toBe(true);
        }
        const nooks = Array.from(
            { length: 10 },
            (_, seed) => manor.manorFor(`tall-${seed}`, 3, model.NEWEST).nooks
        ).flat();
        expect(nooks.some((nook) => nook.tall)).toBe(true);
        expect(new Set(nooks.map((nook) => nook.entrance)).size).toBeGreaterThanOrEqual(4);
    });

    it("shows nothing a server cannot: no display blocks, powder snow or scaffolding before their release", () => {
        for (let seed = 0; seed < 10; seed += 1) {
            const house = manor.manorFor(`old-${seed}`, 3, model.OLDEST);
            expect(house.shown).toEqual([]);
            expect(
                manor.decorLines(box, house).some((line) => line.includes("block_display"))
            ).toBe(false);
            const blocks = manor.manorBlocks(house);
            expect(blocks).not.toContain("minecraft:powder_snow");
            expect(blocks).not.toContain("minecraft:scaffolding");
            expect(blocks).not.toContain("minecraft:barrel");
            expect(house.rooms.some((room) => room.template === "snow")).toBe(false);
        }
        const shown = Array.from({ length: 10 }, (_, seed) =>
            manor.manorFor(`new-${seed}`, 3, model.NEWEST)
        );
        expect(shown.some((house) => house.shown.length > 0)).toBe(true);
    });

    it("keeps lava away from anything that burns, and never sends a seeker out of it", () => {
        const house = Array.from({ length: 30 }, (_, seed) =>
            manor.manorFor(`lava-${seed}`, 3, model.NEWEST)
        ).find((one) => one.rooms.some((room) => room.template === "forge"))!;
        expect(house).toBeDefined();
        expect(manor.manorProblems(house)).toEqual([]);
        // Seekers cross it as hiders do, to look in a spot under it: the pack
        // never sends one back out of it.
        expect(panels.FUNCTIONS.tick!.join("\n")).not.toContain("minecraft:lava");
        expect(panels.FUNCTIONS.burnt).toBeUndefined();
    });
});

describe("hide and seek's manor in the world", () => {
    const house = manor.manorFor("world", 3, model.NEWEST);
    const fills = manor.manorFills(box, house);

    it("is built only into air inside its box, in pieces a server takes, the probe last", () => {
        expect(box.x2 - box.x1 + 1).toBe(58);
        for (const one of fills) {
            expect(one.box.x1).toBeGreaterThanOrEqual(box.x1);
            expect(one.box.x2).toBeLessThanOrEqual(box.x2);
            expect(one.box.y1).toBeGreaterThanOrEqual(box.y1);
            expect(one.box.y2).toBeLessThanOrEqual(box.y2);
            expect(one.box.z1).toBeGreaterThanOrEqual(box.z1);
            expect(one.box.z2).toBeLessThanOrEqual(box.z2);
            expect(one.block.startsWith("~")).toBe(false);
            for (const piece of arena.slices(one.box))
                expect(arena.volume(piece)).toBeLessThanOrEqual(32_768);
        }
        // Water and lava after the stone round them; what hangs before what holds it.
        const fluid = fills.findIndex((one) => /water|lava/.test(one.block));
        const solidAfter = fills.slice(fluid).filter((one) => !/water|lava/.test(one.block));
        expect(solidAfter).toHaveLength(1);
        expect(fills.at(-1)!.box.x1).toBe(fills.at(-1)!.box.x2);
        const hung = /(_button|lever|ladder|_banner|_door|_trapdoor)\[/;
        const firstOther = fills.findIndex((one, index) => index > 1 && !hung.test(one.block));
        expect(fills.slice(firstOther).some((one) => hung.test(one.block))).toBe(false);
        // Scaffolding checks its support a tick after it is placed and drops
        // itself as an item with none, so it comes after every solid block
        // (the probe at the very end aside).
        const scaffold = fills.findIndex((one) => one.block.startsWith("minecraft:scaffolding"));
        const lastSolid = fills
            .slice(0, -1)
            .findLastIndex(
                (one) => !hung.test(one.block) && !/scaffolding|water|lava/.test(one.block)
            );
        if (scaffold >= 0) expect(scaffold).toBeGreaterThan(lastSolid);
        // Leaves that never wither.
        expect(
            fills
                .filter((one) => one.block.includes("leaves"))
                .every((one) => one.block.includes("persistent=true"))
        ).toBe(true);
    });

    it("comes down fluids first, then what hangs, then what holds it", () => {
        const blocks = manor.manorBlocks(house);
        const index = (pattern: RegExp) => blocks.findIndex((one) => pattern.test(one));
        expect(index(/water/)).toBeLessThan(index(/ladder/));
        expect(index(/ladder/)).toBeLessThan(index(/stone$/));
        expect(index(/_banner/)).toBeLessThan(index(/stone_bricks/));
        expect(blocks).toContain("minecraft:barrier");
        const lines = manor.closeLines(box);
        expect(lines.some((line) => line.includes(`kill @e[tag=${panels.DECOR}`))).toBe(true);
        expect(
            lines.filter((line) => /replace minecraft:(lava|water)$/.test(line)).length
        ).toBeGreaterThanOrEqual(2);
        for (const line of lines) expect(line.length).toBeLessThan(400);
    });

    it("hangs its paintings unbreakable, in both spellings, and shows its display blocks", () => {
        const lines = manor.decorLines(box, house);
        const paintings = lines.filter((line) => line.includes("summon minecraft:painting"));
        expect(paintings.length).toBe(house.paintings.length);
        expect(house.paintings.some((one) => one.door)).toBe(
            house.nooks.some((nook) => nook.entrance === "painting")
        );
        for (const line of paintings) {
            expect(line).toMatch(
                /\{Facing:\db,facing:\db,Motive:"minecraft:(wanderer|graham)",variant:"minecraft:(wanderer|graham)",Invulnerable:1b,Tags:\["pe_hs_deco"\]\}$/
            );
        }
        for (const line of lines.filter((one) => one.includes("block_display")))
            expect(line).toMatch(
                /summon minecraft:block_display -?\d+ \d+ -?\d+ \{block_state:\{Name:"minecraft:[a-z_]+"(,Properties:\{[^}]*\})?\},Tags:\["pe_hs_deco"\]\}$/
            );
        // A painting over a gap hangs on banners, which hold it up and let a player by.
        for (const one of house.paintings.filter((each) => each.door)) {
            const [dx, dz] = rooms.STEP[rooms.opposite(one.facing)];
            for (const level of [1, 2])
                expect(house.grid.get(one.x + dx, level, one.z + dz)).toMatch(/white_wall_banner/);
        }
    });

    it("arms its panels and keys with their numbers and holds, and the seekers' way home", () => {
        const lines = manor.armLines(box, house, "world");
        expect(lines.filter((line) => line.includes('"pe_pnl"'))).toHaveLength(house.panels.length);
        expect(lines.filter((line) => line.includes('"pe_key"'))).toHaveLength(house.keys.length);
        expect(lines.some((line) => line.includes('"pe_hs_home"'))).toBe(true);
        for (const key of house.keys)
            expect(lines.some((line) => line.endsWith(`${panels.HOLD} ${key.hold}`))).toBe(true);
        expect(
            lines.some((line) =>
                line.includes(
                    "scoreboard objectives add polaris_sneak minecraft.custom:minecraft.sneak_time"
                )
            )
        ).toBe(true);
        expect(manor.cageDown(box, house)).toMatch(
            /fill .* minecraft:air replace minecraft:barrier$/
        );
        // Every hider and seeker starts inside the box, on its floor.
        for (let index = 0; index < manor.MOST; index += 1) {
            const spot = manor.hiderSpot(box, house, index);
            expect(arena.contains(box, spot)).toBe(true);
            expect(spot.y).toBe(box.y1 + model.BASE + 1);
        }
    });

    it("leaves every panel open where the pack is not on to work it", () => {
        const lines = manor.openLines(box, house);
        const walls = house.panels.filter((panel) => panel.shape === "wall").length;
        const floors = house.panels.length - walls;
        expect(house.panels.length).toBeGreaterThan(0);
        expect(
            lines.filter((line) => / run setblock -?\d+ -?\d+ -?\d+ minecraft:air$/.test(line))
        ).toHaveLength(walls * 2);
        expect(lines.filter((line) => / minecraft:ladder\[facing=\w+\]$/.test(line))).toHaveLength(
            floors
        );
        for (const line of lines)
            expect(line).toMatch(
                /^execute in minecraft:overworld if block -?\d+ -?\d+ -?\d+ minecraft:\w+ run setblock /
            );
    });
});

describe("the manor's data pack", () => {
    it("works panels and keys in commands every release from 1.13 reads", () => {
        const files = pack.packFiles();
        const tick = JSON.parse(files.get("data/minecraft/tags/functions/tick.json")!) as {
            values: string[];
        };
        expect(tick.values).toContain("polaris:panel/tick");
        const all = Object.values(panels.FUNCTIONS).flat();
        for (const line of all) {
            // Nothing newer than 1.13: no predicates, no macros, no display entity ids.
            expect(line).not.toMatch(
                /predicate=|\$\(|block_display|item_display|function_macro|\bon\b passengers/
            );
        }
        // Every function a line calls exists.
        for (const line of all)
            for (const [, name] of line.matchAll(/function polaris:panel\/(\w+)/g))
                expect(panels.FUNCTIONS[name!]).toBeDefined();
        // Shut only when nobody touches the panel or a block round it.
        expect(
            panels.FUNCTIONS.work!.filter((line) =>
                line.includes("unless entity @e[type=!minecraft:item")
            )
        ).toHaveLength(2);
        // A panel goes back only into air (a wall) or over its own ladder (a floor).
        for (const [name, lines] of Object.entries(panels.FUNCTIONS))
            if (/_shut_/.test(name))
                for (const line of lines.filter((one) => one.includes("setblock")))
                    expect(line).toMatch(/if block ~ ~1? ?~ minecraft:(air|ladder)/);
    });

    it("fires a key on a press, a look up, a stare or three crouches", () => {
        const work = panels.FUNCTIONS.key_work!.join("\n");
        expect(work).toContain("#minecraft:buttons[powered=true]");
        expect(work).toContain("x_rotation=-90..-70");
        expect(work).toContain(`matches ${panels.LOOK_UP_TICKS}..`);
        expect(work).toContain(`matches ${panels.CROUCHES}..`);
        const gaze = panels.FUNCTIONS.gaze!.join("\n");
        expect(gaze).toContain("anchored eyes facing entity");
        expect(gaze).toContain("rotated as @s positioned ^ ^ ^-1 if entity @s[distance=..0.15]");
        // The open time is the longer of what is left and what the key holds.
        expect(panels.FUNCTIONS.fire!.join("\n")).toContain("> #hold polaris_pnl");
    });
});

describe("hide and seek's power-ups and effects", () => {
    it("gives only what cannot reach where a seeker cannot, tagged so only it comes off", () => {
        expect(hs.POWERS).toEqual(["invisible", "fast"]);
        const lines = hs.powerLines("Ana", "invisible");
        expect(lines).toContain(`tag Ana add ${hs.FX_TAG}`);
        expect(lines).toContain("effect give Ana minecraft:invisibility 10 0 true");
        expect(hs.powerLines("Ana", "fast")).toContain("effect give Ana minecraft:speed 15 0 true");
        expect(hs.fireproofLines("Ana")).toContain(
            "effect give Ana minecraft:fire_resistance 6 0 true"
        );
        const off = hs.effectsOff("Ana");
        for (const effect of hs.EFFECTS)
            expect(off).toContain(`effect clear @a[name=Ana,tag=${hs.FX_TAG}] minecraft:${effect}`);
        expect(off.at(-1)).toBe(`tag @a[name=Ana,tag=${hs.FX_TAG}] remove ${hs.FX_TAG}`);
        expect(hs.effectsOff()[0]).toBe(
            `effect clear @a[tag=${hs.FX_TAG}] minecraft:fire_resistance`
        );
        // Drawn from the run's id: the same each time.
        expect(hs.powerFor("run", "Ana", 1)).toBe(hs.powerFor("run", "ana", 1));
    });
});

describe("the mazes", () => {
    it("carves every cell reachable, with dead ends and a few loops", () => {
        for (let seed = 0; seed < 50; seed += 1) {
            const carved = maze.carve(5, seeded(`maze-${seed}`));
            expect(maze.reached(carved)).toBe(25);
            expect(maze.deadEnds(carved).length).toBeGreaterThan(0);
        }
        const tree = maze.carve(5, seeded("tree"), 0);
        const passages = tree.east.filter(Boolean).length + tree.south.filter(Boolean).length;
        expect(passages).toBe(24);
    });
});
describe("the manor's climbs and switches (design 5)", () => {
    const eras = [model.NEWEST, model.OLDEST, { scaffold: true, snow: true, display: false }];

    it("has a hall to climb in every house: a pad up to a ledge, two parkours, a crawlspace", () => {
        for (const era of eras)
            for (let seed = 0; seed < 6; seed += 1)
                for (const count of [3, 4]) {
                    const house = manor.manorFor(`climb-${seed}`, count, era);
                    expect(house.design).toBe(manor.DESIGN);
                    expect(house.bare).toBe(false);
                    expect(manor.manorProblems(house)).toEqual([]);
                    const halls = house.rooms
                        .map((room, index) => ({ room, index }))
                        .filter(({ room }) => room.template === "atrium");
                    expect(halls.length).toBeGreaterThanOrEqual(1);
                    expect(house.pads.length).toBe(halls.length);
                    expect(house.grid.jumps).toBe(true);
                    for (const pad of house.pads) {
                        expect(house.grid.get(pad.x, 0, pad.z)).toBe("minecraft:slime_block");
                        expect(house.grid.padAt(pad.x, 0, pad.z)).toBe(panels.PAD_RISE);
                    }
                    // Each hall's ledge and nests are places to hide, six up,
                    // and every one of them is reached (`manorProblems` above).
                    for (const { index } of halls) {
                        const high = house.spots.filter(
                            (spot) => spot.room === index && spot.feet === 6
                        );
                        expect(high).toHaveLength(3);
                        expect(
                            house.spots.some((spot) => spot.room === index && spot.feet < 0)
                        ).toBe(true);
                    }
                }
    }, 120_000);

    it("reaches the nests only by jumping, and the ledge only off the pad", () => {
        const house = manor.manorFor("jumps", 3, model.NEWEST);
        const start = manor.hiderCells(house)[0]!;
        const from = { x: start.x, feet: 1, z: start.z };
        const high = house.spots.filter((spot) => spot.feet === 6);
        const reached = (grid: model.Grid) => {
            const steps = model.walk(grid, from, "seeker");
            return high.filter((spot) => steps[grid.index(spot.x, spot.feet, spot.z)]! >= 0).length;
        };
        expect(reached(house.grid)).toBe(3);
        // The same house walked with no jumps and no pads: none of them.
        const flat = new model.Grid(house.grid.size, false);
        for (const part of house.grid.boxes())
            flat.set(part.block, part.x1, part.l1, part.z1, part.x2, part.l2, part.z2);
        expect(reached(flat)).toBe(0);
    });

    it("puts a lever on the wall for its secret panels, the key anybody sees", () => {
        let levers = 0;
        let outside = 0;
        for (let seed = 0; seed < 20; seed += 1) {
            const house = manor.manorFor(`lever-${seed}`, 3, model.NEWEST);
            for (const key of house.keys.filter((one) => !one.inside)) {
                outside += 1;
                if (key.kind !== "lever") continue;
                levers += 1;
                const block = house.grid.get(key.x, key.level, key.z)!;
                expect(block).toMatch(/^minecraft:lever\[face=wall,facing=\w+,powered=false\]$/);
                expect(key.level).toBe(2);
                const panel = house.panels.find((one) => one.id === key.id)!;
                expect(
                    Math.hypot(key.from.x - panel.front.x, key.from.z - panel.front.z)
                ).toBeGreaterThanOrEqual(manor.KEY_DISTANCE);
                expect(key.hold).toBeGreaterThanOrEqual(manor.HOLD_MIN);
            }
        }
        expect(outside).toBeGreaterThan(20);
        expect(levers / outside).toBeGreaterThan(0.7);
    });

    it("draws a design 4 house as it was: no hall to climb, no pads, no levers, no jumps", () => {
        for (let seed = 0; seed < 12; seed += 1) {
            const house = manor.manorFor(`old-design-${seed}`, 3, model.NEWEST, 4);
            expect(house.design).toBe(4);
            expect(house.grid.jumps).toBe(false);
            expect(house.pads).toEqual([]);
            expect(house.rooms.some((room) => room.template === "atrium")).toBe(false);
            expect(house.keys.some((key) => key.kind === "lever")).toBe(false);
            expect(manor.manorProblems(house)).toEqual([]);
        }
    });

    it("takes its pads and levers down with the house, levers before their wall", () => {
        const house = manor.manorFor("down", 3, model.NEWEST);
        const blocks = manor.manorBlocks(house);
        expect(blocks).toContain("minecraft:slime_block");
        expect(blocks).toContain("minecraft:lever");
        expect(blocks.indexOf("minecraft:lever")).toBeLessThan(blocks.indexOf("minecraft:stone"));
        const fills = manor.manorFills(box, house);
        const lever = fills.findIndex((one) => one.block.startsWith("minecraft:lever["));
        const wall = fills.findIndex((one) => one.block === "minecraft:stone");
        expect(lever).toBeGreaterThan(-1);
        expect(lever).toBeLessThan(wall);
    });

    it("arms a marker on each pad where a player's feet are, and takes it away again", () => {
        const house = manor.manorFor("pads", 3, model.NEWEST);
        const lines = manor.armLines(box, house, "pads");
        const pads = lines.filter((line) => line.includes(`"${panels.PAD}"`));
        expect(pads).toHaveLength(house.pads.length);
        for (const pad of house.pads)
            expect(
                pads.some((line) =>
                    line.includes(
                        `summon minecraft:armor_stand ${box.x1 + pad.x + 0.5} ${box.y1 + model.BASE + 1} ${box.z1 + pad.z + 0.5} `
                    )
                )
            ).toBe(true);
        expect(panels.stopLines(box).some((line) => line.includes(`tag=${panels.PAD},`))).toBe(
            true
        );
    });
});

describe("the manor's launch pads and levers in the data pack", () => {
    it("throws a player onto the ledge with a second of Levitation, never Slow Falling", () => {
        const arc = panels.launchArc();
        // Up from the floor's feet (1) to the ledge's (6), with room to step on.
        expect(arc.peak).toBeGreaterThanOrEqual(5.5);
        // Head under the roof: feet at most at level 1 + peak, a body 1.8 tall,
        // and the roof's first block at level `ROOF`.
        expect(1 + arc.peak + 1.8).toBeLessThan(model.ROOF);
        expect(panels.PAD_RISE).toBe(Math.floor(arc.peak));
        // Never hanging three seconds where flight is off: the game kicks at four.
        expect(arc.hanging).toBeLessThan(60);
        expect(arc.ticks).toBeLessThan(60);
        const all = Object.values(panels.FUNCTIONS).flat().join("\n");
        expect(all).not.toContain("slow_falling");
        expect(panels.FUNCTIONS.launch).toContain(
            `effect give @s minecraft:levitation ${panels.LAUNCH_SECONDS} ${panels.LAUNCH_AMPLIFIER} true`
        );
        // Once a stand, then a wait before the same player is thrown again.
        const tick = panels.FUNCTIONS.tick!.join("\n");
        expect(tick).toContain(
            `tag=${panels.PAD},distance=..0.7] unless score @s ${panels.PAD_WAIT} matches 1.. run function polaris:panel/launch`
        );
        expect(panels.FUNCTIONS.launch).toContain(
            `scoreboard players set @s ${panels.PAD_WAIT} ${panels.PAD_WAIT_TICKS}`
        );
        expect(panels.PAD_WAIT_TICKS).toBeGreaterThan(arc.ticks);
    });

    it("fires a lever once each time it is pulled, either way", () => {
        const lever = panels.FUNCTIONS.key_work!.filter((line) => line.includes("pe_key_lever"));
        expect(lever).toHaveLength(4);
        expect(lever[0]).toContain(
            `minecraft:lever[powered=true] unless score @s ${panels.COUNT} matches 1 run function polaris:panel/fire`
        );
        expect(lever[1]).toContain(
            `minecraft:lever[powered=false] unless score @s ${panels.COUNT} matches 0 run function polaris:panel/fire`
        );
        // The way it was, written after the fire, so the next look does not fire again.
        expect(lever[2]).toMatch(/powered=true\] run scoreboard players set @s polaris_kt 1$/);
        expect(lever[3]).toMatch(/powered=false\] run scoreboard players set @s polaris_kt 0$/);
    });

    it("is heard and seen where a panel opens or shuts", () => {
        const open = panels.FUNCTIONS.open!.join("\n");
        expect(open).toContain("playsound minecraft:block.piston.extend");
        expect(open).toContain("particle minecraft:cloud");
        expect(panels.FUNCTIONS.shut!.join("\n")).toContain(
            "playsound minecraft:block.piston.contract"
        );
    });
});
