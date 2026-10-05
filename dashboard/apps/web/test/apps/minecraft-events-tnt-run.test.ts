/**
 * A TNT run's arena and the data pack that takes its floor away
 * (`kinds/tnt-run`): checked block by block for every size and number of
 * floors an event can be set to, and line by line for what the pack does.
 */

import { describe, expect, it } from "vitest";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run-messages";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as spleef from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/spleef";
import * as tntRun from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/tnt-run";
import * as snowballPack from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/snowball-pack";

const SIZES = Array.from({ length: 11 }, (_, index) => index + 5);
const LAYERS = [2, 3, 4];

const arenaOf = (size: number, layers: number, site = { x: 40, z: -12 }, y = 120) =>
    tntRun.arena({ size, layers }, site, y);

/** Every block of an arena, by `x y z`, and what is there - failing on a block
 *  two boxes both claim. */
function blocksOf(arena: tntRun.TntArena): Map<string, string> {
    const found = new Map<string, string>();
    for (const box of arena.boxes)
        for (let x = box.x1; x <= box.x2; x += 1)
            for (let y = box.y1; y <= box.y2; y += 1)
                for (let z = box.z1; z <= box.z2; z += 1) {
                    const key = `${x} ${y} ${z}`;
                    expect(found.has(key), `${key} is in two boxes`).toBe(false);
                    found.set(key, box.block);
                }
    return found;
}

describe("a TNT run arena", () => {
    it("keeps its rules at every size and number of floors", () => {
        let checked = 0;
        for (const size of SIZES)
            for (const layers of LAYERS) {
                const arena = arenaOf(size, layers);
                const blocks = blocksOf(arena);
                const { x: cx, z: cz } = arena.center;
                const outer = size + 1;
                const top = arena.floors[0]!;
                const bottom = arena.floors.at(-1)!;
                expect(arena.floors).toHaveLength(layers);
                // Every box inside the volume, and every block one an arena may
                // use - so the end can take it out again.
                for (const box of arena.boxes) {
                    expect(box.x1).toBeGreaterThanOrEqual(arena.volume.x1);
                    expect(box.x2).toBeLessThanOrEqual(arena.volume.x2);
                    expect(box.y1).toBeGreaterThanOrEqual(arena.volume.y1);
                    expect(box.y2).toBeLessThanOrEqual(arena.volume.y2);
                    expect(box.z1).toBeGreaterThanOrEqual(arena.volume.z1);
                    expect(box.z2).toBeLessThanOrEqual(arena.volume.z2);
                    expect(stage.ARENA_BLOCKS).toContain(box.block);
                    expect(stage.volumeOf(box)).toBeLessThanOrEqual(stage.FILL_LIMIT);
                }
                for (const [index, at] of arena.floors.entries()) {
                    // Each floor is TNT, edge to edge, and nothing else inside the
                    // walls at its height: the only ledge there is is TNT.
                    for (let x = cx - size; x <= cx + size; x += 1)
                        for (let z = cz - size; z <= cz + size; z += 1)
                            expect(blocks.get(`${x} ${at} ${z}`)).toBe(tntRun.FLOOR);
                    // Head room over each floor: nothing but air up to the next.
                    const ceiling = index === 0 ? arena.volume.y2 + 1 : arena.floors[index - 1]!;
                    expect(ceiling - at - 1).toBeGreaterThanOrEqual(3);
                    for (let y = at + 1; y < ceiling; y += 1)
                        for (let x = cx - size; x <= cx + size; x += 1)
                            for (let z = cz - size; z <= cz + size; z += 1)
                                expect(blocks.has(`${x} ${y} ${z}`)).toBe(false);
                    // Its rim is its own color, lit at the corners.
                    const rim = blocks.get(`${cx} ${at} ${cz - outer}`);
                    expect(rim).toMatch(/_concrete$/);
                    if (index > 0)
                        expect(rim).not.toBe(
                            blocks.get(`${cx} ${arena.floors[index - 1]!} ${cz - outer}`)
                        );
                    expect(blocks.get(`${cx - outer} ${at} ${cz - outer}`)).toBe(
                        "minecraft:sea_lantern"
                    );
                }
                // The wall is whole all round, from the lowest rim to above the
                // top floor: nobody walks or falls out sideways, and there is no
                // top of a wall to land on between two floors.
                for (let y = bottom; y <= top + 3; y += 1)
                    for (let i = -outer; i <= outer; i += 1)
                        for (const [x, z] of [
                            [cx + i, cz - outer],
                            [cx + i, cz + outer],
                            [cx - outer, cz + i],
                            [cx + outer, cz + i]
                        ])
                            expect(blocks.has(`${x} ${y} ${z}`), `${x} ${y} ${z}`).toBe(true);
                // The net catches whoever falls through the lowest floor, edge to edge.
                const net = arena.boxes[0]!;
                expect(net.block).toBe("minecraft:white_stained_glass");
                expect(net.y1).toBeLessThan(bottom - 1);
                expect([net.x1, net.x2, net.z1, net.z2]).toEqual([
                    cx - outer,
                    cx + outer,
                    cz - outer,
                    cz + outer
                ]);
                // Built from the bottom up.
                const heights = arena.boxes.map((box) => box.y1);
                expect(heights.indexOf(bottom)).toBeLessThan(heights.indexOf(top));
                // Started on the top floor, inside the walls, never on one.
                for (const spot of spleef.spots(arena, 16)) {
                    expect(spot.y).toBe(top + 1);
                    expect(Math.abs(spot.x - 0.5 - cx)).toBeLessThanOrEqual(size);
                    expect(Math.abs(spot.z - 0.5 - cz)).toBeLessThanOrEqual(size);
                }
                // Out only through the lowest floor.
                expect(spleef.fell(arena, bottom + 1)).toBe(false);
                expect(spleef.fell(arena, arena.floors[0]! - 3)).toBe(false);
                expect(spleef.fell(arena, bottom - 3)).toBe(true);
                checked += 1;
            }
        expect(checked).toBe(SIZES.length * LAYERS.length);
    });

    it("tells which floor somebody is on, counted from the top", () => {
        const arena = arenaOf(8, 3);
        const [top, middle, bottom] = arena.floors as [number, number, number];
        expect(tntRun.floorOf(arena, top + 1)).toBe(1);
        expect(tntRun.floorOf(arena, top + 2.3)).toBe(1);
        expect(tntRun.floorOf(arena, top - 2)).toBe(2);
        expect(tntRun.floorOf(arena, middle + 1)).toBe(2);
        expect(tntRun.floorOf(arena, bottom + 1)).toBe(3);
        expect(tntRun.floorOf(arena, bottom - 3)).toBe(3);
    });
});

