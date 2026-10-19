/**
 * Seasonal builds placed in a server's world: the Polaris build format, the
 * offline converter, where a build may go, the paced paste, and the teardown
 * that gives back exactly what was there.
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

const { reconcileWorldBuilds } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/world-builds/service"
);

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

    it("refuses an MCEdit schematic by name instead of guessing its numeric ids", () => {
        const source = file("Schematic", [
            [2, "Width", short(1)],
            [2, "Height", short(1)],
            [2, "Length", short(1)],
            [8, "Materials", nbtString("Alpha")],
            [7, "Blocks", bytes([1])]
        ]);
        expect(() => convert.convertSponge(source, "old", "winter")).toThrow(/MCEdit/);
    });
});

describe("where a build goes", () => {
    it("looks round the homes, nearest ring first, clear of the door", () => {
        const centers = plan.candidateCenters([{ x: 0, z: 0 }], tinyBuild(), 8);
        expect(centers).toHaveLength(8);
        for (const spot of centers) expect(Math.hypot(spot.x, spot.z)).toBeGreaterThanOrEqual(24);
        expect(centers[0]).toEqual({ x: 26, z: 0 });
    });

    it("takes level, open ground only", () => {
        const build = tinyBuild();
        const level = [{ y: 64 }, { y: 64 }, { y: 65 }, { y: 64 }];
        expect(plan.judgeSite(4, level, 0, build)).toEqual({ y: 65 });
        expect(plan.judgeSite(4, [...level.slice(0, 3), { y: 62 }], 0, build)).toEqual({
            why: "uneven"
        });
        expect(plan.judgeSite(4, level, 1, build)).toEqual({ why: "covered" });
        expect(plan.judgeSite(4, level.slice(0, 3), 0, build)).toEqual({ why: "unloaded" });
        expect(
            plan.judgeSite(4, [{ y: 319 }, { y: 319 }, { y: 319 }, { y: 319 }], 0, build)
        ).toEqual({ why: "too-high" });
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
    it("gives back air for every kind it placed, inside its own box only, and no sweep", () => {
        const placed = plan.placedFor(tinyBuild(), { x: 10, y: 64, z: 20 }, "pwkey");
        expect(placed.arena.blocks).toEqual(["minecraft:lantern", "minecraft:stone"]);
        const lines = plan.restoreLines(placed);
        expect(lines).toContain(
            "execute in minecraft:overworld run fill 10 64 20 12 65 21 minecraft:air replace minecraft:stone"
        );
        expect(lines).toContain(
            "execute in minecraft:overworld run fill 10 64 20 12 65 21 minecraft:air replace minecraft:lantern"
        );
        for (const line of lines.filter((one) => one.includes(" fill "))) {
            expect(line).toMatch(/ fill 10 64 20 12 65 21 minecraft:air replace /);
        }
        expect(lines.indexOf(lines.find((one) => one.endsWith("minecraft:lantern"))!)).toBeLessThan(
            lines.indexOf(lines.find((one) => one.endsWith("minecraft:stone"))!)
        );
    });

    it("forgets a written-down build only when it parses", () => {
        const placed = plan.placedFor(tinyBuild(), { x: 0, y: 64, z: 0 });
        expect(plan.readPlaced({ [plan.WORLD_BUILDS_KEY]: [placed, { id: 3 }] })).toEqual([placed]);
        expect(plan.readPlaced({})).toEqual([]);
    });
});

// ------------------------------------------------------------------ service

let ids = 0;

/** A vanilla server on level ground at y 64 with nobody's builds on it. */
function fakeServer() {
    const said: string[] = [];
    const sent: string[] = [];
    const columns: { x: number; z: number }[] = [];
    const server = {
        installedAppId: `world-${(ids += 1)}`,
        edition: "java",
        running: true,
        say: async ([command]: readonly string[]) => {
            said.push(command!);
            if (command!.includes("@a[distance=0..]"))
                return "Steve has the following entity data: [0.5d, 64.0d, 0.5d]";
            if (
                command!.startsWith("execute as @e[tag=") &&
                command!.endsWith("run data get entity @s Pos") &&
                !command!.includes(" if block ") &&
                !command!.includes(" unless block ")
            )
                return columns
                    .map(
                        (one) =>
                            `Marker has the following entity data: [${one.x + 0.5}d, 64.0d, ${one.z + 0.5}d]`
                    )
                    .join("\n");
            if (command!.includes(" if blocks ")) return "Test passed, count: 0";
            return "";
        },
        sayAll: async (lines: readonly string[]) => {
            for (const line of lines) {
                const top =
                    / positioned (-?\d+(?:\.\d+)?) 0 (-?\d+(?:\.\d+)?) positioned over /.exec(line);
                if (top)
                    columns.push({ x: Math.floor(Number(top[1])), z: Math.floor(Number(top[2])) });
                if (line.startsWith("kill @e[tag=")) columns.length = 0;
            }
            sent.push(...lines);
        }
    } as unknown as ServerContainer;
    return { server, said, sent };
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
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} minecraft:air replace minecraft:stone`
        );
        expect(sent.some((line) => line.endsWith(" keep"))).toBe(false);
        expect(plan.readPlaced(config)).toEqual([]);
    });
});
