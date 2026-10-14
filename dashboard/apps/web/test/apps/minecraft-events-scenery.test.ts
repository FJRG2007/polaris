/**
 * The biome scenery round every structure an event builds in the sky
 * (`kinds/scenery`), exactly as the stage's build works it out
 * (`stage-service.stageScenery`):
 *
 * - every block in the ring round the volume played in, `GAP` clear of it on
 *   every side and inside the volume proved empty with it;
 * - nothing that falls, flows, burns where it must not, or that the server's
 *   version does not have; lava only sealed on every side, built after its
 *   shell and taken out before it;
 * - a bounded build, the same every time it is worked out;
 * - never on a block of the season's dressing;
 * - and every box read back after a restart and taken out, the proved volume
 *   swept whole after it.
 */

import { describe, expect, it } from "vitest";
import * as catalog from "@polaris-app/game-servers/src/lib/minecraft/events/catalog";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import * as scenery from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/scenery";
import * as decor from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-decor";
import * as stageService from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage-service";

const SITE = { x: 300, y: 120, z: -120 };
const SEEDS = 6;
const ERAS: readonly scenery.Era[] = [
    { nether: false, caves: false },
    { nether: true, caves: false },
    { nether: true, caves: true }
];
const NETHER_UPDATE = ids(
    "basalt",
    "blackstone",
    "crimson_stem",
    "warped_stem",
    "warped_wart_block",
    "shroomlight"
);
const CAVES_UPDATE = ids("moss_block");
/** Blocks that must never be scenery: they flow, spread, burn on their own or hold a spawner. */
const NEVER =
    /(water|fire|spawner|vine|grass|sapling|bamboo|coral|cocoa|(^minecraft:ice$)|snow$|dripstone|powder|sand$|gravel)/;

function ids(...names: string[]): string[] {
    return names.map((one) => `minecraft:${one}`);
}

function run(kind: catalog.EventKind, options: Record<string, unknown> = {}, id = "run-1") {
    const preset = catalog.newPreset(kind, "test");
    return {
        id,
        preset: { ...preset, options: { ...preset.options, ...options } },
        joined: Array.from({ length: 6 }, (_, index) => `Player${index}`),
        place: SITE,
        stage: null,
        arena: null
    } as never;
}

const KINDS: readonly { kind: catalog.EventKind; options?: Record<string, unknown> }[] = [
    { kind: "parkour", options: { theme: "classic" } },
    { kind: "parkour", options: { theme: "jungle" } },
    { kind: "parkour", options: { theme: "nether" } },
    { kind: "parkour", options: { theme: "frost" } },
    { kind: "boat-race" },
    { kind: "downhill-race" },
    { kind: "elytra-race" },
    { kind: "spleef" },
    { kind: "tnt-run" }
];

interface Case {
    readonly name: string;
    readonly kind: catalog.EventKind;
    readonly run: never;
    readonly volume: stage.Volume;
    readonly outer: stage.Volume | null;
}

const cases: Case[] = KINDS.flatMap(({ kind, options }) =>
    Array.from({ length: SEEDS }, (_, seed): Case => {
        const kindRun = run(kind, options, `run-${seed}`);
        return {
            name: `${kind} ${JSON.stringify(options ?? {})} ${seed}`,
            kind,
            run: kindRun,
            volume: stageService.stageLayout(kindRun, SITE).volume,
            outer: stageService.stageSceneryVolume(kindRun, SITE)
        };
    })
);

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

function cellMap(boxes: readonly stage.Box[]): Map<string, { block: string; index: number }> {
    const cells = new Map<string, { block: string; index: number }>();
    boxes.forEach((one, index) => {
        for (const cell of scenery.cellsOf(one)) {
            const at = key(cell.x, cell.y, cell.z);
            // `keep`: a cell is the first box's that fills it.
            if (!cells.has(at)) cells.set(at, { block: one.block, index });
        }
    });
    return cells;
}

