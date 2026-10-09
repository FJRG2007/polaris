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
        for (const era of [model.NEWEST, model.OLDEST, { scaffold: true, snow: true, display: false }])
            for (let seed = 0; seed < 24; seed += 1) {
                const house = manor.manorFor(`run-${seed}`, 3, era);
                if (house.bare) plain += 1;
                expect(manor.manorProblems(house)).toEqual([]);
                for (const room of house.rooms) used.add(room.template);
            }
        expect(plain).toBe(0);
        expect([...used].sort()).toEqual([...rooms.TEMPLATES.map((one) => one.name), "foyer"].sort());
    });

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
        for (const spot of house.spots) expect(house.grid.inside(spot.x, spot.feet, spot.z)).toBe(true);
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
                    const distance = Math.hypot(key.from.x - panel.front.x, key.from.z - panel.front.z);
                    expect(distance).toBeGreaterThanOrEqual(manor.KEY_DISTANCE);
                    const steps = model.walk(house.grid, { x: key.from.x, feet: 1, z: key.from.z }, "seeker")[
                        house.grid.index(panel.front.x, panel.front.feet, panel.front.z)
                    ]!;
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

    it("mixes the keys: buttons, rugs, tiles to look up from, things to stare at", () => {
        const kinds = new Set<string>();
        for (let seed = 0; seed < 20; seed += 1)
            for (const key of manor.manorFor(`kinds-${seed}`, 3, model.NEWEST).keys)
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
        const nooks = Array.from({ length: 10 }, (_, seed) => manor.manorFor(`tall-${seed}`, 3, model.NEWEST).nooks).flat();
        expect(nooks.some((nook) => nook.tall)).toBe(true);
        expect(new Set(nooks.map((nook) => nook.entrance)).size).toBeGreaterThanOrEqual(4);
    });

    it("shows nothing a server cannot: no display blocks, powder snow or scaffolding before their release", () => {
        for (let seed = 0; seed < 10; seed += 1) {
            const house = manor.manorFor(`old-${seed}`, 3, model.OLDEST);
            expect(house.shown).toEqual([]);
            expect(manor.decorLines(box, house).some((line) => line.includes("block_display"))).toBe(false);
            const blocks = manor.manorBlocks(house);
            expect(blocks).not.toContain("minecraft:powder_snow");
            expect(blocks).not.toContain("minecraft:scaffolding");
            expect(blocks).not.toContain("minecraft:barrel");
            expect(house.rooms.some((room) => room.template === "snow")).toBe(false);
        }
        const shown = Array.from({ length: 10 }, (_, seed) => manor.manorFor(`new-${seed}`, 3, model.NEWEST));
        expect(shown.some((house) => house.shown.length > 0)).toBe(true);
    });

    it("keeps lava away from anything that burns, and only hiders cross it", () => {
        const house = Array.from({ length: 30 }, (_, seed) => manor.manorFor(`lava-${seed}`, 3, model.NEWEST)).find(
            (one) => one.rooms.some((room) => room.template === "forge")
        )!;
        expect(house).toBeDefined();
        expect(manor.manorProblems(house)).toEqual([]);
        // The pack sends a seeker in lava home and puts their fire out.
        expect(panels.FUNCTIONS.tick!.join("\n")).toContain("team=pe_hs_seek] at @s if block ~ ~ ~ minecraft:lava");
        expect(panels.FUNCTIONS.burnt).toContain("effect give @s minecraft:fire_resistance 6 0 true");
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
            for (const piece of arena.slices(one.box)) expect(arena.volume(piece)).toBeLessThanOrEqual(32_768);
        }
        // Water and lava after the stone round them; what hangs before what holds it.
        const fluid = fills.findIndex((one) => /water|lava/.test(one.block));
        const solidAfter = fills.slice(fluid).filter((one) => !/water|lava/.test(one.block));
        expect(solidAfter).toHaveLength(1);
        expect(fills.at(-1)!.box.x1).toBe(fills.at(-1)!.box.x2);
        const hung = /(_button|ladder|_banner|_door|_trapdoor|scaffolding)\[/;
        const firstOther = fills.findIndex((one, index) => index > 1 && !hung.test(one.block));
        expect(fills.slice(firstOther).some((one) => hung.test(one.block))).toBe(false);
        // Leaves that never wither.
        expect(fills.filter((one) => one.block.includes("leaves")).every((one) => one.block.includes("persistent=true"))).toBe(true);
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
        expect(lines.filter((line) => /replace minecraft:(lava|water)$/.test(line)).length).toBeGreaterThanOrEqual(2);
        for (const line of lines) expect(line.length).toBeLessThan(400);
    });

    it("hangs its paintings unbreakable, in both spellings, and shows its display blocks", () => {
        const lines = manor.decorLines(box, house);
        const paintings = lines.filter((line) => line.includes("summon minecraft:painting"));
        expect(paintings.length).toBe(house.paintings.length);
        expect(house.paintings.some((one) => one.door)).toBe(house.nooks.some((nook) => nook.entrance === "painting"));
        for (const line of paintings) {
            expect(line).toMatch(/\{Facing:\db,facing:\db,Motive:"minecraft:(wanderer|graham)",variant:"minecraft:(wanderer|graham)",Invulnerable:1b,Tags:\["pe_hs_deco"\]\}$/);
        }
        for (const line of lines.filter((one) => one.includes("block_display")))
            expect(line).toMatch(/summon minecraft:block_display -?\d+ \d+ -?\d+ \{block_state:\{Name:"minecraft:[a-z_]+"(,Properties:\{[^}]*\})?\},Tags:\["pe_hs_deco"\]\}$/);
        // A painting over a gap hangs on banners, which hold it up and let a player by.
        for (const one of house.paintings.filter((each) => each.door)) {
            const [dx, dz] = rooms.STEP[rooms.opposite(one.facing)];
            for (const level of [1, 2]) expect(house.grid.get(one.x + dx, level, one.z + dz)).toMatch(/white_wall_banner/);
        }
    });

    it("arms its panels and keys with their numbers and holds, and the seekers' way home", () => {
        const lines = manor.armLines(box, house, "world");
        expect(lines.filter((line) => line.includes('"pe_pnl"'))).toHaveLength(house.panels.length);
        expect(lines.filter((line) => line.includes('"pe_key"'))).toHaveLength(house.keys.length);
        expect(lines.some((line) => line.includes('"pe_hs_home"'))).toBe(true);
        for (const key of house.keys)
            expect(lines.some((line) => line.endsWith(`${panels.HOLD} ${key.hold}`))).toBe(true);
        expect(lines.some((line) => line.includes("scoreboard objectives add polaris_sneak minecraft.custom:minecraft.sneak_time"))).toBe(true);
        expect(manor.cageDown(box, house)).toMatch(/fill .* minecraft:air replace minecraft:barrier$/);
        // Every hider and seeker starts inside the box, on its floor.
        for (let index = 0; index < manor.MOST; index += 1) {
            const spot = manor.hiderSpot(box, house, index);
            expect(arena.contains(box, spot)).toBe(true);
            expect(spot.y).toBe(box.y1 + model.BASE + 1);
        }
    });
});

