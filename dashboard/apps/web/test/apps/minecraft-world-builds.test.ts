/**
 * Seasonal builds placed in a server's world: the Polaris build format, the
 * offline converter, where a build may go - uneven ground on a foundation, out
 * to the far rings - the paced paste, and the teardown that gives back exactly
 * what was there.
 */

import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/minecraft/world-builds/plan";
import * as format from "@polaris-app/game-servers/src/lib/minecraft/world-builds/format";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import * as convert from "@polaris-app/game-servers/src/lib/minecraft/world-builds/convert";

let config: Record<string, unknown> = {};

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            patchInstallConfig: async (
                _id: string,
                patch: (current: Record<string, unknown>) => Record<string, unknown>
            ) => {
                config = { ...config, ...patch(config) };
            }
        }
    }
}));

const { reconcileWorldBuilds } =
    await import("@polaris-app/game-servers/src/lib/minecraft/world-builds/service");

/** A 3 x 2 x 2 build: a stone floor with one lantern on it. */
function tinyBuild(season: "winter" | "halloween" = "winter"): format.PolarisBuild {
    const cells = [1, 1, 1, 1, 1, 1, 0, 2, 0, 0, 0, 0];
    return format.polarisBuildSchema.parse({
        format: "polaris-build",
        version: 1,
        id: "test-build",
        season,
        size: { x: 3, y: 2, z: 2 },
        palette: [format.AIR, "minecraft:stone", "minecraft:lantern[hanging=false]"],
        blocks: format.encodeCells(cells)
    });
}

describe("the Polaris build format", () => {
    it("decodes the runs it encodes", () => {
        const cells = [0, 0, 3, 3, 3, 1, 0];
        expect(
            [
                ...format.decodeCells({
                    ...tinyBuild(),
                    blocks: format.encodeCells(cells)
                } as never)
            ].slice(0, 7)
        ).toEqual(cells);
        expect(format.encodeCells(cells)).toEqual([0, 2, 3, 3, 1, 1, 0, 1]);
    });

    it("refuses runs that do not cover the build, and a palette not led by air", () => {
        const build = tinyBuild();
        expect(format.polarisBuildSchema.safeParse({ ...build, blocks: [1, 3] }).success).toBe(
            false
        );
        expect(
            format.polarisBuildSchema.safeParse({
                ...build,
                palette: ["minecraft:stone", ...build.palette]
            }).success
        ).toBe(false);
    });
});

// --------------------------------------------------------------- NBT writer

