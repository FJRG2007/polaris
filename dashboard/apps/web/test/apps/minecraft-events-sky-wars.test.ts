/**
 * SkyWars' islands, pure: the layout drawn from the run's id and checked over
 * thousands of seeds for every player count - no jump reaches another island,
 * every island can bridge to the middle - what it is built of, the box and the
 * play area round it, the loot, the quick look and what players read.
 */

import { describe, expect, it } from "vitest";
import * as sw from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/sky-wars-messages";
import { reachAcross } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour-layout";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

/** Seeds per player count: 7 counts, over four thousand layouts in all. */
const SEEDS: Readonly<Record<number, number>> = {
    2: 500,
    3: 500,
    4: 500,
    5: 500,
    6: 600,
    7: 600,
    8: 1000
};
const at = { x: 100, y: 120, z: -40 };

describe("SkyWars' islands", () => {
    for (const players of [2, 3, 4, 5, 6, 7, 8]) {
        it(`for ${players}: keeps every rule over ${SEEDS[players]} seeds`, () => {
            const rings: number[] = [];
            for (let seed = 0; seed < SEEDS[players]!; seed += 1) {
                const layout = sw.layoutFor(`run-${seed}`, players);
                expect(sw.layoutProblems(layout)).toEqual([]);
                expect(layout.islands).toHaveLength(players + 1);
                rings.push(layout.ring);
            }
            // Never further out than a bridge from the island's own chests reaches.
            expect(Math.max(...rings)).toBeLessThanOrEqual(40);
        });
    }

    it("is the same layout for the same run, and another for another", () => {
        expect(sw.layoutFor("abc", 4)).toEqual(sw.layoutFor("abc", 4));
        expect(sw.layoutFor("abc", 4)).not.toEqual(sw.layoutFor("abd", 4));
    });

    it("finds an island a jump away: the same islands pulled in until one is", () => {
        const layout = sw.layoutFor("run-3", 4);
        const pulled = {
            ...layout,
            islands: layout.islands.map((island, index) =>
                index === 0
                    ? {
                          ...island,
                          blocks: island.blocks.map((one) => ({
                              ...one,
                              x: one.x - Math.sign(island.x) * 8,
                              z: one.z - Math.sign(island.z) * 8
                          })),
                          x: island.x - Math.sign(island.x) * 8,
                          z: island.z - Math.sign(island.z) * 8
                      }
                    : island
            )
        };
        expect(sw.layoutProblems(pulled).join(" ")).toMatch(/can be jumped to|too close/);
    });

    it("looks like islands: grass over dirt over stone narrowing down, a tree or a boulder, two chests and a start", () => {
        const layout = sw.layoutFor("run-9", 6);
        for (const island of layout.islands) {
            const top = island.blocks.filter((one) => one.y === island.top);
            const bottom = Math.min(...island.blocks.map((one) => one.y));
            expect(top.every((one) => one.block === "minecraft:grass_block")).toBe(true);
            expect(island.top - bottom).toBeGreaterThanOrEqual(3);
            const widthAt = (y: number) => island.blocks.filter((one) => one.y === y).length;
            expect(widthAt(bottom)).toBeLessThan(widthAt(island.top));
            expect(island.blocks.some((one) => /oak_log|mossy_cobblestone/.test(one.block))).toBe(
                true
            );
            expect(
                island.blocks.some(
                    (one) => one.block === "minecraft:oak_leaves[persistent=true]"
                ) || island.blocks.some((one) => one.block === "minecraft:mossy_cobblestone")
            ).toBe(true);
        }
        const middle = layout.islands.at(-1)!;
        expect(middle.chests).toHaveLength(4);
        expect(middle.spawn).toBeNull();
        for (const island of layout.islands.slice(0, -1)) {
            expect(island.chests).toHaveLength(2);
            expect(island.spawn).not.toBeNull();
        }
    });

    it("reaches no island by any jump, from any block a player can stand on", () => {
        // The rule checked again here by brute force over every pair of tops.
        const layout = sw.layoutFor("run-21", 8);
        const tops = layout.islands.map((island) => {
            const solid = new Set(island.blocks.map((one) => `${one.x},${one.y},${one.z}`));
            return island.blocks.filter(
                (one) =>
                    !solid.has(`${one.x},${one.y + 1},${one.z}`) &&
                    !solid.has(`${one.x},${one.y + 2},${one.z}`) &&
                    !/poppy|dandelion|cornflower|daisy/.test(one.block)
            );
        });
        for (let i = 0; i < tops.length; i += 1)
            for (let j = 0; j < tops.length; j += 1) {
                if (i === j) continue;
                for (const a of tops[i]!)
                    for (const b of tops[j]!) {
                        const across = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) - 1;
                        const reach = reachAcross(b.y - a.y);
                        expect(reach < 0 || across > reach).toBe(true);
                    }
            }
    });
});