describe("the manor's data pack", () => {
    it("works panels and keys in commands every release from 1.13 reads", () => {
        const files = pack.packFiles();
        const tick = JSON.parse(files.get("data/minecraft/tags/functions/tick.json")!) as { values: string[] };
        expect(tick.values).toContain("polaris:panel/tick");
        const all = Object.values(panels.FUNCTIONS).flat();
        for (const line of all) {
            // Nothing newer than 1.13: no predicates, no macros, no display entity ids.
            expect(line).not.toMatch(/predicate=|\$\(|block_display|item_display|function_macro|\bon\b passengers/);
        }
        // Every function a line calls exists.
        for (const line of all)
            for (const [, name] of line.matchAll(/function polaris:panel\/(\w+)/g)) expect(panels.FUNCTIONS[name!]).toBeDefined();
        // Shut only when nobody touches the panel or a block round it.
        expect(panels.FUNCTIONS.work!.filter((line) => line.includes("unless entity @e[type=!minecraft:item"))).toHaveLength(2);
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
        expect(hs.fireproofLines("Ana")).toContain("effect give Ana minecraft:fire_resistance 6 0 true");
        const off = hs.effectsOff("Ana");
        for (const effect of hs.EFFECTS)
            expect(off).toContain(`effect clear @a[name=Ana,tag=${hs.FX_TAG}] minecraft:${effect}`);
        expect(off.at(-1)).toBe(`tag @a[name=Ana,tag=${hs.FX_TAG}] remove ${hs.FX_TAG}`);
        expect(hs.effectsOff()[0]).toBe(`effect clear @a[tag=${hs.FX_TAG}] minecraft:fire_resistance`);
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
