/**
 * The deadly nether maze (`kinds/nether-maze`): its plan checked against its
 * rules over thousands of runs, a walk through the blocks it is built of from
 * the starting room to the middle, and the data pack that watches its hazards.
 */

import { describe, expect, it } from "vitest";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as radar from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/radar";
import * as maze from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/nether-maze";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/nether-maze-messages";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SIZES = catalog.MAZE_SIZES;
const HAZARDS = catalog.MAZE_HAZARDS;
const SITE = { x: 100, z: -200 };
const Y = 120;

/** Every block a maze's boxes put down, by `x,y,z`; a block put twice throws. */
function blocksOf(boxes: readonly stage.Box[]): Map<string, string> {
    const blocks = new Map<string, string>();
    for (const box of boxes)
        for (let x = Math.min(box.x1, box.x2); x <= Math.max(box.x1, box.x2); x += 1)
            for (let y = Math.min(box.y1, box.y2); y <= Math.max(box.y1, box.y2); y += 1)
                for (let z = Math.min(box.z1, box.z2); z <= Math.max(box.z1, box.z2); z += 1) {
                    const at = `${x},${y},${z}`;
                    if (blocks.has(at)) throw new Error(`${at} put twice`);
                    blocks.set(at, box.block);
                }
    return blocks;
}

/**
 * A walk through the world the boxes build, knowing nothing of the plan: a
 * player stands on a column whose floor is solid and not magma, with two
 * blocks of air (not fire) over it; they step to a side's column, or jump one
 * column of lava onto the one beyond it. Answers whether the middle room is
 * reached from the spawn, and every hazard walked onto.
 */
function walk(built: maze.Maze, blocks: ReadonlyMap<string, string>): boolean {
    const floor = built.floor;
    const at = (x: number, y: number, z: number) => blocks.get(`${x},${y},${z}`);
    const stands = (x: number, z: number) => {
        const under = at(x, floor, z);
        return (
            under !== undefined &&
            under !== "minecraft:magma_block" &&
            under !== "minecraft:lava" &&
            (at(x, floor + 1, z) === undefined || at(x, floor + 1, z) === "minecraft:glass") &&
            (at(x, floor + 2, z) === undefined || at(x, floor + 2, z) === "minecraft:glass")
        );
    };
    const start = [Math.floor(built.spawn.x), Math.floor(built.spawn.z)] as const;
    const seen = new Set<string>([start.join(",")]);
    const queue: (readonly [number, number])[] = [start];
    for (let head = 0; head < queue.length; head += 1) {
        const [x, z] = queue[head]!;
        if (x >= built.goal.x1 && x <= built.goal.x2 && z >= built.goal.z1 && z <= built.goal.z2)
            return true;
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            // The door is open once the race is on: glass counts as air here.
            const near = [x + dx, z + dz] as const;
            const beyond = [x + 2 * dx, z + 2 * dz] as const;
            const next = stands(...near)
                ? near
                : at(...([near[0], floor, near[1]] as [number, number, number])) ===
                        "minecraft:lava" &&
                    at(near[0], floor + 1, near[1]) === undefined &&
                    stands(...beyond)
                  ? beyond
                  : null;
            if (!next || seen.has(next.join(","))) continue;
            seen.add(next.join(","));
            queue.push(next);
        }
    }
    return false;
}

