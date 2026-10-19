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
        const { WORLD_BUILDS } = await import(
            "@polaris-app/game-servers/src/lib/minecraft/world-builds/catalog"
        );
        const { DECORATIONS } = await import(
            "@polaris-app/game-servers/src/lib/minecraft/seasonal"
        );
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
            `execute in minecraft:overworld run fill ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y1} ${box.z1} minecraft:air replace minecraft:stone`
        );
        expect(sent.some((line) => line.endsWith(" keep"))).toBe(false);
        expect(plan.readPlaced(config)).toEqual([]);
    });

    it("surveys with markers of its own, which an event's mark or survey never reads or clears", async () => {
        const { server, sent, said } = fakeServer();
        await reconcileWorldBuilds(server, config, "winter", [tinyBuild()]);
        const markers = [...sent, ...said].filter((line) => line.includes("@e[tag="));
        expect(markers.length).toBeGreaterThan(0);
        expect(markers.every((line) => line.includes("@e[tag=pw_samp]"))).toBe(true);
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
