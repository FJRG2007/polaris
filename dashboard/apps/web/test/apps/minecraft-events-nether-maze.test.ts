/**
 * The deadly nether maze (`kinds/nether-maze`): its plan checked against its
 * rules over thousands of runs, a walk through the blocks it is built of from
 * the starting room to the middle, and the data pack that watches its hazards.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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

/** Blocks a player passes through: air, the door once open, a jet between flames. */
function passable(
    built: maze.Maze,
    blocks: ReadonlyMap<string, string>,
    x: number,
    y: number,
    z: number
) {
    const block = blocks.get(`${x},${y},${z}`);
    if (block === undefined || block === "minecraft:glass") return true;
    return (
        block === "minecraft:fire" &&
        built.jets.some((jet) => jet.x === x && jet.y === y && jet.z === z)
    );
}

/**
 * A walk through the world the boxes build, knowing nothing of the plan: a
 * player stands with their feet in a block whose block under is solid and not
 * magma, lava or fire, with two passable blocks for them. They step to a side
 * at the same height, jump a block up when there is head room for the jump,
 * drop off an edge to whatever is under it, or jump one block of lava. Answers
 * whether the goal is reached from the spawn.
 */
function walk(built: maze.Maze, blocks: ReadonlyMap<string, string>): boolean {
    const v = built.volume;
    const free = (x: number, y: number, z: number) => passable(built, blocks, x, y, z);
    const footing = (x: number, y: number, z: number) => {
        const under = blocks.get(`${x},${y - 1},${z}`);
        return (
            under !== undefined &&
            under !== "minecraft:magma_block" &&
            under !== "minecraft:lava" &&
            under !== "minecraft:fire" &&
            under !== "minecraft:glass"
        );
    };
    const stands = (x: number, y: number, z: number) =>
        footing(x, y, z) && free(x, y, z) && free(x, y + 1, z);
    /** Where somebody stepping into a column at `y` ends: down to the first footing. */
    const land = (x: number, y: number, z: number): number | null => {
        for (let h = y; h > v.y1; h -= 1) {
            if (!free(x, h, z) || !free(x, h + 1, z)) return null;
            if (blocks.get(`${x},${h},${z}`) === "minecraft:fire") return null;
            if (footing(x, h, z)) return h;
        }
        return null;
    };
    const start: [number, number, number] = [
        Math.floor(built.spawn.x),
        built.floor + 1,
        Math.floor(built.spawn.z)
    ];
    const seen = new Set<string>([start.join(",")]);
    const queue: [number, number, number][] = [start];
    const g = built.goal;
    for (let head = 0; head < queue.length; head += 1) {
        const [x, y, z] = queue[head]!;
        if (x >= g.x1 && x <= g.x2 && z >= g.z1 && z <= g.z2 && y === built.goalFloor + 1)
            return true;
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const nx = x + dx;
            const nz = z + dz;
            const next: [number, number, number][] = [];
            if (stands(nx, y, nz)) next.push([nx, y, nz]);
            else if (free(x, y + 2, z) && stands(nx, y + 1, nz)) next.push([nx, y + 1, nz]);
            else if (free(nx, y, nz) && free(nx, y + 1, nz)) {
                const at = land(nx, y, nz);
                if (at !== null) next.push([nx, at, nz]);
            }
            // One block of lava, jumped in a straight line.
            if (
                blocks.get(`${nx},${y - 1},${nz}`) === "minecraft:lava" &&
                free(nx, y, nz) &&
                free(nx, y + 1, nz) &&
                stands(x + 2 * dx, y, z + 2 * dz)
            )
                next.push([x + 2 * dx, y, z + 2 * dz]);
            for (const one of next) {
                if (seen.has(one.join(","))) continue;
                seen.add(one.join(","));
                queue.push(one);
            }
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
    }, 180_000);

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
                const tops = new Map<string, number>();
                for (const at of blocks.keys()) {
                    const [x, y, z] = at.split(",");
                    tops.set(`${x},${z}`, Math.max(tops.get(`${x},${z}`) ?? -Infinity, Number(y)));
                }
                for (const column of columns) {
                    const [x, z] = column.split(",");
                    expect(blocks.get(`${x},${tops.get(column)},${z}`), column).toMatch(
                        /netherrack|glowstone|sea_lantern/
                    );
                    expect(blocks.get(`${x},${Y - 1},${z}`), column).toBe("minecraft:netherrack");
                }
                expect(Math.max(...tops.values())).toBe(v.y2);
                // Lava and fire only ever over netherrack, never beside anything
                // that burns: everything round them is netherrack, lava, a light
                // or air in the maze.
                for (const [at, block] of blocks) {
                    if (block !== "minecraft:fire") continue;
                    const [x, y, z] = at.split(",").map(Number) as [number, number, number];
                    expect(blocks.get(`${x},${y - 1},${z}`)).toBe("minecraft:netherrack");
                }
                // The goal reads as a finish: gold and black chequered underfoot
                // and lit overhead from wall to wall, the way in chequered black
                // and white under light too, and the wall round it chequered -
                // and nowhere else is gold, chequered or lit like that.
                const g = built.goal;
                const G = built.goalFloor;
                const goalBlocks = (g.x2 - g.x1 + 1) * (g.z2 - g.z1 + 1);
                for (let x = g.x1; x <= g.x2; x += 1)
                    for (let z = g.z1; z <= g.z2; z += 1) {
                        expect(blocks.get(`${x},${G},${z}`)).toMatch(/gold_block|black_concrete/);
                        expect(blocks.get(`${x},${v.y2},${z}`)).toBe("minecraft:sea_lantern");
                    }
                const goldAndBlack = [g.x1, g.x1 + 1].map((x) => blocks.get(`${x},${G},${g.z1}`));
                expect(new Set(goldAndBlack).size).toBe(2);
                const lanterns = [...blocks.entries()].filter(
                    ([, block]) => block === "minecraft:sea_lantern"
                );
                const near = (at: string) => {
                    const [x, , z] = at.split(",").map(Number) as [number, number, number];
                    return x >= g.x1 - 1 && x <= g.x2 + 1 && z >= g.z1 - 1 && z <= g.z2 + 1;
                };
                expect(lanterns.length).toBeGreaterThan(goalBlocks);
                for (const [at] of lanterns) expect(near(at), at).toBe(true);
                for (const [at, block] of blocks)
                    if (/gold_block|black_concrete|white_concrete/.test(block))
                        expect(near(at), at).toBe(true);
                // Round the goal, side by side with it: chequered wall from the
                // floor to the roof, or a chequered way in.
                for (let x = g.x1 - 1; x <= g.x2 + 1; x += 1)
                    for (let z = g.z1 - 1; z <= g.z2 + 1; z += 1) {
                        const inside = x >= g.x1 && x <= g.x2 && z >= g.z1 && z <= g.z2;
                        const corner = (x < g.x1 || x > g.x2) && (z < g.z1 || z > g.z2);
                        if (inside || corner) continue;
                        if (blocks.has(`${x},${G + 1},${z}`)) {
                            for (let up = 1; up <= maze.HEADROOM; up += 1)
                                expect(blocks.get(`${x},${G + up},${z}`)).toMatch(
                                    /black_concrete|white_concrete/
                                );
                        } else
                            expect(blocks.get(`${x},${G},${z}`)).toMatch(
                                /black_concrete|white_concrete/
                            );
                    }
                // The middle is centred on the site.
                expect(Math.abs((built.goal.x1 + built.goal.x2) / 2 - SITE.x)).toBeLessThanOrEqual(
                    2
                );
                expect(Math.abs((built.goal.z1 + built.goal.z2) / 2 - SITE.z)).toBeLessThanOrEqual(
                    2
                );
            }
    }, 180_000);

    it("keeps a maze built before its finish booth exactly as it was built", () => {
        const before = maze.maze({ size: SIZES[0]!, hazards: "some" }, "old", SITE, Y, 1);
        const blocks = before.boxes.map((box) => box.block);
        expect(blocks).not.toContain("minecraft:black_concrete");
        expect(blocks).not.toContain("minecraft:white_concrete");
        const g = before.goal;
        const gold = before.boxes
            .filter((box) => box.block === "minecraft:gold_block")
            .reduce((sum, box) => sum + (box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1), 0);
        expect(gold).toBe((g.x2 - g.x1 + 1) * (g.z2 - g.z1 + 1));
    });

    it("builds a maze of an older design exactly as it was built then", () => {
        // What a run on design 1 or 2 built before floors and traps came in.
        const before: Record<string, string> = {
            "1 small": "c03d11865fe9273f",
            "1 medium": "150dc3fce4b4952e",
            "1 large": "3d2c99db2688b507",
            "2 small": "7cc63ac7a3a1ad8c",
            "2 medium": "b306d7af9bd8479f",
            "2 large": "b92ba43eacd3e877"
        };
        for (const design of [1, 2])
            for (const size of SIZES) {
                const built = maze.maze({ size, hazards: "many" }, "a", SITE, Y, design);
                const hash = createHash("sha256")
                    .update(JSON.stringify([built.boxes, built.goal, built.spawn, built.volume]))
                    .digest("hex")
                    .slice(0, 16);
                expect(hash, `${design} ${size}`).toBe(before[`${design} ${size}`]);
                expect(built.plan.levels).toHaveLength(1);
                expect(built.jets).toEqual([]);
                expect(built.landings).toEqual([]);
            }
    });

    it("stacks its floors, joined by a stair from a dead end, with the goal on top", () => {
        for (const size of SIZES)
            for (let seed = 0; seed < 30; seed += 1) {
                const built = maze.maze({ size, hazards: "some" }, `f-${seed}`, SITE, Y);
                const { levels, stairs } = built.plan;
                expect(levels).toHaveLength(maze.LEVELS[size]);
                expect(stairs).toHaveLength(levels.length - 1);
                expect(built.goalFloor).toBe(Y + (levels.length - 1) * maze.LEVEL_PITCH);
                expect(built.landings).toHaveLength(stairs.length);
                const blocks = blocksOf(built.boxes);
                stairs.forEach((stair, index) => {
                    // Its steps a block higher each, the top level with the next floor.
                    const base = Y + stair.level * maze.LEVEL_PITCH;
                    maze.stepsOf(stair).forEach(([x, z], step) => {
                        const wx = x + built.origin.x;
                        const wz = z + built.origin.z;
                        if (step > 0)
                            expect(blocks.get(`${wx},${base + step},${wz}`)).toBe(
                                "minecraft:nether_bricks"
                            );
                        expect(blocks.get(`${wx},${base + step + 1},${wz}`)).toBeUndefined();
                        expect(blocks.get(`${wx},${base + step + 2},${wz}`)).toBeUndefined();
                    });
                    // The landing is the top of the stair, on the floor over it.
                    const landing = built.landings[index]!;
                    expect(landing.y).toBe(base + maze.LEVEL_PITCH + 1);
                    expect(maze.levelAt(built, landing.y)).toBe(stair.level + 1);
                });
            }
    }, 180_000);

    it("sets traps: jets across doorways and soul sand, never a hazard round a stair", () => {
        let jets = 0;
        let soul = 0;
        for (let seed = 0; seed < 40; seed += 1) {
            const built = maze.maze({ size: "large", hazards: "many" }, `t-${seed}`, SITE, Y);
            jets += built.jets.length;
            soul += built.boxes.filter((box) => box.block === "minecraft:soul_sand").length;
            const blocks = blocksOf(built.boxes);
            // A jet's flame is put down with the maze, over netherrack, where
            // the pack lights it again.
            for (const jet of built.jets) {
                expect(blocks.get(`${jet.x},${jet.y},${jet.z}`)).toBe("minecraft:fire");
                expect(blocks.get(`${jet.x},${jet.y - 1},${jet.z}`)).toBe("minecraft:netherrack");
            }
        }
        expect(jets).toBeGreaterThan(0);
        expect(soul).toBeGreaterThan(0);
        // Soul sand is short of a block: whoever stands on it upstairs is
        // still on that floor, and measured on it.
        let upstairs = 0;
        for (let seed = 0; seed < 40; seed += 1) {
            const built = maze.maze({ size: "large", hazards: "many" }, `t-${seed}`, SITE, Y);
            for (const box of built.boxes) {
                if (box.block !== "minecraft:soul_sand" || box.y1 === Y) continue;
                const level = (box.y1 - Y) / maze.LEVEL_PITCH;
                const on = {
                    x: Math.min(box.x1, box.x2) + 0.5,
                    y: box.y1 + 0.875,
                    z: Math.min(box.z1, box.z2) + 0.5
                };
                expect(maze.levelAt(built, on.y)).toBe(level);
                expect(maze.progressAt(built, on)).toBe(
                    maze.progressAt(built, { ...on, y: box.y1 + 1 })
                );
                upstairs += 1;
            }
        }
        expect(upstairs).toBeGreaterThan(0);
        // Every rule broken by a hazard in the room a stair comes up into.
        const plan = maze.plan({ size: "medium", hazards: "some" }, "stairs");
        const stair = plan.stairs[0]!;
        const tiles = new Map(plan.levels[1]!.tiles);
        tiles.set(`${maze.roomStart(stair.cx) + 1},${maze.roomStart(stair.cz) + 1}`, "fire");
        const levels = [plan.levels[0]!, { ...plan.levels[1]!, tiles }, ...plan.levels.slice(2)];
        expect(maze.mazeProblems({ ...plan, levels }).join("\n")).toMatch(
            /by the stairs|by the start/
        );
    });

    it("can be walked from the starting room to the middle on the blocks it is built of", () => {
        for (const size of SIZES)
            for (const level of HAZARDS)
                for (let seed = 0; seed < 40; seed += 1) {
                    for (const design of [2, maze.DESIGN]) {
                        const built = maze.maze(
                            { size, hazards: level },
                            `w-${seed}`,
                            SITE,
                            Y,
                            design
                        );
                        expect(
                            walk(built, blocksOf(built.boxes)),
                            `${size} ${level} ${seed} ${design}`
                        ).toBe(true);
                    }
                }
    }, 180_000);

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
        expect(
            maze.progressAt(built, {
                x: built.goal.x1 + 1.5,
                y: built.goalFloor + 1,
                z: built.goal.z1 + 1.5
            })
        ).toBe(maze.roomsToGo(built));
        // The middle of the ground floor is not the goal of a maze of floors.
        expect(
            maze.progressAt(built, { x: built.goal.x1 + 1.5, y: Y + 1, z: built.goal.z1 + 1.5 })
        ).toBeLessThan(maze.roomsToGo(built));
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
        // On a floor over the ground one, back to the top of its stair.
        expect(fn("back")[1]).toBe(
            `execute if score #py polaris_maze >= #up1 polaris_maze run tp @s @e[type=minecraft:armor_stand,tag=${maze.LANDING_TAG}1,limit=1]`
        );
    });

    it("lights the jets on a beat, warns before they light, and only where nothing stands", () => {
        expect(fn("tick")[1]).toContain(`tag=${maze.JET_TAG}`);
        const jets = fn("jets").join("\n");
        expect(jets).toContain("%= #jp polaris_maze");
        expect(jets).toContain(
            "matches 0 as @e[type=minecraft:armor_stand,tag=polaris_maze_jet] at @s run setblock ~ ~ ~ minecraft:fire keep"
        );
        expect(jets).toContain(`matches ${maze.JET_PERIOD / 2} as`);
        expect(jets).toContain("particle minecraft:flame");
    });

    it("hides every racer's name tag and keeps them from pushing, on a team of their own", () => {
        expect(maze.SCORES_ADDED).toContain(
            `team modify ${maze.RACERS_TEAM} nametagVisibility never`
        );
        expect(maze.SCORES_ADDED).toContain(`team modify ${maze.RACERS_TEAM} collisionRule never`);
        expect(maze.SCORES_REMOVED).toContain(`team remove ${maze.RACERS_TEAM}`);
        expect(maze.racerScores("Ana")).toContain(
            `execute if entity @a[name=Ana,team=] run team join ${maze.RACERS_TEAM} Ana`
        );
        expect(maze.leaveTeam("Ana")).toBe(
            `execute if entity @a[name=Ana,team=${maze.RACERS_TEAM}] run team leave Ana`
        );
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
        // Its stands: the start, a landing a floor, a jet a doorway - every
        // one taken away at the end.
        const big = maze.maze({ size: "large", hazards: "many" }, "arm-1", SITE, Y);
        const armed = maze.armLines(big);
        const summoned = armed.filter((line) => line.includes("summon"));
        expect(summoned).toHaveLength(1 + big.landings.length + big.jets.length);
        expect(armed).toContain(
            `scoreboard players set #up1 polaris_maze ${big.landings[0]!.y * 64 - 16}`
        );
        // Two floors: no third to go back to.
        expect(maze.armLines(one)).toContain("scoreboard players set #up2 polaris_maze 2147483647");
        expect(armed).toContain(
            `scoreboard players set #gy1 polaris_maze ${(big.goalFloor + 1) * 64 - 16}`
        );
        for (const tag of [
            maze.START_TAG,
            maze.JET_TAG,
            `${maze.LANDING_TAG}1`,
            `${maze.LANDING_TAG}2`
        ])
            expect(maze.stopLines(big.boxes).some((line) => line.endsWith(`tag=${tag}]`))).toBe(
                true
            );
        expect(maze.isMaze(one.boxes)).toBe(true);
        expect(maze.isMaze([{ block: "minecraft:packed_ice" }])).toBe(false);
    });
});

describe("what a maze says", () => {
    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const) {
            for (const line of [
                said.readySubtitle(language),
                said.readySubtitle(language, 3),
                said.goSubtitle(language),
                said.goSubtitle(language, 2),
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