function nbtString(value: string): Buffer {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

type Field = [type: number, name: string, payload: Buffer];

function short(value: number): Buffer {
    const out = Buffer.alloc(2);
    out.writeInt16BE(value);
    return out;
}

function int(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeInt32BE(value);
    return out;
}

function compound(fields: Field[]): Buffer {
    return Buffer.concat([
        ...fields.map(([type, name, payload]) =>
            Buffer.concat([Buffer.from([type]), nbtString(name), payload])
        ),
        Buffer.from([0])
    ]);
}

function file(name: string, fields: Field[]): Buffer {
    return gzipSync(Buffer.concat([Buffer.from([10]), nbtString(name), compound(fields)]));
}

function bytes(values: number[]): Buffer {
    return Buffer.concat([int(values.length), Buffer.from(values)]);
}

describe("converting a Sponge schematic", () => {
    const palette = compound([
        [3, "minecraft:air", int(0)],
        [3, "minecraft:stone", int(1)],
        [3, "minecraft:oak_stairs[facing=east,waterlogged=true]", int(2)],
        [3, "minecraft:water[level=0]", int(3)]
    ]);
    // 2 x 1 x 2: stone, stairs, water, air (x fastest, then z).
    const cells = [1, 2, 3, 0];

    it("reads version 2, drops the water, and keeps the stairs dry", () => {
        const source = file("Schematic", [
            [3, "Version", int(2)],
            [2, "Width", short(2)],
            [2, "Height", short(1)],
            [2, "Length", short(2)],
            [10, "Palette", palette],
            [7, "BlockData", bytes(cells)]
        ]);
        const build = convert.convertSponge(source, "stairs", "winter");
        expect(build.palette).toEqual([
            format.AIR,
            "minecraft:stone",
            "minecraft:oak_stairs[facing=east]"
        ]);
        expect([...format.decodeCells(build)]).toEqual([1, 2, 0, 0]);
    });

    it("reads version 3, where the palette sits under Blocks", () => {
        const source = file("", [
            [
                10,
                "Schematic",
                compound([
                    [3, "Version", int(3)],
                    [2, "Width", short(2)],
                    [2, "Height", short(1)],
                    [2, "Length", short(2)],
                    [
                        10,
                        "Blocks",
                        compound([
                            [10, "Palette", palette],
                            [7, "Data", bytes(cells)]
                        ])
                    ]
                ])
            ]
        ]);
        expect([
            ...format.decodeCells(convert.convertSponge(source, "stairs", "halloween"))
        ]).toEqual([1, 2, 0, 0]);
    });
});

describe("converting an MCEdit schematic", () => {
    // 2 x 1 x 3, x fastest then z: granite, south-facing oak stairs, stone with a
    // data value the table lacks, an id past 255 nobody knows, still water, air.
    const ids = [1, 53, 1, 5, 9, 0];
    const data = [1, 2, 15, 0, 0, 0];

    function legacy(fields: Field[] = []): Buffer {
        return file("Schematic", [
            [2, "Width", short(2)],
            [2, "Height", short(1)],
            [2, "Length", short(3)],
            [8, "Materials", nbtString("Alpha")],
            [7, "Blocks", bytes(ids)],
            [7, "Data", bytes(data)],
            ...fields
        ]);
    }

    it("turns numeric ids and data values into today's block states", () => {
        // AddBlocks: two cells to a byte, the odd cell in the high nibble, so
        // 0x10 in byte 1 lifts cell 3 to id 256 + 5.
        const { build, report } = convert.convertSchematic(
            legacy([[7, "AddBlocks", bytes([0, 0x10, 0])]]),
            "old",
            "winter"
        );
        expect(build.palette).toEqual([
            format.AIR,
            "minecraft:granite",
            "minecraft:oak_stairs[half=bottom,shape=straight,facing=south]",
            "minecraft:stone"
        ]);
        expect([...format.decodeCells(build)]).toEqual([1, 2, 3, 0, 0, 0]);
        expect(report).toEqual({ substituted: { "1:15": 1 }, unknown: { "261:0": 1 } });
    });

    it("reads ids under 256 without AddBlocks", () => {
        const { build, report } = convert.convertSchematic(legacy(), "old", "winter");
        expect(build.palette).toContain("minecraft:oak_planks");
        expect(report.unknown).toEqual({});
    });

    it("refuses a schematic of blocks other than the Alpha set", () => {
        const source = file("Schematic", [
            [2, "Width", short(1)],
            [2, "Height", short(1)],
            [2, "Length", short(1)],
            [8, "Materials", nbtString("Pocket")],
            [7, "Blocks", bytes([1])],
            [7, "Data", bytes([0])]
        ]);
        expect(() => convert.convertSponge(source, "old", "winter")).toThrow(/Pocket/);
    });
});

describe("where a build goes", () => {
    it("looks round the homes, nearest ring first, clear of the door", () => {
        const centers = plan.candidateCenters([{ x: 0, z: 0 }], tinyBuild(), 8);
        expect(centers).toHaveLength(8);
        for (const spot of centers) expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(24);
        expect(centers[0]).toEqual({ x: 26, z: 0 });
    });

    it("goes on out to the far rings, with more sites round them", () => {
        const centers = plan.candidateCenters([{ x: 0, z: 0 }], tinyBuild(), Infinity);
        const distances = centers.map((spot) => Math.hypot(spot.x, spot.z));
        const ring = (from: number, to: number) =>
            distances.filter((one) => one >= from && one < to).length;
        expect(ring(24, 30)).toBe(8);
        expect(ring(190, 200)).toBeGreaterThan(8);
        expect(Math.max(...distances)).toBeLessThan(200);
        // Nearest first: each ring after the one before it.
        distances.forEach((one, at) => {
            if (at > 0) expect(one).toBeGreaterThan(distances[at - 1]! - 2);
        });
    });

    it("takes uneven ground up to as far as the build is wide, never more than eight", () => {
        const build = tinyBuild();
        const level = [{ y: 64 }, { y: 64 }, { y: 65 }, { y: 64 }];
        expect(plan.judgeSite(4, level, 0, build)).toEqual({ y: 65 });
        expect(plan.spreadAllowed(build)).toBe(3);
        expect(plan.judgeSite(4, [...level.slice(0, 3), { y: 62 }], 0, build)).toEqual({
            y: 65
        });
        expect(plan.judgeSite(4, [...level.slice(0, 3), { y: 61 }], 0, build)).toEqual({
            why: "uneven"
        });
        const wide = { ...build, size: { x: 40, y: 2, z: 40 } };
        expect(plan.spreadAllowed(wide)).toBe(plan.GROUND_SPREAD_MAX);
        expect(plan.spreadAllowed({ ...build, size: { x: 1, y: 2, z: 1 } })).toBe(2);
        expect(plan.judgeSite(4, level, 1, build)).toEqual({ why: "covered" });
        expect(plan.judgeSite(4, level.slice(0, 3), 0, build)).toEqual({ why: "unloaded" });
        expect(
            plan.judgeSite(4, [{ y: 319 }, { y: 319 }, { y: 319 }, { y: 319 }], 0, build)
        ).toEqual({ why: "too-high" });
    });
});

describe("the foundation", () => {
    it("fills each lower column from its ground to the build, and nothing in a column that reaches it", () => {
        const tops = [
            { x: 0, y: 64, z: 0 },
            { x: 1, y: 64, z: 0 },
            { x: 2, y: 66, z: 0 },
            { x: 0, y: 61, z: 1 },
            { x: 1, y: 63, z: 1 },
            { x: 2, y: 63, z: 1 }
        ];
        expect(plan.foundationRuns(tops, 66)).toEqual([
            [0, 1, 0, 64, 65],
            [0, 0, 1, 61, 65],
            [1, 2, 1, 63, 65]
        ]);
        expect(plan.foundationRuns(tops.slice(2, 3), 66)).toEqual([]);
    });

    it("goes in before the build, lowest first, only into air", () => {
        const build = tinyBuild();
        const runs: plan.FoundationRun[] = [
            [10, 12, 20, 63, 63],
            [10, 12, 21, 60, 63]
        ];
        const placed = plan.placedFor(build, { x: 10, y: 64, z: 20 }, "pwkey", runs);
        expect(placed.foundation).toEqual(runs);
        const lines = plan.piecesOf(build, placed).map((one) => one.line);
        expect(lines.slice(0, 2)).toEqual([
            "execute in minecraft:overworld run fill 10 60 21 12 63 21 minecraft:dirt keep",
            "execute in minecraft:overworld run fill 10 63 20 12 63 20 minecraft:dirt keep"
        ]);
        expect(lines.slice(2)).toEqual(
            plan.pastePieces(build, { x: 10, y: 64, z: 20 }).map((one) => one.line)
        );
        expect(plan.placedFor(build, { x: 10, y: 64, z: 20 })).not.toHaveProperty("foundation");
    });

    it("comes down after the build, cell by cell, its dirt or the grass that grew on it", () => {
        const build = tinyBuild();
        const runs: plan.FoundationRun[] = [[10, 12, 21, 60, 63]];
        const placed = plan.placedFor(build, { x: 10, y: 64, z: 20 }, "pwkey", runs);
        const lines = plan.restoreLines(placed, build);
        const under = [
            "execute in minecraft:overworld run fill 10 60 21 12 63 21 minecraft:air replace minecraft:dirt",
            "execute in minecraft:overworld run fill 10 60 21 12 63 21 minecraft:air replace minecraft:grass_block"
        ];
        expect(lines.slice(-2)).toEqual(under);
        expect(lines.filter((one) => one.includes(" 60 "))).toEqual(under);
        // A build no longer in the catalog still takes its foundation with it.
        const gone = plan.restoreLines(placed);
        expect(gone.slice(-2)).toEqual(under);
    });
});

describe("pasting", () => {
    it("fills runs along x and places single blocks, bottom layer first, only into air", () => {
        const pieces = plan.pastePieces(tinyBuild(), { x: 10, y: 64, z: 20 });
        expect(pieces.map((one) => one.line)).toEqual([
            "execute in minecraft:overworld run fill 10 64 20 12 64 20 minecraft:stone keep",
            "execute in minecraft:overworld run fill 10 64 21 12 64 21 minecraft:stone keep",
            "execute in minecraft:overworld run setblock 11 65 20 minecraft:lantern[hanging=false] keep"
        ]);
        expect(pieces.every((one) => one.line.endsWith(" keep"))).toBe(true);
    });

    it("cuts the paste into chunks no larger than the budget, in order", () => {
        const pieces = Array.from({ length: 10 }, (_, at) => ({ line: `l${at}`, blocks: 3 }));
        const chunks = plan.pasteChunks(pieces, 7);
        expect(chunks).toEqual([
            ["l0", "l1"],
            ["l2", "l3"],
            ["l4", "l5"],
            ["l6", "l7"],
            ["l8", "l9"]
        ]);
        expect(plan.pasteChunks([{ line: "huge", blocks: 99 }], 7)).toEqual([["huge"]]);
    });
});

describe("taking it down", () => {
    it("empties only the cells it filled, top layer first, and no sweep", () => {
        const build = tinyBuild();
        const placed = plan.placedFor(build, { x: 10, y: 64, z: 20 }, "pwkey");
        expect(placed.arena.blocks).toEqual(["minecraft:lantern", "minecraft:stone"]);
        const lines = plan.restoreLines(placed, build);
        expect(lines).toContain(
            "execute in minecraft:overworld run fill 10 64 20 12 64 20 minecraft:air replace minecraft:stone"
        );
        expect(lines).toContain(
            "execute in minecraft:overworld run fill 11 65 20 11 65 20 minecraft:air replace minecraft:lantern"
        );
        expect(lines).not.toContain(
            "execute in minecraft:overworld run fill 10 64 20 12 65 21 minecraft:air replace minecraft:stone"
        );
        expect(lines.indexOf(lines.find((one) => one.endsWith("minecraft:lantern"))!)).toBeLessThan(
            lines.indexOf(lines.find((one) => one.endsWith("minecraft:stone"))!)
        );
        expect(
            lines.every(
                (one) => !/ fill [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ minecraft:air$/.test(one)
            )
        ).toBe(true);
    });

    it("leaves a block a player put in its box: a cell the build left empty is never touched", () => {
        const build = tinyBuild();
        const placed = plan.placedFor(build, { x: 10, y: 64, z: 20 });
        const lines = plan.restoreLines(placed, build);
        const touches = (x: number, y: number, z: number) =>
            lines.some((line) => {
                const match =
                    / fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:air replace (\S+)/.exec(
                        line
                    );
                if (!match || match[7] === "minecraft:snow") return false;
                const [x1, y1, z1, x2, y2, z2] = match.slice(1, 7).map(Number);
                return x >= x1! && x <= x2! && y >= y1! && y <= y2! && z >= z1! && z <= z2!;
            });
        expect(touches(10, 65, 20)).toBe(false);
        expect(touches(12, 65, 21)).toBe(false);
        expect(touches(11, 65, 20)).toBe(true);
    });

    it("falls back to every kind inside its box when the build is no longer the one it pasted", () => {
        const build = tinyBuild();
        const placed = plan.placedFor(build, { x: 10, y: 64, z: 20 });
        const changed = { ...build, palette: [...build.palette.slice(0, 2), "minecraft:torch"] };
        for (const lines of [plan.restoreLines(placed), plan.restoreLines(placed, changed)]) {
            expect(lines).toContain(
                "execute in minecraft:overworld run fill 10 64 20 12 65 21 minecraft:air replace minecraft:stone"
            );
        }
    });

    it("forgets a written-down build only when it parses, and keeps the rest as written", () => {
        const placed = plan.placedFor(tinyBuild(), { x: 0, y: 64, z: 0 });
        const config = { [plan.WORLD_BUILDS_KEY]: [placed, { id: 3 }] };
        expect(plan.readPlaced(config)).toEqual([placed]);
        expect(plan.unreadPlaced(config)).toEqual([{ id: 3 }]);
        expect(plan.readPlaced({})).toEqual([]);
    });
});

describe("the catalog", () => {
    it("ships a build for every season, each small enough to site near a home", async () => {
        const { WORLD_BUILDS } =
            await import("@polaris-app/game-servers/src/lib/minecraft/world-builds/catalog");
        const { DECORATIONS } =
            await import("@polaris-app/game-servers/src/lib/minecraft/seasonal");
        for (const season of DECORATIONS)
            expect(WORLD_BUILDS.some((one) => one.season === season)).toBe(true);
        for (const build of WORLD_BUILDS) {
            // A carved pumpkin set on two snow blocks turns into a snow golem, however it got there.
            const cells = format.decodeCells(build);
            const layer = build.size.x * build.size.z;
            const head = (index: number) =>
                /carved_pumpkin|jack_o_lantern/.test(build.palette[index]!);
            const snow = (at: number) => build.palette[cells[at] ?? 0] === "minecraft:snow_block";
            cells.forEach((index, at) => {
                if (head(index)) expect(snow(at - layer) && snow(at - 2 * layer)).toBe(false);
            });
            expect(plan.radiusOf(build)).toBeLessThanOrEqual(8);
        }
    });

    it("pastes only blocks that stay put: no fluids, containers, entities or decaying leaves", async () => {
        const { WORLD_BUILDS } =
            await import("@polaris-app/game-servers/src/lib/minecraft/world-builds/catalog");
        // Every block here sits still once pasted: nothing flows, falls, decays,
        // holds loot or spawns anything (no water, lava, sand, chests, spawners,
        // skulls or iron blocks for a golem). A cauldron fills with rain, which
        // the teardown takes too.
        const allowed = new Set([
            "air",
            "snow_block",
            "packed_ice",
            "blue_ice",
            "spruce_fence",
            "spruce_log",
            "spruce_leaves",
            "black_wool",
            "red_wool",
            "yellow_wool",
            "light_blue_wool",
            "lime_wool",
            "purple_wool",
            "black_carpet",
            "white_carpet",
            "red_carpet",
            "yellow_carpet",
            "moss_carpet",
            "red_concrete",
            "glowstone",
            "gold_block",
            "smooth_quartz_slab",
            "pumpkin",
            "carved_pumpkin",
            "jack_o_lantern",
            "hay_block",
            "coarse_dirt",
            "podzol",
            "dead_bush",
            "red_mushroom",
            "brown_mushroom",
            "mossy_stone_brick_wall",
            "stone_brick_slab",
            "mossy_stone_brick_slab",
            "chiseled_stone_bricks",
            "cracked_stone_bricks",
            "campfire",
            "cauldron",
            "purple_candle",
            "lantern",
            "soul_lantern"
        ]);
        // What pops off without a block under it, and what that block must be.
        const floor: Record<string, RegExp> = {
            lantern: /./,
            soul_lantern: /./,
            purple_candle: /./,
            dead_bush: /coarse_dirt|podzol/,
            red_mushroom: /podzol/,
            brown_mushroom: /podzol/,
            black_carpet: /./,
            white_carpet: /./,
            red_carpet: /./,
            yellow_carpet: /./
        };
        for (const build of WORLD_BUILDS) {
            const cells = format.decodeCells(build);
            const layer = build.size.x * build.size.z;
            for (const state of build.palette) {
                const block = format.blockOf(state).replace(/^minecraft:/, "");
                expect(allowed.has(block), `${build.id}: ${state}`).toBe(true);
                if (block.endsWith("_leaves")) expect(state).toContain("persistent=true");
                if (block.endsWith("lantern") && block !== "jack_o_lantern")
                    expect(state).toContain("hanging=false");
            }
            cells.forEach((index, at) => {
                const block = format.blockOf(build.palette[index]!).replace(/^minecraft:/, "");
                if (!floor[block]) return;
                // The bottom layer stands on the site's own ground, which is only
                // known to be solid: a plant there brings its own soil instead.
                const below = at < layer ? "ground" : build.palette[cells[at - layer]!]!;
                expect(below === format.AIR ? "" : below, `${build.id}: ${block}`).toMatch(
                    floor[block]
                );
            });
        }
    });
});

// ------------------------------------------------------------------ service

let ids = 0;

/** What else a fake world holds: a block over the ground (`solid`), grass a
 *  weed-clearing fill empties (`weeds`), a tree on a column, something
 *  somebody left `dy` over a column's ground. */
interface FakeWorld {
    solid?: (x: number, y: number, z: number) => boolean;
    weeds?: (x: number, y: number, z: number) => boolean;
    tree?: (x: number, z: number) => boolean;
    stray?: (x: number, z: number, dy: number) => boolean;
}

/** A vanilla server on level ground at y 64 with nobody's builds on it, or the
 *  ground `heightAt` says (the first air over it) and what `world` adds. */
function fakeServer(heightAt: (x: number, z: number) => number = () => 64, world: FakeWorld = {}) {
    const said: string[] = [];
    const sent: string[] = [];
    const columns: { x: number; z: number }[] = [];
    const cleared = new Set<string>();
    const filled = (x: number, y: number, z: number) =>
        y < heightAt(x, z) ||
        (world.solid?.(x, y, z) ?? false) ||
        ((world.weeds?.(x, y, z) ?? false) && !cleared.has(`${x},${y},${z}`));
    /** The markers a selector's volume takes in, all of them without one. */
    const selected = (command: string) => {
        const volume =
            /@e\[tag=[^,\]]+,x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(\d+),dy=([\d.]+),dz=(\d+)\]/.exec(
                command
            );
        if (!volume) return columns;
        const [x, y, z, dx, dy, dz] = volume.slice(1).map(Number) as number[];
        // A marker has no height: one exactly at the volume's top is outside it.
        return columns.filter(
            (one) =>
                one.x >= x! &&
                one.x <= x! + dx! &&
                one.z >= z! &&
                one.z <= z! + dz! &&
                heightAt(one.x, one.z) < y! + dy! + 1
        );
    };
    const answer = (found: readonly { x: number; z: number }[]) =>
        found
            .map(
                (one) =>
                    `Marker has the following entity data: [${one.x + 0.5}d, ${heightAt(one.x, one.z)}.0d, ${one.z + 0.5}d]`
            )
            .join("\n");
    const server = {
        installedAppId: `world-${(ids += 1)}`,
        edition: "java",
        running: true,
        say: async ([command]: readonly string[]) => {
            said.push(command!);
            if (command!.endsWith("forceload query"))
                return "No force loaded chunks were found in minecraft:overworld";
            if (command!.includes("@a[distance=0..]"))
                return "Steve has the following entity data: [0.5d, 64.0d, 0.5d]";
            if (command!.startsWith("execute as @e[tag=") && command!.endsWith("@s Pos")) {
                const markers = selected(command!);
                if (command!.includes(" if block ~ ~-1 ~ #minecraft:logs"))
                    return answer(markers.filter((one) => world.tree?.(one.x, one.z)));
                // Every line of the check over the ground answers the same markers.
                const stray = / unless block ~ ~(\d*) ~ /.exec(command!);
                if (stray)
                    return answer(
                        markers.filter((one) => world.stray?.(one.x, one.z, Number(stray[1] || 0)))
                    );
                if (command!.includes(" if block ") || command!.includes(" unless block "))
                    return "";
                return answer(markers);
            }
            const blocks = / if blocks (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) /.exec(
                command!
            );
            if (blocks) {
                const [x1, y1, z1, x2, y2, z2] = blocks.slice(1).map(Number) as number[];
                let count = 0;
                for (let x = x1!; x <= x2!; x++)
                    for (let y = y1!; y <= y2!; y++)
                        for (let z = z1!; z <= z2!; z++) if (filled(x, y, z)) count++;
                return `Test passed, count: ${count}`;
            }
            return "";
        },
        sayAll: async (lines: readonly string[]) => {
            for (const line of lines) {
                const top =
                    / positioned (-?\d+(?:\.\d+)?) 0 (-?\d+(?:\.\d+)?) positioned over /.exec(line);
                if (top)
                    columns.push({ x: Math.floor(Number(top[1])), z: Math.floor(Number(top[2])) });
                if (line.startsWith("kill @e[tag=")) columns.length = 0;
                if (plan.WEEDS.some((weed) => line.endsWith(` minecraft:air replace ${weed}`)))
                    for (const cell of cellsOf(line).cells) cleared.add(cell);
            }
            sent.push(...lines);
        }
    } as unknown as ServerContainer;
    return { server, said, sent };
}

/** Cliffs twenty high between every pair of columns: no build stands on them. */
const cliffs = (x: number) => 64 + 20 * Math.abs(x % 2);

/** The cells a fill or setblock line covers, and the block it puts there or takes away. */
function cellsOf(line: string): { cells: string[]; block: string } {
    const at = "(-?\\d+) (-?\\d+) (-?\\d+)";
    const match = new RegExp(String.raw` (?:fill ${at} ${at}|setblock ${at}) (\S+)`).exec(line)!;
    const numbers = match
        .slice(1, 10)
        .filter((one) => one !== undefined)
        .map(Number);
    const [x1, y1, z1, x2 = x1, y2 = y1, z2 = z1] = numbers as number[];
    const cells: string[] = [];
    for (let x = x1!; x <= x2!; x++)
        for (let y = y1!; y <= y2!; y++)
            for (let z = z1!; z <= z2!; z++) cells.push(`${x},${y},${z}`);
    return { cells, block: match[10]! };
}

describe("the season's builds in the world", () => {
    beforeEach(() => {
        config = {};
    });

    it("puts the build up on open ground near the players, written down first", async () => {
        const { server, sent } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        expect(placed).toMatchObject({ id: "test-build", season: "winter", up: true, pasted: 1 });
        expect(placed!.arena.box.y1).toBe(64);
        const paste = sent.filter((line) => line.endsWith(" keep"));
        expect(paste).toHaveLength(3);
        expect(
            paste.every(
                (line) => line.includes(` ${placed!.arena.box.x1} 64 `) || line.includes(" 65 ")
            )
        ).toBe(true);
    });

    it("puts nothing up on a server built on a map", async () => {
        config = { mapId: "parkour-spiral" };
        const { server, said, sent } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toEqual([]);
        expect(said).toEqual([]);
        expect(sent).toEqual([]);
    });

    it("does nothing at all on the next pass: nothing is pasted twice", async () => {
        const first = fakeServer();
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const again = fakeServer();
        await reconcileWorldBuilds(again.server, config, "winter", [tinyBuild()]);
        expect(again.said).toEqual([]);
        expect(again.sent).toEqual([]);
    });

    it("goes on from where a restart left a half-pasted build, without looking for a site again", async () => {
        const placed = plan.placedFor(tinyBuild(), { x: 40, y: 70, z: 40 }, "pwhalf");
        config = { [plan.WORLD_BUILDS_KEY]: [placed] };
        const { server, sent, said } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(said.some((line) => line.includes("@a[distance=0..]"))).toBe(false);
        expect(sent.filter((line) => line.endsWith(" keep"))[0]).toContain(
            " fill 40 70 40 42 70 40 "
        );
        expect(plan.readPlaced(config)[0]).toMatchObject({ up: true });
    });

    it("takes it down when the season ends or is switched off, and forgets it", async () => {
        const first = fakeServer();
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const box = plan.readPlaced(config)[0]!.arena.box;
        const { server, sent } = fakeServer();
        await reconcileWorldBuilds(server, config, null, [tinyBuild()]);
        expect(sent).toContain(
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y1} ${box.z1} minecraft:air replace minecraft:stone`
        );
        expect(sent.some((line) => line.endsWith(" keep"))).toBe(false);
        expect(plan.readPlaced(config)).toEqual([]);
    });

    it("goes on round the rings on the next pass when every site it tried was uneven", async () => {
        // Cliffs out to 40 blocks from the player: no site anywhere nearer.
        const stepped = (x: number, z: number) => (Math.hypot(x, z) < 40 ? cliffs(x) : 64);
        const first = fakeServer(stepped);
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toEqual([]);
        const next = fakeServer(stepped);
        next.server.installedAppId = first.server.installedAppId;
        for (let pass = 0; pass < 8 && plan.readPlaced(config).length === 0; pass++)
            await reconcileWorldBuilds(next.server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        expect(placed).toMatchObject({ up: true });
        const box = placed!.arena.box;
        expect(Math.hypot((box.x1 + box.x2) / 2, (box.z1 + box.z2) / 2)).toBeGreaterThanOrEqual(40);
    });

    it("never lets go of a chunk that was held loaded before it came", async () => {
        const { server, sent } = fakeServer();
        const say = server.say.bind(server);
        // The chunk under the first site, kept loaded by the operator.
        server.say = async (argv) =>
            argv[0]!.endsWith("forceload query")
                ? "1 force loaded chunk was found in minecraft:overworld at: [1, 0]"
                : say(argv);
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const removes = sent.filter((line) => line.includes(" forceload remove "));
        expect(removes.length).toBeGreaterThan(0);
        for (const line of removes) {
            const [x1, z1, x2 = x1, z2 = z1] = line
                .split(" forceload remove ")[1]!
                .split(" ")
                .map(Number);
            const holds = x1! >> 4 <= 1 && x2! >> 4 >= 1 && z1! >> 4 <= 0 && z2! >> 4 >= 0;
            expect(holds).toBe(false);
        }
    });

    it("loads and lets go of nothing when it cannot tell which chunks were held", async () => {
        const { server, sent } = fakeServer();
        const say = server.say.bind(server);
        server.say = async (argv) => {
            if (argv[0]!.endsWith("forceload query")) throw new Error("rcon closed");
            return say(argv);
        };
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(sent.some((line) => line.includes(" forceload "))).toBe(false);
        expect(plan.readPlaced(config)).toEqual([]);
    });

    it("surveys with markers of its own, which an event's mark or survey never reads or clears", async () => {
        const { server, sent, said } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const markers = [...sent, ...said].filter((line) => line.includes("@e[tag="));
        expect(markers.length).toBeGreaterThan(0);
        expect(markers.every((line) => /@e\[tag=pw_samp[,\]]/.test(line))).toBe(true);
        const summoned = sent.filter((line) => line.includes(" summon minecraft:armor_stand "));
        expect(summoned.length).toBeGreaterThan(0);
        expect(summoned.every((line) => line.includes('Tags:["pw_samp"]'))).toBe(true);
    });

    it("keeps a written-down build it cannot read when it writes the list again", async () => {
        const kept = { id: "from-later", season: "spring", arena: {}, pasted: 0, up: true };
        config = { [plan.WORLD_BUILDS_KEY]: [kept] };
        const { server } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toHaveLength(1);
        expect(config[plan.WORLD_BUILDS_KEY]).toContainEqual(kept);
    });

    it("pastes one chunk a pass, a few commands a trip, on a server without the Polaris jar", async () => {
        const wide = format.polarisBuildSchema.parse({
            format: "polaris-build",
            version: 1,
            id: "checkers",
            season: "winter",
            size: { x: 40, y: 1, z: 40 },
            palette: [format.AIR, "minecraft:stone", "minecraft:dirt"],
            blocks: format.encodeCells(
                Array.from({ length: 1600 }, (_, at) => 1 + ((at + Math.floor(at / 40)) % 2))
            )
        });
        const placed = plan.placedFor(wide, { x: 40, y: 70, z: 40 }, "pwwide");
        config = { [plan.WORLD_BUILDS_KEY]: [placed] };
        const trips: number[] = [];
        const { server, sent } = fakeServer();
        const sayAll = server.sayAll.bind(server);
        server.sayAll = async (lines) => {
            if (lines.some((line) => line.endsWith(" keep"))) trips.push(lines.length);
            await sayAll(lines);
        };
        await reconcileWorldBuilds(server, config, "winter", [wide]);
        expect(sent.filter((line) => line.endsWith(" keep"))).toHaveLength(plan.PASTE_CHUNK_LINES);
        expect(Math.max(...trips)).toBeLessThanOrEqual(64);
        expect(plan.readPlaced(config)[0]).toMatchObject({ pasted: 1, up: false });
    }, 30_000);
});

describe("a site as players leave the world", () => {
    let logged: string[] = [];
    beforeEach(() => {
        config = {};
        logged = [];
        vi.spyOn(console, "info").mockImplementation((line: unknown) => {
            logged.push(String(line));
        });
    });

    /** A hummocky hillside: a block higher every column east and every row
     *  south, falling back every few. */
    const slope = (x: number, z: number) => 64 + (((x % 4) + 4) % 4) + (((z % 2) + 2) % 2);

    it("stands a build on a slope, level with its highest column, on a foundation of air cells", async () => {
        const { server, sent } = fakeServer(slope);
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        expect(placed).toMatchObject({ up: true });
        const { box } = placed!.arena;
        let highest = 0;
        for (let x = box.x1; x <= box.x2; x++)
            for (let z = box.z1; z <= box.z2; z++) highest = Math.max(highest, slope(x, z));
        expect(box.y1).toBe(highest);
        const paste = sent.filter((line) => line.endsWith(" keep"));
        const under = paste.filter((line) => line.includes(" minecraft:dirt keep"));
        expect(under.length).toBeGreaterThan(0);
        // The foundation goes in first, and only above the ground in each column.
        expect(paste.slice(0, under.length)).toEqual(under);
        const foundation = new Set(under.flatMap((line) => cellsOf(line).cells));
        for (const cell of foundation) {
            const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
            expect(y).toBeGreaterThanOrEqual(slope(x, z));
            expect(y).toBeLessThan(box.y1);
        }
        // Down to the ground in every column under the build: nothing floats.
        for (let x = box.x1; x <= box.x2; x++)
            for (let z = box.z1; z <= box.z2; z++)
                for (let y = slope(x, z); y < box.y1; y++)
                    expect(foundation.has(`${x},${y},${z}`)).toBe(true);
        expect(
            logged.some((line) => /: site, origin .+, foundation of \d+ blocks$/.test(line))
        ).toBe(true);
    });

    it("takes the foundation and the build down, and nothing else", async () => {
        const first = fakeServer(slope);
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const placed = plan.readPlaced(config)[0]!;
        const pasted = new Set(
            first.sent
                .filter((line) => line.endsWith(" keep"))
                .flatMap((line) => cellsOf(line).cells)
        );
        const { server, sent } = fakeServer(slope);
        await reconcileWorldBuilds(server, config, null, [tinyBuild()]);
        const { box } = placed.arena;
        const takes = sent.filter((line) => line.includes(" minecraft:air replace "));
        expect(takes.some((line) => line.endsWith(" minecraft:dirt"))).toBe(true);
        for (const line of takes) {
            for (const cell of cellsOf(line).cells) {
                const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
                // Never a cell of the ground, and only cells it pasted - or, for
                // the snow that fell on it, its own box.
                expect(y).toBeGreaterThanOrEqual(slope(x, z));
                if (!line.endsWith(" minecraft:snow")) expect(pasted.has(cell)).toBe(true);
                else expect(y).toBeGreaterThanOrEqual(box.y1);
            }
        }
        // Every cell it pasted is given back.
        const taken = new Set(takes.flatMap((line) => cellsOf(line).cells));
        for (const cell of pasted) expect(taken.has(cell)).toBe(true);
        expect(plan.readPlaced(config)).toEqual([]);
    });

    it("stands on the ground and clears the short grass in its way", async () => {
        // Short grass on every column: the first layer over the ground is not air.
        const grass = (x: number, y: number, z: number) => y === 64;
        const { server, sent } = fakeServer(() => 64, { weeds: grass });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        const { box } = placed!.arena;
        expect(box.y1).toBe(64);
        // Only the grass is emptied, and only in the build's own box.
        const clears = sent.filter((line) => line.includes(" minecraft:air replace "));
        expect(clears.length).toBeGreaterThan(0);
        for (const line of clears) {
            expect(plan.WEEDS.some((weed) => line.endsWith(` replace ${weed}`))).toBe(true);
            for (const cell of cellsOf(line).cells) {
                const [x, y, z] = cell.split(",").map(Number) as [number, number, number];
                expect(x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2).toBe(true);
                expect(y >= box.y1 && y <= box.y2).toBe(true);
            }
        }
    });

    it("clears the grass out of the foundation's cells before the dirt goes in", async () => {
        // Grass on the ground of every column the foundation fills.
        const grass = (x: number, y: number, z: number) => y === slope(x, z);
        const { server, sent } = fakeServer(slope, { weeds: grass });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        const { box } = placed!.arena;
        const firstDirt = sent.findIndex((line) => line.includes(" minecraft:dirt keep"));
        expect(firstDirt).toBeGreaterThan(-1);
        const cleared = new Set(
            sent
                .slice(0, firstDirt)
                .filter((line) => line.endsWith(" minecraft:air replace minecraft:short_grass"))
                .flatMap((line) => cellsOf(line).cells)
        );
        let under = 0;
        for (let x = box.x1; x <= box.x2; x++)
            for (let z = box.z1; z <= box.z2; z++) {
                const y = slope(x, z);
                if (y >= box.y1) continue;
                under += 1;
                expect(cleared.has(`${x},${y},${z}`)).toBe(true);
            }
        expect(under).toBeGreaterThan(0);
    });

    it("clears every name the grass has had, the one before 1.20.3 too", () => {
        const lines = plan.clearWeeds({ x1: 0, y1: 64, z1: 0, x2: 1, y2: 65, z2: 1 });
        for (const weed of ["minecraft:short_grass", "minecraft:grass", "minecraft:tall_grass"])
            expect(lines.some((line) => line.endsWith(` minecraft:air replace ${weed}`))).toBe(
                true
            );
    });

    it("leaves the grass of a site it turns down as it was", async () => {
        // Grass under something no lift gets over: the site is never built on.
        const grass = (x: number, y: number, z: number) => y === 64;
        const tall = (x: number, y: number, z: number) => y >= 65 && y < 67;
        const { server, sent } = fakeServer(() => 64, { weeds: grass, solid: tall });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toEqual([]);
        expect(sent.some((line) => line.includes(" minecraft:air replace "))).toBe(false);
        const verdicts = logged.filter((line) => line.includes(" site "));
        expect(verdicts.length).toBeGreaterThan(0);
        expect(verdicts.every((line) => line.endsWith(": not-air"))).toBe(true);
    });

    it("lifts a build over the flowers in its way, which stay under the foundation", async () => {
        // A flower on every column: never replaced, so the build goes over it.
        const flowers = (x: number, y: number, z: number) => y === 64;
        const { server, sent } = fakeServer(() => 64, { solid: flowers });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        expect(placed!.arena.box.y1).toBe(65);
        const under = sent.filter((line) => line.includes(" minecraft:dirt keep"));
        // Round the grass, with keep: it is never replaced.
        expect(under.length).toBeGreaterThan(0);
        expect(
            under.every((line) => / 64 -?\d+ -?\d+ 64 -?\d+ minecraft:dirt keep$/.test(line))
        ).toBe(true);
    });

    it("turns a site down while ground or anything else is in the build's box", async () => {
        // Something three high on every column: more than any lift gets over.
        const tall = (x: number, y: number, z: number) => y >= 64 && y < 67;
        const { server, sent } = fakeServer(() => 64, { solid: tall });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toEqual([]);
        expect(sent.some((line) => line.endsWith(" keep"))).toBe(false);
        const verdicts = logged.filter((line) => line.includes(" site "));
        expect(verdicts.length).toBe(6);
        expect(verdicts.every((line) => line.endsWith(": not-air"))).toBe(true);
    });

    it("never builds over a tree, nor over something somebody left on the ground", async () => {
        const near = (x: number, z: number) => Math.hypot(x, z) < 60;
        for (const world of [
            { tree: near, why: "covered" },
            { stray: (x: number, z: number, dy: number) => dy === 0 && near(x, z), why: "occupied" }
        ] as const) {
            config = {};
            logged = [];
            const { server, sent } = fakeServer(() => 64, world);
            await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
            expect(plan.readPlaced(config)).toEqual([]);
            expect(sent.some((line) => line.endsWith(" keep"))).toBe(false);
            const verdicts = logged.filter((line) => line.includes(" site "));
            expect(verdicts.every((line) => line.endsWith(`: ${world.why}`))).toBe(true);
        }
    });

    it("reads every cell the foundation may fill, however far over the ground it is", async () => {
        // Steps three high: the foundation in a low column reaches three cells up.
        const steps = (x: number) => 64 + 3 * (((x % 2) + 2) % 2);
        for (const world of [
            // A torch on the step's face, two over the low ground: turned down.
            { stray: (x: number, z: number, dy: number) => dy === 2 && steps(x) === 64, up: false },
            // The same two over the high ground, clear of any foundation: built on.
            { stray: (x: number, z: number, dy: number) => dy === 2 && steps(x) === 67, up: true }
        ]) {
            config = {};
            logged = [];
            const { server, sent } = fakeServer(steps, world);
            await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
            expect(plan.readPlaced(config).length).toBe(world.up ? 1 : 0);
            expect(sent.some((line) => line.endsWith(" keep"))).toBe(world.up);
            if (!world.up)
                expect(
                    logged
                        .filter((line) => line.includes(" site "))
                        .every((line) => line.endsWith(": occupied"))
                ).toBe(true);
        }
    });

    /** A 64 x 64 slab of stone, the largest a build may be. */
    const slab = format.polarisBuildSchema.parse({
        format: "polaris-build",
        version: 1,
        id: "slab",
        season: "winter",
        size: { x: format.SIDE_MAX, y: 1, z: format.SIDE_MAX },
        palette: [format.AIR, "minecraft:stone"],
        blocks: format.encodeCells(Array.from({ length: format.SIDE_MAX ** 2 }, () => 1))
    });
    const summoned = (sent: readonly string[]) =>
        sent.filter((line) => line.includes(" summon minecraft:armor_stand ")).length;

    it("turns uneven ground down from a sample, without a marker on every column", async () => {
        const { server, sent } = fakeServer(cliffs);
        await reconcileWorldBuilds(server, config, "winter", [slab]);
        expect(plan.readPlaced(config)).toEqual([]);
        const verdicts = logged.filter((line) => line.includes(" site "));
        expect(verdicts).toHaveLength(6);
        expect(verdicts.every((line) => line.endsWith(": uneven"))).toBe(true);
        expect(summoned(sent)).toBeLessThanOrEqual(6 * 17 * 17);
    });

    it("reads every column of no more sites a pass than one of the largest build", async () => {
        const { server, sent } = fakeServer(() => 64, { stray: (x, z, dy) => dy === 0 });
        await reconcileWorldBuilds(server, config, "winter", [slab]);
        expect(plan.readPlaced(config)).toEqual([]);
        const verdicts = logged.filter((line) => line.includes(" site "));
        expect(verdicts).toEqual([expect.stringMatching(/: occupied$/)]);
        expect(summoned(sent)).toBeLessThanOrEqual(17 * 17 + format.SIDE_MAX ** 2);
        expect(plan.readSiteSearches(config)["slab"]).toMatchObject({ next: 1 });
    }, 30_000);

    it("reaches the far rings when nothing nearer will do", async () => {
        const rugged = (x: number, z: number) => (Math.hypot(x, z) < 150 ? cliffs(x) : 64);
        const fake = fakeServer(rugged);
        for (let pass = 0; pass < 40 && plan.readPlaced(config).length === 0; pass++)
            await reconcileWorldBuilds(fake.server, config, "winter", [tinyBuild()]);
        const [placed] = plan.readPlaced(config);
        expect(placed).toMatchObject({ up: true });
        const { box } = placed!.arena;
        expect(Math.hypot((box.x1 + box.x2) / 2, (box.z1 + box.z2) / 2)).toBeGreaterThanOrEqual(
            150
        );
    });
});

// ------------------------------------------------------------ site search

describe("the search for a site", () => {
    /** Cliffs everywhere: no site anywhere, every one surveyed is uneven. */
    const stepped = cliffs;

    /** `fakeServer` with a bed at `bed` and a player standing at `standing`. */
    function bedServer(bed: { x: number; z: number }, standing = { x: 0.5, z: 0.5 }) {
        const fake = fakeServer(stepped);
        const say = fake.server.say.bind(fake.server);
        fake.server.say = async (argv) => {
            if (argv[0]!.endsWith("respawn.pos"))
                return `Steve has the following entity data: [I; ${bed.x}, 64, ${bed.z}]`;
            if (argv[0]!.includes("@a[distance=0..]"))
                return `Steve has the following entity data: [${standing.x}d, 64.0d, ${standing.z}d]`;
            return say(argv);
        };
        return fake;
    }

    let logged: string[] = [];
    beforeEach(() => {
        config = {};
        logged = [];
        vi.spyOn(console, "info").mockImplementation((line: unknown) => {
            logged.push(String(line));
        });
    });

    const searchOf = () => plan.readSiteSearches(config)["test-build"];
    const surveyed = () =>
        logged
            .filter((line) => line.includes(" site "))
            .map((line) => /site (\d+)\//.exec(line)![1]);

    it("searches round the same homes in the same order, wherever the players stand", () => {
        const beds = [
            { x: 100, z: 5 },
            { x: -20, z: 7 },
            { x: 100, z: 5 }
        ];
        expect(plan.stableHomes(beds, [{ x: 3, z: 9 }])).toEqual([
            { x: -20, z: 7 },
            { x: 100, z: 5 }
        ]);
        expect(plan.stableHomes([], [{ x: 3.5, z: 47 }])).toEqual([{ x: 0, z: 32 }]);
        expect(plan.stableHomes([], [{ x: 10, z: 40 }])).toEqual([{ x: 0, z: 32 }]);
    });

    it("writes where it stopped, and logs the verdict of every site it surveyed", async () => {
        const { server } = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(searchOf()).toMatchObject({ next: 6 });
        expect(surveyed()).toEqual(["1", "2", "3", "4", "5", "6"]);
        expect(logged.every((line) => line.startsWith("[minecraft-seasonal] "))).toBe(true);
        expect(logged.every((line) => line.endsWith(": uneven"))).toBe(true);
    });

    it("goes on where it stopped after a restart, from what the config says", async () => {
        const first = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        vi.resetModules();
        const fresh =
            await import("@polaris-app/game-servers/src/lib/minecraft/world-builds/service");
        logged = [];
        const again = bedServer({ x: 0, z: 0 });
        again.server.installedAppId = first.server.installedAppId;
        await fresh.reconcileWorldBuilds(again.server, config, "winter", [tinyBuild()]);
        expect(surveyed()).toEqual(["7", "8", "9", "10", "11", "12"]);
        expect(searchOf()).toMatchObject({ next: 12 });
    });

    it("keeps its place while the players walk about: only their beds make the list", async () => {
        const first = bedServer({ x: 0, z: 0 }, { x: 0.5, z: 0.5 });
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const list = searchOf()!.list;
        const moved = bedServer({ x: 0, z: 0 }, { x: 300.5, z: -90.5 });
        moved.server.installedAppId = first.server.installedAppId;
        await reconcileWorldBuilds(moved.server, config, "winter", [tinyBuild()]);
        expect(searchOf()).toMatchObject({ list, next: 12 });
    });

    it("goes on after the last site it surveyed when somebody with a bed comes online", async () => {
        const first = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const { last } = searchOf()!;
        const two = fakeServer(stepped);
        two.server.installedAppId = first.server.installedAppId;
        const say = two.server.say.bind(two.server);
        two.server.say = async (argv) =>
            argv[0]!.endsWith("respawn.pos")
                ? [
                      "Steve has the following entity data: [I; 0, 64, 0]",
                      "Alex has the following entity data: [I; 500, 64, 500]"
                  ].join("\n")
                : say(argv);
        logged = [];
        await reconcileWorldBuilds(two.server, config, "winter", [tinyBuild()]);
        const centers = plan.candidateCenters(
            [
                { x: 0, z: 0 },
                { x: 500, z: 500 }
            ],
            tinyBuild(),
            Number.POSITIVE_INFINITY
        );
        const after = centers.findIndex((one) => one.x === last!.x && one.z === last!.z) + 1;
        expect(after).toBeGreaterThan(0);
        expect(surveyed()[0]).toBe(String(after + 1));
        expect(searchOf()).toMatchObject({ list: plan.listDigest(centers), next: after + 6 });
    });

    it("starts again from the nearest when somebody sleeps somewhere else", async () => {
        const first = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(first.server, config, "winter", [tinyBuild()]);
        const list = searchOf()!.list;
        logged = [];
        const elsewhere = bedServer({ x: 500, z: 500 });
        elsewhere.server.installedAppId = first.server.installedAppId;
        await reconcileWorldBuilds(elsewhere.server, config, "winter", [tinyBuild()]);
        expect(surveyed()[0]).toBe("1");
        expect(searchOf()!.list).not.toBe(list);
        expect(searchOf()!.next).toBe(6);
    });

    it("forgets the search once a site is found, and says where the build went", async () => {
        // Level from 40 blocks out: the first pass finds nothing, a later one does.
        const far = (x: number, z: number) => (Math.hypot(x, z) < 40 ? stepped(x) : 64);
        const fake = fakeServer(far);
        await reconcileWorldBuilds(fake.server, config, "winter", [tinyBuild()]);
        expect(searchOf()).toMatchObject({ next: 6 });
        for (let pass = 0; pass < 8 && plan.readPlaced(config).length === 0; pass++)
            await reconcileWorldBuilds(fake.server, config, "winter", [tinyBuild()]);
        expect(plan.readPlaced(config)).toHaveLength(1);
        expect(searchOf()).toBeUndefined();
        expect(logged.some((line) => /: site, origin -?\d+ 64 -?\d+$/.test(line))).toBe(true);
        expect(logged.some((line) => line.includes(": placing test-build at "))).toBe(true);
    });

    it("works on a config written before the search was, or one it cannot read", async () => {
        config = { somethingElse: true };
        const { server } = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(config.somethingElse).toBe(true);
        expect(searchOf()).toMatchObject({ next: 6 });
        config = { ...config, [plan.SITE_SEARCH_KEY]: "garbled" };
        logged = [];
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(surveyed()[0]).toBe("1");
        expect(plan.readSiteSearches({ [plan.SITE_SEARCH_KEY]: [1, 2] })).toEqual({});
        expect(
            plan.readSiteSearches({ [plan.SITE_SEARCH_KEY]: { a: { list: "x", next: -1 } } })
        ).toEqual({});
    });

    it("drops the searches of a season that is over", async () => {
        const { server } = bedServer({ x: 0, z: 0 });
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(searchOf()).toBeDefined();
        await reconcileWorldBuilds(server, config, null, [tinyBuild()]);
        expect(config[plan.SITE_SEARCH_KEY]).toEqual({});
    });
});

describe("connections to the game in a pass", () => {
    beforeEach(() => {
        config = {};
    });

    /** The same fake, taking several reads in one connection the way `sayEach`
     *  does, and counting connections: one per `say`, `sayAll` and `sayEach`. */
    function counted(made: ReturnType<typeof fakeServer>) {
        const plain = made.server as unknown as {
            say: (argv: readonly string[]) => Promise<string>;
            sayAll: (lines: readonly string[]) => Promise<void>;
        };
        const counts = { say: 0, sayAll: 0, sayEach: 0 };
        const server = {
            ...made.server,
            say: async (argv: readonly string[]) => {
                counts.say += 1;
                return plain.say(argv);
            },
            sayAll: async (lines: readonly string[]) => {
                counts.sayAll += 1;
                return plain.sayAll(lines);
            },
            sayEach: async (commands: readonly (readonly string[])[]) => {
                counts.sayEach += 1;
                const answers: string[] = [];
                for (const argv of commands) answers.push(await plain.say(argv));
                return answers;
            }
        } as unknown as ServerContainer;
        return { server, counts, said: made.said };
    }

    const total = (counts: { say: number; sayAll: number; sayEach: number }) =>
        counts.say + counts.sayAll + counts.sayEach;

    it("surveys a site in a handful of connections, with the verdict reading one at a time gave", async () => {
        const world = { stray: (_x: number, _z: number, dy: number) => dy === 1 };
        const before = fakeServer(() => 64, world);
        await reconcileWorldBuilds(before.server, config, "winter", [tinyBuild()]);
        const alone = before.said.length;
        const verdict = {
            searches: plan.readSiteSearches(config),
            placed: plan.readPlaced(config)
        };

        config = {};
        const after = counted(fakeServer(() => 64, world));
        await reconcileWorldBuilds(after.server, config, "winter", [tinyBuild()]);
        expect({
            searches: plan.readSiteSearches(config),
            placed: plan.readPlaced(config)
        }).toEqual(verdict);
        // One connection a read before; a few per site now.
        expect(alone).toBeGreaterThan(30);
        expect(total(after.counts)).toBeLessThan(alone / 2);
    });

    it("reads where the players live once a pass, however many builds look for a site", async () => {
        const two = [tinyBuild(), { ...tinyBuild(), id: "test-build-2" }];
        const { server, said } = counted(fakeServer(() => 64, { tree: () => true }));
        await reconcileWorldBuilds(server, config, "winter", two);
        expect(said.filter((line) => line.endsWith("@s SpawnX"))).toHaveLength(1);
    });

    it("puts the same build in the same place as reading one at a time did", async () => {
        const alone = fakeServer();
        await reconcileWorldBuilds(alone.server, config, "winter", [tinyBuild()]);
        // The batch key is the install's own: everything else is the same.
        const where = () =>
            plan.readPlaced(config).map(({ arena: { box }, id, pasted, up }) => ({
                box,
                id,
                pasted,
                up
            }));
        const placed = where();
        config = {};
        const { server } = counted(fakeServer());
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        expect(where()).toEqual(placed);
        expect(placed).toHaveLength(1);
    });
});
