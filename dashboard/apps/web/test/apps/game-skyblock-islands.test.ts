/**
 * The Skyblock 2.1 map's extra islands, and the console visit that puts them up.
 *
 * What is asserted is that the islands come out the same every time, stay clear
 * of the map's own islands, the players' bridge and each other, only ever fill
 * air with lines the console takes, and that the walk puts them up once, only on
 * a server playing this map, only in the map's own world.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMap } from "@polaris-app/game-servers/src/lib/minecraft/maps";
import * as islands from "@polaris-app/game-servers/src/lib/minecraft/skyblock-islands";
import { COMMAND_BYTES_MAX } from "@polaris-app/game-servers/src/lib/minecraft/command-size";

let install = { config: "{}" };
/** Whether the fake world has its start island. */
let startThere = true;
/** The islands standing in the fake world. */
let standing = new Set<string>();
/** Islands whose lines the fake world ignores, as an unloaded chunk would. */
let unloaded = new Set<string>();
/** Every line the server was sent, in order. */
let sent: string[] = [];
/** Whether the fake server is up. */
let running = true;

vi.mock("@/lib/apps/install-config", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/apps/install-config")>();
    return {
        ...real,
        patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
            install = { config: JSON.stringify({ ...JSON.parse(install.config), ...patch }) };
        }
    };
});

/** What the fake world answers to one line. */
function answer(line: string): string {
    sent.push(line);
    if (line === islands.START_PRESENT) return startThere ? "Test passed" : "Test failed";
    const island = islands.ISLANDS.find((one) => islands.presentLine(one) === line);
    if (island) {
        if (unloaded.has(island.id)) return "That position is not loaded";
        return standing.has(island.id) ? "Test passed" : "Test failed";
    }
    return "";
}

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (
        _ownerId: string,
        _installedAppId: string,
        work: (server: unknown) => Promise<unknown>
    ) =>
        work({
            running,
            edition: "java",
            say: async (argv: string[]) => answer(argv.join(" ")),
            sayAll: async (lines: string[]) => {
                for (const line of lines) {
                    answer(line);
                    for (const island of islands.ISLANDS) {
                        if (!unloaded.has(island.id) && islands.placeLines(island).at(-1) === line)
                            standing.add(island.id);
                    }
                }
            }
        })
}));

const { applySkyblockIslands } =
    await import("@polaris-app/game-servers/src/lib/minecraft/skyblock-islands-service");

const walk = () => applySkyblockIslands("owner", "install", install.config);
const stored = () => JSON.parse(install.config) as Record<string, unknown>;
const placed = () => sent.filter((line) => / (fill|setblock) /.test(line));

beforeEach(() => {
    install = { config: JSON.stringify({ mapId: "skyblock-2-1" }) };
    startThere = true;
    standing = new Set();
    unloaded = new Set();
    sent = [];
    running = true;
});