describe("the biome scenery round an event in the sky", () => {
    it("is drawn round every open-air kind built in the sky, never an enclosed one", () => {
        for (const one of cases) expect(one.outer, one.name).not.toBeNull();
        // A dropper's shaft is too tall to prove a ring round it cheaply: bare.
        const dropper = run("dropper");
        expect(stageService.stageSceneryVolume(dropper, SITE)).toBeNull();
        expect(stageService.stageScenery(dropper, SITE, ERAS[2]!)).toEqual([]);
        const acid = run("acid-rain");
        expect(stageService.stageSceneryVolume(acid, SITE)).toBeNull();
        expect(stageService.stageScenery(acid, SITE, ERAS[2]!)).toEqual([]);
        // A nether maze is roofed and walled: nobody inside would see a ring.
        for (let seed = 0; seed < SEEDS; seed++) {
            const maze = run("nether-maze", undefined, `run-${seed}`);
            expect(stageService.stageSceneryVolume(maze, SITE)).toBeNull();
            expect(stageService.stageScenery(maze, SITE, ERAS[2]!)).toEqual([]);
        }
    });

    it("lists every block it can be among those a stage's state keeps", () => {
        for (const block of scenery.SCENERY_BLOCKS)
            expect(stage.ARENA_BLOCKS as readonly string[]).toContain(block);
    });

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: stays in its ring, clear of the play volume, inside the air proved",
        (_name, one) => {
            const outer = one.outer!;
            const volume = one.volume;
            for (const era of ERAS) {
                const boxes = stageService.stageScenery(one.run, SITE, era);
                expect(boxes.length).toBeGreaterThan(0);
                for (const box of boxes)
                    for (const cell of scenery.cellsOf(box)) {
                        const where = `${box.block} at ${key(cell.x, cell.y, cell.z)}`;
                        expect(cell.x >= outer.x1 && cell.x <= outer.x2, where).toBe(true);
                        expect(cell.y >= outer.y1 && cell.y <= outer.y2, where).toBe(true);
                        expect(cell.z >= outer.z1 && cell.z <= outer.z2, where).toBe(true);
                        // Never over, under or within GAP of any column played in.
                        const near =
                            cell.x >= Math.min(volume.x1, volume.x2) - scenery.GAP &&
                            cell.x <= Math.max(volume.x1, volume.x2) + scenery.GAP &&
                            cell.z >= Math.min(volume.z1, volume.z2) - scenery.GAP &&
                            cell.z <= Math.max(volume.z1, volume.z2) + scenery.GAP;
                        expect(near, where).toBe(false);
                    }
                // The proved volume holds the play volume whole.
                expect(outer.x1).toBeLessThan(Math.min(volume.x1, volume.x2));
                expect(outer.y1).toBeLessThanOrEqual(Math.min(volume.y1, volume.y2));
                expect(outer.y2).toBe(Math.max(volume.y1, volume.y2));
            }
        }
    );

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: nothing that falls, flows or burns where it must not, and only what the version has",
        (_name, one) => {
            for (const era of ERAS) {
                const boxes = stageService.stageScenery(one.run, SITE, era);
                const blocks = new Set(boxes.map((box) => box.block as string));
                for (const block of blocks) {
                    expect(scenery.SCENERY_BLOCKS as readonly string[]).toContain(block);
                    expect(stage.falls(block), block).toBe(false);
                    expect(NEVER.test(decor.bareId(block)), block).toBe(false);
                    if (!era.nether) expect(NETHER_UPDATE).not.toContain(block);
                    if (!era.caves) expect(CAVES_UPDATE).not.toContain(block);
                    // Leaves held, so they never rot and drop saplings.
                    if (block.includes("leaves")) expect(block).toContain("persistent=true");
                }
                if (one.kind === "tnt-run") {
                    for (const block of blocks) expect(scenery.BURNING).not.toContain(block);
                    expect(blocks.has("minecraft:lava")).toBe(false);
                }
                // Lava never beside anything that burns.
                if (blocks.has("minecraft:lava"))
                    for (const block of blocks) expect(scenery.BURNING).not.toContain(block);
            }
        }
    );

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: lava only sealed on every side by its shell, built before it",
        (_name, one) => {
            for (const era of ERAS) {
                const boxes = stageService.stageScenery(one.run, SITE, era);
                const cells = cellMap(boxes);
                boxes.forEach((box, index) => {
                    if (box.block !== "minecraft:lava") return;
                    for (const cell of scenery.cellsOf(box))
                        for (const [dx, dy, dz] of [
                            [1, 0, 0],
                            [-1, 0, 0],
                            [0, 0, 1],
                            [0, 0, -1],
                            [0, -1, 0],
                            [0, 1, 0]
                        ] as const) {
                            const next = cells.get(key(cell.x + dx, cell.y + dy, cell.z + dz));
                            const where = `lava at ${key(cell.x, cell.y, cell.z)} side ${dx},${dy},${dz}`;
                            expect(next, where).toBeDefined();
                            if (next!.block === "minecraft:lava") continue;
                            expect(next!.index, where).toBeLessThan(index);
                        }
                });
            }
        }
    );

    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: bounded, and the same every time",
        (_name, one) => {
            for (const era of ERAS) {
                const boxes = stageService.stageScenery(one.run, SITE, era);
                expect(boxes.length).toBeLessThanOrEqual(scenery.MOST_BOXES);
                const blocks = boxes.reduce((sum, box) => sum + stage.volumeOf(box), 0);
                expect(blocks).toBeLessThanOrEqual(scenery.MOST_BLOCKS);
                expect(stageService.stageScenery(one.run, SITE, era)).toEqual(boxes);
            }
        }
    );

    it("surrounds a parkour course with its own theme's world", () => {
        const has = (theme: string, block: string) =>
            Array.from({ length: SEEDS }, (_, seed) =>
                stageService.stageScenery(run("parkour", { theme }, `run-${seed}`), SITE, ERAS[2]!)
            ).every((boxes) => boxes.some((box) => box.block === block) || boxes.length === 0);
        expect(has("jungle", "minecraft:jungle_leaves[persistent=true]")).toBe(true);
        expect(has("nether", "minecraft:netherrack")).toBe(true);
    });

    it("never shares a block with the season's dressing", () => {
        const dressings: decor.Dressing[] = [
            { season: "halloween", era: { lanterns: true, soulLanterns: true } },
            { season: "winter", era: { lanterns: true, soulLanterns: true } }
        ];
        for (const one of cases)
            for (const dressing of dressings) {
                const cells = cellMap(stageService.stageScenery(one.run, SITE, ERAS[2]!));
                for (const piece of stageService.stageDecor(one.run, SITE, dressing))
                    expect(cells.has(key(piece.x, piece.y, piece.z)), one.name).toBe(false);
            }
    });
});