describe("a deadly nether maze", () => {
    it("keeps every rule over thousands of runs, every size and every number of hazards", () => {
        let hazards = 0;
        for (const size of SIZES)
            for (const level of HAZARDS)
                for (let seed = 0; seed < 300; seed += 1) {
                    const plan = maze.plan({ size, hazards: level }, `run-${seed}`);
                    expect(maze.mazeProblems(plan), `${size} ${level} ${seed}`).toEqual([]);
                    hazards += plan.hazards;
                }
        expect(hazards).toBeGreaterThan(0);
    });

    it("lays out the same maze for the same run, and another for another", () => {
        const one = maze.plan({ size: "medium", hazards: "some" }, "same");
        const again = maze.plan({ size: "medium", hazards: "some" }, "same");
        const other = maze.plan({ size: "medium", hazards: "some" }, "other");
        expect([...again.tiles]).toEqual([...one.tiles]);
        expect([...other.tiles]).not.toEqual([...one.tiles]);
    });

    it("gets more hazards as it is asked for more", () => {
        const count = (level: (typeof HAZARDS)[number]) =>
            Array.from({ length: 50 }, (_, seed) =>
                maze.plan({ size: "large", hazards: level }, `h-${seed}`)
            ).reduce((sum, plan) => sum + plan.hazards, 0);
        expect(count("few")).toBeLessThan(count("some"));
        expect(count("some")).toBeLessThan(count("many"));
    });

    it("finds a cut-off room or a wall one block thick, should a plan ever have one", () => {
        const plan = maze.plan({ size: "small", hazards: "few" }, "broken");
        const walled = new Map(plan.tiles);
        // Every way out of the starting room filled with magma.
        for (const [at, tile] of walled) if (tile === "door") walled.set(at, "magma");
        expect(maze.mazeProblems({ ...plan, tiles: walled })).not.toEqual([]);
        expect(
            maze
                .mazeProblems({
                    ...plan,
                    tiles: new Map(
                        [...plan.tiles].map(([at, tile]) => [at, tile === "door" ? "floor" : tile])
                    ).set(`${maze.roomStart(0) - 1},${maze.roomStart(0)}`, "floor")
                })
                .some((one) => one.includes("one block thick"))
        ).toBe(true);
    });

    it("is built of boxes that never share a block, inside its volume, of arena blocks only", () => {
        for (const size of SIZES)
            for (let seed = 0; seed < 20; seed += 1) {
                const built = maze.maze({ size, hazards: "many" }, `b-${seed}`, SITE, Y);
                const blocks = blocksOf(built.boxes);
                const v = built.volume;
                for (const box of built.boxes) {
                    expect(stage.ARENA_BLOCKS).toContain(box.block);
                    expect(stage.volumeOf(box)).toBeLessThanOrEqual(stage.FILL_LIMIT);
                    expect(Math.min(box.x1, box.x2)).toBeGreaterThanOrEqual(v.x1);
                    expect(Math.max(box.x1, box.x2)).toBeLessThanOrEqual(v.x2);
                    expect(Math.min(box.y1, box.y2)).toBeGreaterThanOrEqual(v.y1);
                    expect(Math.max(box.y1, box.y2)).toBeLessThanOrEqual(v.y2);
                    expect(Math.min(box.z1, box.z2)).toBeGreaterThanOrEqual(v.z1);
                    expect(Math.max(box.z1, box.z2)).toBeLessThanOrEqual(v.z2);
                }
                // A solid roof, and a solid floor under it, over every column built.
                const columns = new Set(
                    [...blocks.keys()].map((at) => {
                        const [x, , z] = at.split(",");
                        return `${x},${z}`;
                    })
                );
                for (const column of columns) {
                    const [x, z] = column.split(",");
                    expect(blocks.get(`${x},${v.y2},${z}`), column).toMatch(/netherrack|glowstone/);
                    expect(blocks.get(`${x},${Y - 1},${z}`), column).toBe("minecraft:netherrack");
                }
                // Lava and fire only ever over netherrack, never beside anything
                // that burns: everything round them is netherrack, lava, a light
                // or air in the maze.
                for (const [at, block] of blocks) {
                    if (block !== "minecraft:fire") continue;
                    const [x, y, z] = at.split(",").map(Number) as [number, number, number];
                    expect(blocks.get(`${x},${y - 1},${z}`)).toBe("minecraft:netherrack");
                }
                // The middle is centred on the site.
                expect(Math.abs((built.goal.x1 + built.goal.x2) / 2 - SITE.x)).toBeLessThanOrEqual(
                    2
                );
                expect(Math.abs((built.goal.z1 + built.goal.z2) / 2 - SITE.z)).toBeLessThanOrEqual(
                    2
                );
            }
    });

    it("can be walked from the starting room to the middle on the blocks it is built of", () => {
        for (const size of SIZES)
            for (const level of HAZARDS)
                for (let seed = 0; seed < 40; seed += 1) {
                    const built = maze.maze({ size, hazards: level }, `w-${seed}`, SITE, Y);
                    expect(walk(built, blocksOf(built.boxes)), `${size} ${level} ${seed}`).toBe(
                        true
                    );
                }
    });

    it("starts everybody in the starting room, facing the door, behind the glass", () => {
        const built = maze.maze({ size: "small", hazards: "some" }, "spots", SITE, Y);
        const spots = maze.spots(built, 12);
        for (const spot of spots) expect(maze.inStart(built, spot)).toBe(true);
        expect(maze.inStart(built, { x: built.goal.x1 + 1, y: Y + 1, z: built.goal.z1 + 1 })).toBe(
            false
        );
        expect(built.door.block).toBe("minecraft:glass");
        expect(built.boxes).toContain(built.door);
        expect(maze.doorGone(built)).toMatch(/ minecraft:air replace minecraft:glass$/);
        // Progress: nothing in the starting room, all of it in the middle.
        expect(maze.progressAt(built, spots[0]!)).toBeNull();
        expect(maze.progressAt(built, { x: built.goal.x1 + 1.5, z: built.goal.z1 + 1.5 })).toBe(
            maze.roomsToGo(built)
        );
        expect(maze.roomsToGo(built)).toBeGreaterThanOrEqual(3);
    });
});