describe("SkyWars' arena in the world", () => {
    const layout = sw.layoutFor("run-1", 6);
    const box = sw.arenaBox(layout, at);
    const play = sw.playArea(layout, at);
    const fills = sw.arenaFills(layout, at);

    it("is built only into air inside its box, the middle's grass last as the proof", () => {
        for (const one of fills) {
            expect(arena.fillKeep(one.box, one.block)).toMatch(/ keep$/);
            expect(arena.contains(box, { x: one.box.x1, y: one.box.y1, z: one.box.z1 })).toBe(true);
            expect(arena.contains(box, { x: one.box.x2, y: one.box.y2, z: one.box.z2 })).toBe(true);
            expect(sw.ARENA_BLOCKS).toContain(one.block.replace(/\[.*$/, ""));
        }
        expect(fills.at(-1)).toEqual({
            box: { x1: at.x, y1: at.y, z1: at.z, x2: at.x, y2: at.y, z2: at.z },
            block: "minecraft:grass_block"
        });
        // A few hundred fills at the most, not a block at a time.
        expect(fills.length).toBeLessThan(600);
    });

    it("comes down a kind at a time over the whole box, the flowers before the grass they grow on", () => {
        const lines = arena.teardown({ box, blocks: [...sw.ARENA_BLOCKS] });
        expect(arena.slices(box).length).toBeGreaterThan(1);
        const flowers = lines
            .map((line, index) =>
                /(poppy|dandelion|cornflower|oxeye_daisy)$/.test(line) ? index : -1
            )
            .filter((index) => index >= 0);
        const grass = lines.findIndex((line) => line.endsWith("replace minecraft:grass_block"));
        expect(Math.max(...flowers)).toBeLessThan(grass);
        expect(lines).toHaveLength(arena.slices(box).length * sw.ARENA_BLOCKS.length);
    });

    it("leaves room past the play area on every side for a player's reach, walled in barrier", () => {
        expect(sw.MARGIN).toBeGreaterThanOrEqual(2 * sw.REACH);
        expect(play.x1 - box.x1).toBe(sw.MARGIN);
        expect(box.x2 - play.x2).toBe(sw.MARGIN);
        expect(play.y1 - box.y1).toBe(sw.MARGIN);
        expect(box.y2 - play.y2).toBeGreaterThanOrEqual(sw.MARGIN);
        for (const face of [
            { ...box, x2: box.x1 },
            { ...box, x1: box.x2 },
            { ...box, z2: box.z1 },
            { ...box, z1: box.z2 },
            { ...box, y1: box.y2 }
        ])
            expect(fills).toContainEqual({ box: face, block: "minecraft:barrier" });
        // Every island inside the play area.
        for (const island of layout.islands)
            for (const one of island.blocks)
                expect(sw.inPlay(play, { x: at.x + one.x, y: at.y + one.y, z: at.z + one.z })).toBe(
                    true
                );
        // Never under the ground it is built over.
        const ground = 70;
        const base = sw.baseOver(layout, ground, 25);
        expect(sw.arenaBox(layout, { ...at, y: base }).y1).toBeGreaterThan(ground);
        expect(sw.reachOf(layout) * 2 + 1).toBeGreaterThanOrEqual(box.x2 - box.x1 + 1 - 1);
    });

    it("starts each player in an invisible cage on their island, facing the middle, which comes down by its barrier alone", () => {
        const downs = sw.cagesDown(layout, at);
        expect(downs).toHaveLength(6);
        for (let index = 0; index < 6; index += 1) {
            const island = layout.islands[index]!;
            const spot = sw.startSpot(layout, at, index);
            const cage = sw.cageBox(island, at);
            expect(spot.x).toBe(cage.x1 + 1);
            expect(spot.y).toBe(cage.y1);
            expect(downs[index]).toBe(
                `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace minecraft:barrier`
            );
            // Facing the middle: a step that way is a step nearer it.
            const step = {
                x: spot.x - Math.sin((spot.yaw * Math.PI) / 180),
                z: spot.z + Math.cos((spot.yaw * Math.PI) / 180)
            };
            expect(Math.hypot(step.x - at.x, step.z - at.z)).toBeLessThan(
                Math.hypot(spot.x - at.x, spot.z - at.z)
            );
        }
        const gallery = sw.galleryFloor(layout, at);
        expect(gallery.y1).toBeGreaterThan(play.y2);
        expect(sw.gallerySpot(layout, at, 3).y).toBe(gallery.y1 + 1);
    });
});

describe("SkyWars' loot", () => {
    const layout = sw.layoutFor("run-1", 4);

    it("is drawn from the run's id, every item one the kit takes back", () => {
        for (const loot of ["normal", "rich"] as const)
            layout.islands.forEach((island, index) =>
                island.chests.forEach((_chest, number) => {
                    const stacks = sw.lootFor(
                        "run-1",
                        index,
                        number,
                        !island.spawn,
                        loot,
                        island.bridge
                    );
                    expect(stacks).toEqual(
                        sw.lootFor("run-1", index, number, !island.spawn, loot, island.bridge)
                    );
                    for (const stack of stacks) expect(sw.LOOT_IDS).toContain(stack.id);
                })
            );
    });

    it("gives every island blocks enough to bridge to the middle, a weapon and food", () => {
        for (let seed = 0; seed < 200; seed += 1)
            for (const loot of ["normal", "rich"] as const) {
                const one = sw.lootFor(`run-${seed}`, 0, 0, false, loot, "minecraft:oak_planks");
                const two = sw.lootFor(`run-${seed}`, 0, 1, false, loot, "minecraft:oak_planks");
                const blocks = [...one, ...two]
                    .filter((stack) => stack.bridge)
                    .reduce((sum, stack) => sum + stack.count, 0);
                expect(blocks).toBeGreaterThanOrEqual(sw.BRIDGE_BLOCKS);
                expect(one.some((stack) => stack.id.endsWith("_sword"))).toBe(true);
                expect(one.some((stack) => /bread|cooked/.test(stack.id))).toBe(true);
                expect(
                    two.filter((stack) => /_(helmet|chestplate|leggings|boots)$/.test(stack.id))
                ).toHaveLength(2);
            }
    });

    it("is richer when rich, and richer still in the middle", () => {
        const tiers = (loot: "normal" | "rich", middle: boolean) =>
            Array.from({ length: 200 }, (_, seed) =>
                sw.lootFor(`run-${seed}`, 0, middle ? 0 : 1, middle, loot, "minecraft:oak_planks")
            )
                .flat()
                .filter((stack) => /diamond|iron/.test(stack.id)).length;
        expect(tiers("rich", false)).toBeGreaterThan(tiers("normal", false));
        expect(tiers("normal", true)).toBeGreaterThan(tiers("normal", false));
        expect(tiers("rich", true)).toBeGreaterThan(tiers("normal", true));
    });

    it("is written the way each version reads it, marked, in distinct slots, bridging blocks placeable", () => {
        const stacks = sw.lootFor("run-1", 0, 0, false, "normal", "minecraft:cobblestone");
        const modern = sw.fillChestLines("run-1", { x: 1, y: 2, z: 3 }, stacks, "components", true);
        const older = sw.fillChestLines("run-1", { x: 1, y: 2, z: 3 }, stacks, "tag", false);
        expect(modern[0]).toMatch(
            /^execute in minecraft:overworld run item replace block 1 2 3 container\.\d+ with minecraft:cobblestone\[minecraft:custom_data=\{polaris_event:1b\},minecraft:can_place_on=\{blocks:\[.*"minecraft:grass_block".*\]\}\] 32$/
        );
        expect(older[0]).toMatch(
            /^execute in minecraft:overworld run replaceitem block 1 2 3 container\.\d+ minecraft:cobblestone\{polaris_event:1b,CanPlaceOn:\[.*\]\} 32$/
        );
        const slots = modern.map((line) => /container\.(\d+)/.exec(line)![1]);
        expect(new Set(slots).size).toBe(slots.length);
        for (const slot of slots) expect(Number(slot)).toBeLessThan(27);
        for (const line of [...modern, ...older]) {
            expect(line).toContain("polaris_event:1b");
            expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        }
        expect(modern.filter((line) => line.includes("can_place_on"))).toHaveLength(1);
        expect(
            sw.chestLines("run-1", layout, at, "normal", "components", true).length
        ).toBeGreaterThan(20);
    });
});

describe("SkyWars' rules", () => {
    const layout = sw.layoutFor("run-1", 4);
    const box = sw.arenaBox(layout, at);
    const play = sw.playArea(layout, at);

    it("shields whoever is low, takes up at once whoever crosses the play area's edge, and lets no stuck arrow be picked up", () => {
        const lines = sw.quickLines(layout, at, box);
        expect(lines[0]).toBe(
            "effect give @a[tag=pe_arena,tag=!pe_sw_out,scores={pe_hp=..4}] minecraft:resistance 2 4 true"
        );
        expect(lines.filter((line) => line.endsWith(" add pe_sw_gone"))).toHaveLength(6);
        // Under the islands: everything below the play area's floor.
        expect(lines[1]).toContain(`dy=${play.y1 - 1 - (box.y1 - 128)}`);
        expect(
            lines.some((line) =>
                line.includes("run tp @a[tag=pe_arena,tag=!pe_sw_out,tag=pe_sw_gone]")
            )
        ).toBe(true);
        expect(lines.at(-1)).toContain("kill @e[type=minecraft:arrow,");
        expect(lines.at(-1)).toContain("nbt={inGround:1b}");
    });

    it("credits a hit to the nearest who struck, or else the nearest who drew a bow", () => {
        const victim = { x: 0, y: 100, z: 0 };
        expect(sw.hitBy(victim, [{ name: "Ana", x: 2, y: 100, z: 0 }], [])).toBe("Ana");
        expect(
            sw.hitBy(
                victim,
                [{ name: "Ana", x: 12, y: 100, z: 0 }],
                [{ name: "Ben", x: 30, y: 100, z: 0 }]
            )
        ).toBe("Ben");
        expect(sw.hitBy(victim, [], [])).toBeNull();
    });

    it("ranks by the order players went out, the one left above all, a tie broken by kills", () => {
        const state = sw.stateSchema.parse({
            out: [
                { name: "Dee", at: 1, why: "fell" },
                { name: "Cy", at: 5, why: "low" },
                { name: "Ben", at: 5, why: "low" }
            ],
            kills: { Ana: 2, Ben: 1 }
        });
        const names = ["Ana", "Ben", "Cy", "Dee"];
        expect(Object.fromEntries(sw.scoresOf(state, names))).toEqual({
            Ana: 4,
            Ben: 2,
            Cy: 2,
            Dee: 1
        });
        expect(sw.tiebreakOf(state, names)).toEqual({ Ana: -2, Ben: -1, Cy: -0, Dee: -0 });
        expect(sw.stateOf("nonsense").out).toEqual([]);
    });
});

describe("what SkyWars says", () => {
    const LONG = "Maximilian_1234";
    for (const language of ["en", "es"] as const) {
        it(`fits one command in ${language}`, () => {
            const lines = [
                ...(["low", "fell", "left", "died", "gone"] as const).map((why) =>
                    said.outLine(LONG, why, LONG, 7, language)
                ),
                said.aliveBar(8, 99, language),
                said.galleryBar(language),
                said.bar(8, "59:59", language),
                said.winner(LONG, language),
                said.outSubtitle(language),
                said.goSubtitle(language)
            ].map((line) => commands.say(messages.tag(language) + line));
            for (const line of lines)
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            expect(said.outLine("Ana", "fell", null, 3, language)).not.toBe(
                said.outLine("Ana", "fell", null, 3, language === "en" ? "es" : "en")
            );
        });
    }
});