function fakeServer() {
    const order: string[] = [];
    const server = {
        installedAppId: `scenery-${Math.random()}`,
        edition: "java",
        say: async (lines: readonly string[]) => {
            order.push(...lines);
            return (lines[0] ?? "").includes(" fill ") ? "Successfully filled 1 block(s)" : "";
        },
        sayAll: async (lines: readonly string[]) => {
            order.push(...lines);
        }
    } as unknown as ServerContainer;
    return { server, order };
}

describe("the biome scenery taken down with its structure", () => {
    it.each(cases.map((one) => [one.name, one] as const))(
        "%s: every box read back after a restart, taken out lava first, the proved volume swept",
        async (_name, one) => {
            const layout = stageService.stageLayout(one.run, SITE);
            const surround = stageService.stageScenery(one.run, SITE, ERAS[2]!);
            const boxes = [...layout.boxes, ...surround];
            const leftover = stage.stageLeftoverSchema.parse(
                JSON.parse(
                    JSON.stringify({
                        runId: "run-1",
                        area: null,
                        boxes,
                        saved: [],
                        proved: one.outer
                    })
                )
            );
            expect(leftover.boxes).toEqual(boxes);
            const { server, order } = fakeServer();
            const left = await stageService.settle(
                server,
                leftover,
                { items: "components", top: 319 },
                "en"
            );
            expect(left).toBeNull();
            const firstOwn = order.findIndex((line) =>
                layout.boxes.some((box) => line === stage.removeLine(box))
            );
            surround.forEach((box) => {
                const gone = order.indexOf(stage.removeLine(box));
                expect(gone, `${box.block}`).toBeGreaterThanOrEqual(0);
                expect(gone).toBeLessThan(firstOwn);
            });
            // Lava out before any of the shell built round it, just ahead of it.
            surround.forEach((box, index) => {
                if (box.block !== "minecraft:lava") return;
                const gone = order.indexOf(stage.removeLine(box));
                for (const shell of surround.slice(Math.max(0, index - 6), index))
                    expect(gone).toBeLessThan(order.indexOf(stage.removeLine(shell)));
            });
            expect(order).toEqual(expect.arrayContaining(stage.sweepFills(one.outer!)));
        }
    );
});