describe("the maze's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/maze/${name}.mcfunction`)!.trimEnd().split("\n");

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"])
            expect(files.has(`data/polaris/${folder}/maze/tick.mcfunction`)).toBe(true);
        expect(files.get("data/minecraft/tags/function/tick.json")).toContain("polaris:maze/tick");
    });

    it("sends a racer in fire, in lava or on magma back to the start, and notes the finish", () => {
        expect(fn("tick")[0]).toContain("scores={pe_mfin=0}");
        const racer = fn("racer").join("\n");
        expect(racer).toContain("if block ~ ~ ~ minecraft:fire run function polaris:maze/back");
        expect(racer).toContain("if block ~ ~ ~ minecraft:lava run function polaris:maze/back");
        expect(racer).toContain(
            "if block ~ ~-0.5 ~ minecraft:magma_block run function polaris:maze/back"
        );
        expect(fn("back")[0]).toBe(
            `tp @s @e[type=minecraft:armor_stand,tag=${maze.START_TAG},limit=1]`
        );
        expect(fn("done")[0]).toContain("time query gametime");
    });

    it("is armed for one maze, switch last, and only that maze's end switches it off", () => {
        const one = maze.maze({ size: "small", hazards: "some" }, "arm", SITE, Y);
        const other = maze.maze({ size: "small", hazards: "some" }, "arm", { x: 900, z: 900 }, Y);
        const arm = maze.armLines(one);
        expect(arm.at(-1)).toBe("scoreboard players set #on polaris_maze 1");
        expect(arm.indexOf("scoreboard players set #on polaris_maze 0")).toBeLessThan(
            arm.findIndex((line) => line.includes("summon"))
        );
        expect(maze.stopLines(one.boxes)).not.toEqual(maze.stopLines(other.boxes));
        expect(maze.stopLines(one.boxes).at(-1)).toContain(
            `if score #sx1 polaris_maze matches ${one.volume.x1 * 64}`
        );
        expect(maze.stopLines([])).toEqual([]);
        expect(maze.isMaze(one.boxes)).toBe(true);
        expect(maze.isMaze([{ block: "minecraft:packed_ice" }])).toBe(false);
    });
});

describe("what a maze says", () => {
    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const) {
            for (const line of [
                said.readySubtitle(language),
                said.goSubtitle(language),
                said.bar(3, 9, language),
                said.burned(language),
                said.radarOff(language),
                said.cannotPlay(language)
            ])
                expect(line.length).toBeGreaterThan(5);
        }
        expect(said.burned("es")).not.toBe(said.burned("en"));
        const built = maze.maze({ size: "large", hazards: "many" }, "size", SITE, Y);
        for (const line of [
            ...built.boxes.map(stage.buildLine),
            ...maze.armLines(built),
            radar.radarLine("Ana", radar.RADAR_OFF, said.radarOff)
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });

    it("shares hide and seek's minimap codes", () => {
        expect(hs.RADAR_OFF).toBe(radar.RADAR_OFF);
        expect(hs.RADAR_RESET).toBe(radar.RADAR_RESET);
        expect(radar.radarLine("Ana", radar.RADAR_RESET)).toContain("\\u00a7r\\u00a7e\\u00a7s");
    });
});