describe("the islands", () => {
    it("are the map's own catalog entry's", () => {
        expect(findMap(islands.SKYBLOCK_MAP_ID)?.category).toBe("skyblock");
    });

    it("come out the same every time", async () => {
        vi.resetModules();
        const again = await import("@polaris-app/game-servers/src/lib/minecraft/skyblock-islands");
        expect(again.ISLANDS.map((one) => again.placeLines(one))).toEqual(
            islands.ISLANDS.map((one) => islands.placeLines(one))
        );
    });

    it("are eight to twelve small ones, at a sensible height", () => {
        expect(islands.ISLANDS.length).toBeGreaterThanOrEqual(8);
        expect(islands.ISLANDS.length).toBeLessThanOrEqual(12);
        expect(new Set(islands.ISLANDS.map((one) => one.id)).size).toBe(islands.ISLANDS.length);
        for (const island of islands.ISLANDS) {
            const area = islands.areaOf(island);
            expect(area.x2 - area.x1 + 1).toBeLessThanOrEqual(15);
            expect(area.z2 - area.z1 + 1).toBeLessThanOrEqual(15);
            expect(island.center.y).toBeGreaterThanOrEqual(60);
            expect(island.center.y).toBeLessThanOrEqual(80);
        }
    });

    it("never reach the start island, the sand island or the bridge", () => {
        for (const island of islands.ISLANDS) {
            expect(islands.overlaps(islands.areaOf(island), islands.PROTECTED_AREA)).toBe(false);
        }
    });

    it("stand apart from each other, and each within reach of another", () => {
        const all = islands.ISLANDS;
        for (const [at, island] of all.entries()) {
            const distances = all
                .filter((_, other) => other !== at)
                .map((other) =>
                    Math.hypot(other.center.x - island.center.x, other.center.z - island.center.z)
                );
            expect(Math.min(...distances)).toBeGreaterThanOrEqual(40);
            expect(Math.min(...distances)).toBeLessThanOrEqual(150);
            for (const other of all.slice(at + 1))
                expect(islands.overlaps(islands.areaOf(island), islands.areaOf(other))).toBe(false);
        }
    });

    it("only fill air, with lines the console takes", () => {
        for (const island of islands.ISLANDS) {
            for (const line of [
                ...islands.placeLines(island),
                ...island.extras,
                islands.presentLine(island),
                islands.forceloadLine(island, true),
                islands.forceloadLine(island, false)
            ]) {
                expect(Buffer.byteLength(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
                expect(line).not.toMatch(/[\0\r\n]/);
                expect(line.split(" ").length).toBeLessThanOrEqual(24);
                if (/ (fill|setblock) /.test(line)) expect(line.endsWith(" keep")).toBe(true);
            }
            for (const line of islands.placeLines(island)) {
                const fill =
                    / fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:[a-z_]+(\[[a-z_=0-9,]+\])? keep$/.exec(
                        line
                    );
                const set =
                    / setblock -?\d+ -?\d+ -?\d+ minecraft:[a-z_]+(\[[a-z_=0-9,]+\])? keep$/.test(
                        line
                    );
                expect(Boolean(fill) || set).toBe(true);
                if (fill) {
                    const [x1, y1, z1, x2, y2, z2] = fill.slice(1, 7).map(Number) as number[];
                    expect((x2! - x1! + 1) * (y2! - y1! + 1) * (z2! - z1! + 1)).toBeLessThanOrEqual(
                        32768
                    );
                }
            }
        }
    });

    it("place every block once, solid ones before what rests on them", () => {
        for (const island of islands.ISLANDS) {
            const keys = island.cells.map((cell) => `${cell.x},${cell.y},${cell.z}`);
            expect(new Set(keys).size).toBe(keys.length);
            const solid = new Map(
                island.cells
                    .filter((cell) => !cell.attached)
                    .map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell])
            );
            expect(solid.has(`${island.anchor.x},${island.anchor.y},${island.anchor.z}`)).toBe(
                true
            );
            for (const cell of island.cells) {
                const below = solid.get(`${cell.x},${cell.y - 1},${cell.z}`);
                if (islands.isFalling(cell.block))
                    expect(below, `${island.id} ${cell.block}`).toBeDefined();
                if (islands.isFluid(cell.block)) {
                    // A source held in a pit of its own: nothing it can run out of.
                    for (const [dx, dz] of [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1]
                    ] as const)
                        expect(
                            solid.has(`${cell.x + dx},${cell.y},${cell.z + dz}`),
                            island.id
                        ).toBe(true);
                    expect(below).toBeDefined();
                }
            }
            const lines = islands.placeLines(island);
            const firstAttached = lines.findIndex((line) =>
                island.cells.some((cell) => cell.attached && line.includes(` ${cell.block} keep`))
            );
            const lastSolidY = Math.max(...[...solid.values()].map((cell) => cell.y));
            const ys = lines
                .slice(0, firstAttached === -1 ? -1 : firstAttached)
                .map((line) => Number(/ (?:fill|setblock) -?\d+ (-?\d+) /.exec(line)![1]));
            expect(ys).toEqual([...ys].sort((a, b) => a - b));
            expect(Math.max(...ys)).toBe(lastSolidY);
            const { x, y, z } = island.anchor;
            expect(lines.at(-1)).toMatch(new RegExp(` setblock ${x} ${y} ${z} `));
            expect(lines.filter((line) => line.includes(` ${x} ${y} ${z} `))).toHaveLength(1);
        }
    });

    it("use only blocks the oldest release the map runs on has", () => {
        const newer =
            /deepslate|copper|cherry|mangrove|mud|amethyst|short_grass|powder_snow|azalea|moss_block|bamboo_block/;
        for (const island of islands.ISLANDS) {
            for (const cell of island.cells) expect(cell.block).not.toMatch(newer);
        }
    });
});