describe("the TNT run's data pack", () => {
    const files = snowballPack.packFiles();
    const fn = (name: string) =>
        files.get(`data/polaris/function/tntrun/${name}.mcfunction`)!.trimEnd().split("\n");

    it("is part of the events pack, in both spellings of the function folders", () => {
        for (const folder of ["functions", "function"]) {
            expect(
                JSON.parse(files.get(`data/minecraft/tags/${folder}/tick.json`)!).values
            ).toContain("polaris:tntrun/tick");
            for (const name of Object.keys(tntRun.FUNCTIONS))
                expect(files.get(`data/polaris/${folder}/tntrun/${name}.mcfunction`)).toBe(
                    `${tntRun.FUNCTIONS[name]!.join("\n")}\n`
                );
        }
        expect(fn("tick")).toEqual([
            "execute if score #on polaris_tntrun matches 1 run function polaris:tntrun/run"
        ]);
    });

    it("lights a fuse under each corner of a player's feet, and only on the arena's TNT", () => {
        // Inside the floors' box only.
        expect(fn("player").at(-1)).toBe(
            "execute if score #px polaris_tntrun >= #x1 polaris_tntrun if score #px polaris_tntrun <= #x2 polaris_tntrun if score #py polaris_tntrun >= #y1 polaris_tntrun if score #py polaris_tntrun <= #y2 polaris_tntrun if score #pz polaris_tntrun >= #z1 polaris_tntrun if score #pz polaris_tntrun <= #z2 polaris_tntrun at @s run function polaris:tntrun/under"
        );
        const under = fn("under");
        const corners = under.filter((line) => line.includes("summon"));
        expect(corners.map((line) => /positioned (~\S+ ~\S+ ~\S+) align/.exec(line)![1])).toEqual([
            "~0.3 ~-0.5 ~0.3",
            "~0.3 ~-0.5 ~-0.3",
            "~-0.3 ~-0.5 ~0.3",
            "~-0.3 ~-0.5 ~-0.3"
        ]);
        for (const line of corners) {
            expect(line).toContain(" if block ~ ~ ~ minecraft:tnt ");
            // One fuse a block.
            expect(line).toContain(
                " unless entity @e[type=minecraft:armor_stand,tag=polaris_tnt_fuse,distance=..0.5] "
            );
        }
        expect(under).toContain(
            `scoreboard players set @e[type=minecraft:armor_stand,tag=polaris_tnt_new] polaris_tntrun ${tntRun.FUSE_TICKS}`
        );
        // Between 0.3 and 0.5 seconds: TNT Run's pace.
        expect(tntRun.FUSE_TICKS).toBeGreaterThanOrEqual(6);
        expect(tntRun.FUSE_TICKS).toBeLessThanOrEqual(10);
    });

    it("notes the game tick each racer first goes under the lowest floor, once", () => {
        expect(fn("player")).toContain(
            "execute unless score @s polaris_tntrun matches 1.. if score #py polaris_tntrun < #fy polaris_tntrun store result score @s polaris_tntrun run time query gametime"
        );
        const arena = arenaOf(15, 3, { x: 0, z: 0 }, 100);
        const bottom = arena.floors.at(-1)!;
        const arm = tntRun.armLines(arena);
        // Out where `spleef.fell` puts them out: half a block into the lowest floor.
        expect(arm).toContain(`scoreboard players set #fy polaris_tntrun ${bottom * 64 + 32}`);
        // Nobody's fall of an earlier run kept, before the switch goes on.
        expect(arm.indexOf("scoreboard players reset @a polaris_tntrun")).toBeLessThan(
            arm.indexOf("scoreboard players set #on polaris_tntrun 1")
        );
        expect(tntRun.racerLines("Ana")).toEqual(["scoreboard players reset Ana polaris_tntrun"]);
    });

    it("tells apart who went out on one look by the tick they fell, the last alone still standing", () => {
        const fell = new Map([
            ["ana", 100],
            ["ben", 110],
            ["cy", 100]
        ]);
        // The last two (and Cy) out on one look: Ben fell last, alone - he won.
        expect(tntRun.fallOrder(["Ana", "Ben", "Cy"], fell, 0)).toEqual({
            groups: [["Ana", "Cy"]],
            survivor: "Ben"
        });
        // Somebody else still standing: nobody survives, they go out in order.
        expect(tntRun.fallOrder(["Ben", "Ana"], fell, 1)).toEqual({
            groups: [["Ana"], ["Ben"]],
            survivor: null
        });
        // Fell on the same tick: the same place, and nobody left standing.
        expect(tntRun.fallOrder(["Ana", "Cy"], fell, 0)).toEqual({
            groups: [["Ana", "Cy"]],
            survivor: null
        });
        // Somebody who left (no tick) went first; a faller alone after them wins.
        expect(tntRun.fallOrder(["Ben", "Dee"], fell, 0)).toEqual({
            groups: [["Dee"]],
            survivor: "Ben"
        });
    });

    it("takes a block only when its fuse runs out, only if it is still TNT, and burns the fuse down first", () => {
        const run = fn("run");
        expect(run[0]).toBe(
            "scoreboard players remove @e[type=minecraft:armor_stand,tag=polaris_tnt_fuse] polaris_tntrun 1"
        );
        expect(run.findIndex((line) => line.includes("tntrun/drop"))).toBeLessThan(
            run.findIndex((line) => line.includes("tntrun/player"))
        );
        expect(fn("drop")[0]).toBe("fill ~ ~ ~ ~ ~ ~ minecraft:air replace minecraft:tnt");
        expect(fn("drop").at(-1)).toBe("kill @s");
    });

    it("puts out any TNT lit near the arena, and never sets one off or places one", () => {
        expect(fn("run")).toContain(
            "execute in minecraft:overworld as @e[type=minecraft:tnt,distance=0..] run function polaris:tntrun/primed"
        );
        expect(fn("primed").at(-1)).toMatch(
            /if score #pz polaris_tntrun <= #nz2 polaris_tntrun run kill @s$/
        );
        for (const lines of Object.values(tntRun.FUNCTIONS))
            for (const line of lines) {
                // Nothing that burns, powers or explodes; TNT is only ever taken out.
                expect(line).not.toMatch(
                    /fire|lava|redstone|explo|flint|setblock|summon minecraft:tnt/
                );
                if (line.includes("minecraft:tnt") && line.startsWith("fill"))
                    expect(line).toContain("minecraft:air replace minecraft:tnt");
                expect(line.length).toBeLessThan(32_500);
            }
        const volume = arenaOf(6, 2).volume;
        expect(tntRun.primedOut(volume)).toBe(
            `execute in minecraft:overworld run kill @e[type=minecraft:tnt,x=${volume.x1 - 4},y=${volume.y1 - 4},z=${volume.z1 - 4},dx=${volume.x2 - volume.x1 + 8},dy=${volume.y2 - volume.y1 + 8},dz=${volume.z2 - volume.z1 + 8}]`
        );
    });

    it("is armed for one arena's floors, switch last, and only that arena's end switches it off", () => {
        const arena = arenaOf(5, 3, { x: -3, z: 40 }, 100);
        const lines = tntRun.armLines(arena);
        const bottom = arena.floors.at(-1)!;
        expect(lines[0]).toBe("scoreboard objectives add polaris_tntrun dummy");
        expect(lines[1]).toBe("scoreboard players set #on polaris_tntrun 0");
        expect(lines).toContain(`scoreboard players set #x1 polaris_tntrun ${-8 * 64}`);
        expect(lines).toContain(`scoreboard players set #x2 polaris_tntrun ${3 * 64 - 1}`);
        expect(lines).toContain(`scoreboard players set #y1 polaris_tntrun ${bottom * 64}`);
        expect(lines).toContain(`scoreboard players set #y2 polaris_tntrun ${104 * 64 - 1}`);
        expect(lines).toContain(`scoreboard players set #z1 polaris_tntrun ${35 * 64}`);
        expect(lines).toContain(`scoreboard players set #z2 polaris_tntrun ${46 * 64 - 1}`);
        // Fuses an old game left are out before it goes on.
        expect(lines).toContain("kill @e[type=minecraft:armor_stand,tag=polaris_tnt_fuse]");
        expect(lines.at(-1)).toBe("scoreboard players set #on polaris_tntrun 1");
        const ours = `if score #x1 polaris_tntrun matches ${-8 * 64} if score #z1 polaris_tntrun matches ${35 * 64}`;
        expect(tntRun.stopLines(arena.boxes)).toEqual([
            `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=polaris_tnt_fuse]`,
            `execute ${ours} run scoreboard players set #on polaris_tntrun 0`
        ]);
        // Nothing for an arena with no TNT - a spleef's.
        expect(
            tntRun.stopLines(spleef.arena({ size: 5 } as never, { x: 0, z: 0 }, 100).boxes)
        ).toEqual([]);
        expect(stage.ARENA_BLOCKS).toContain(tntRun.FLOOR);
    });
});

describe("what a TNT run says", () => {
    it("is in both languages, and every line it sends is one command", () => {
        for (const language of ["en", "es"] as const) {
            const words = [
                said.readySubtitle(language),
                said.goTitle(language),
                said.bar(99, 4, 4, language),
                said.cannotPlay(language)
            ];
            for (const line of words) {
                expect(line).toMatch(/^&[0-9a-f]/);
                expect(
                    commandBytes(`tellraw Maximilian_1234 ${commands.text(line)}`)
                ).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            }
            expect(said.goTitle("en")).not.toBe(said.goTitle("es"));
        }
        const arena = arenaOf(15, 4, { x: -29_999_000, z: 29_999_000 }, 300);
        for (const line of [
            ...tntRun.armLines(arena),
            ...tntRun.stopLines(arena.boxes),
            tntRun.primedOut(arena.volume)
        ])
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
    });
});