describe("the walk", () => {
    it("puts every island up once, fills the chests once and lets the chunks go", async () => {
        await walk();
        expect(standing.size).toBe(islands.ISLANDS.length);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
        expect(sent.filter((line) => line.includes(" loot insert "))).toHaveLength(2);
        expect(sent.filter((line) => line.includes(" summon minecraft:bee "))).toHaveLength(2);
        const removed = sent.filter((line) => line.includes(" forceload remove "));
        expect(removed).toHaveLength(islands.ISLANDS.length);
        expect(sent.lastIndexOf(removed.at(-1)!)).toBe(sent.length - 1);

        sent = [];
        await walk();
        expect(sent).toEqual([]);
    });

    it("leaves a server that is not on the map alone", async () => {
        for (const config of [{}, { mapId: "parkour-spiral" }, { mapId: "" }]) {
            install = { config: JSON.stringify(config) };
            await walk();
        }
        expect(sent).toEqual([]);
    });

    it("leaves a server that is not running alone, and asks again later", async () => {
        running = false;
        await walk();
        expect(sent).toEqual([]);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBeUndefined();
    });

    it("puts nothing into a world that is not the map's", async () => {
        startThere = false;
        await walk();
        expect(placed()).toEqual([]);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
    });

    it("adds only the missing ones, and never refills a standing island's chests", async () => {
        standing = new Set(
            islands.ISLANDS.filter((one) => one.id !== "frost").map((one) => one.id)
        );
        await walk();
        const frost = islands.ISLANDS.find((one) => one.id === "frost")!;
        expect(placed()).toEqual(islands.placeLines(frost));
        expect(sent.some((line) => line.includes(" loot insert "))).toBe(false);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
    });

    it("holds the chunks of an island that did not go up, and finishes on a later pass", async () => {
        unloaded = new Set(["ruins"]);
        await walk();
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBeUndefined();
        expect(stored()[islands.SKYBLOCK_ISLANDS_TRIES_KEY]).toBe(1);
        expect(sent.some((line) => line.includes(" forceload remove "))).toBe(false);

        unloaded = new Set();
        sent = [];
        await walk();
        expect(standing.has("ruins")).toBe(true);
        expect(sent.filter((line) => line.includes(" loot insert "))).toHaveLength(2);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
    });

    it("finishes an island whose pass stopped halfway, and fills its chests then", async () => {
        const ruins = islands.ISLANDS.find((one) => one.id === "ruins")!;
        const lines = islands.placeLines(ruins);
        // Everything but the anchor went in before the pass stopped, so it still
        // answers that it is not there.
        standing = new Set(
            islands.ISLANDS.filter((one) => one.id !== "ruins").map((one) => one.id)
        );
        await walk();
        expect(placed()).toEqual(lines);
        expect(standing.has("ruins")).toBe(true);
        expect(sent.filter((line) => line.includes(" loot insert "))).toHaveLength(2);
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
    });

    it("gives up on a world that never takes them, and lets the chunks go", async () => {
        unloaded = new Set(["ruins"]);
        for (let pass = 0; pass < islands.MAX_TRIES; pass += 1) await walk();
        expect(stored()[islands.SKYBLOCK_ISLANDS_KEY]).toBe(true);
        expect(sent.filter((line) => line.includes(" forceload remove "))).toHaveLength(
            islands.ISLANDS.length
        );
        sent = [];
        await walk();
        expect(sent).toEqual([]);
    });
});
