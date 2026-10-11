/**
 * What players leave in an event's space is swept at its end: the volume the
 * probe proved empty air before anything was built is emptied whole once the
 * event's own boxes are out - a block a player put down, a mod's block nobody
 * here knows, the items lying there - and nothing one block past it. A run or
 * a leftover with no proof written down keeps the per-block removal alone.
 */

import { describe, expect, it } from "vitest";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import type { ArenaLeftover } from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import { settle } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage-service";
import { closeArena } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-service";

/** A modded block no list here knows, as a player could smuggle one in. */
const FOREIGN = "examplemod:reinforced_block";
const FILL =
    /fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)(?: (replace|keep|destroy)(?: (\S+))?)?$/;
const COMPARE = /if blocks (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) .* masked$/;

/** A world of blocks the fake server keeps, answering fills as the game does. */
function world(seed: Record<string, string>, refuse: (line: string) => boolean = () => false) {
    const blocks = new Map(Object.entries(seed));
    const lines: string[] = [];
    const answer = (line: string): string | null => {
        lines.push(line);
        if (refuse(line)) return "That position is not loaded";
        if (line === "polaris caps") return "Unknown or incomplete command";
        const compare = COMPARE.exec(line);
        if (compare) {
            const [x1, y1, z1, x2, y2, z2] = compare.slice(1, 7).map(Number) as number[];
            let count = 0;
            for (const key of blocks.keys()) {
                const [x, y, z] = key.split(",").map(Number) as [number, number, number];
                if (x >= x1! && x <= x2! && y >= y1! && y <= y2! && z >= z1! && z <= z2!)
                    count += 1;
            }
            return `Test passed, count: ${count}`;
        }
        const fill = FILL.exec(line);
        if (!fill) return "";
        const [x1, y1, z1, x2, y2, z2] = fill.slice(1, 7).map(Number) as number[];
        const [block, mode, only] = [fill[7]!, fill[8] ?? "replace", fill[9]];
        let changed = 0;
        for (let x = Math.min(x1!, x2!); x <= Math.max(x1!, x2!); x += 1)
            for (let y = Math.min(y1!, y2!); y <= Math.max(y1!, y2!); y += 1)
                for (let z = Math.min(z1!, z2!); z <= Math.max(z1!, z2!); z += 1) {
                    const key = `${x},${y},${z}`;
                    const was = blocks.get(key) ?? "minecraft:air";
                    if (mode === "keep" && was !== "minecraft:air") continue;
                    if (only && was !== only) continue;
                    if (was === block) continue;
                    if (block === "minecraft:air") blocks.delete(key);
                    else blocks.set(key, block);
                    changed += 1;
                }
        return changed === 0 ? "No blocks were filled" : `Successfully filled ${changed} block(s)`;
    };
    const server = {
        installedAppId: `sweep-${Math.random()}`,
        edition: "java",
        say: async (said: readonly string[]) => answer(said.join(" ")) ?? "",
        sayAll: async (said: readonly string[]) => {
            for (const line of said) answer(line);
        },
        sayEach: async (said: readonly (readonly string[])[]) =>
            said.map((one) => answer(one.join(" ")))
    } as unknown as ServerContainer;
    return { server, blocks, lines };
}

const volume = { x1: 10, y1: 100, z1: 10, x2: 19, y2: 109, z2: 19 };
const floor: stage.Box = {
    x1: 10,
    y1: 100,
    z1: 10,
    x2: 19,
    y2: 100,
    z2: 19,
    block: "minecraft:white_concrete"
};

/** The floor the event built, a modded block a player set on it, and the
 *  world's own blocks touching the volume from every side. */
function seeded(): Record<string, string> {
    const blocks: Record<string, string> = {};
    for (let x = 10; x <= 19; x += 1)
        for (let z = 10; z <= 19; z += 1) blocks[`${x},100,${z}`] = floor.block;
    blocks["14,101,14"] = FOREIGN;
    blocks["15,109,19"] = "minecraft:cobblestone";
    blocks["20,101,14"] = "minecraft:oak_planks";
    blocks["9,101,14"] = "minecraft:oak_planks";
    blocks["14,99,14"] = "minecraft:stone";
    blocks["14,110,14"] = "minecraft:glass";
    blocks["14,101,20"] = FOREIGN;
    blocks["14,101,9"] = "minecraft:chest";
    return blocks;
}

const OUTSIDE = ["20,101,14", "9,101,14", "14,99,14", "14,110,14", "14,101,20", "14,101,9"];

const leftover = (proved: stage.Volume | null): stage.Leftover => ({
    runId: "run-sweep",
    area: stage.areaOf(volume),
    boxes: [floor],
    saved: [],
    keepForced: null,
    proved
});

describe("the sweep of a proved volume", () => {
    it("fills only inside the volume, in slices within the fill limit, never with destroy", () => {
        const big = { x1: -40, y1: 60, z1: -40, x2: 60, y2: 200, z2: 60 };
        const fills = stage.sweepFills(big);
        expect(fills.length).toBeGreaterThan(1);
        let total = 0;
        for (const line of fills) {
            expect(line).toMatch(/ minecraft:air$/);
            expect(line).not.toMatch(/destroy|replace|keep/);
            const [x1, y1, z1, x2, y2, z2] = FILL.exec(line)!.slice(1, 7).map(Number) as number[];
            expect(Math.min(x1!, x2!)).toBeGreaterThanOrEqual(big.x1);
            expect(Math.max(x1!, x2!)).toBeLessThanOrEqual(big.x2);
            expect(Math.min(y1!, y2!)).toBeGreaterThanOrEqual(big.y1);
            expect(Math.max(y1!, y2!)).toBeLessThanOrEqual(big.y2);
            expect(Math.min(z1!, z2!)).toBeGreaterThanOrEqual(big.z1);
            expect(Math.max(z1!, z2!)).toBeLessThanOrEqual(big.z2);
            const size = stage.volumeOf({ x1: x1!, y1: y1!, z1: z1!, x2: x2!, y2: y2!, z2: z2! });
            expect(size).toBeLessThanOrEqual(stage.FILL_LIMIT);
            total += size;
        }
        expect(total).toBe(stage.volumeOf(big));
        expect(stage.dropsGone(big)).toBe(
            "execute in minecraft:overworld run kill @e[type=minecraft:item,x=-40,y=60,z=-40,dx=100,dy=140,dz=100]"
        );
    });

    it("reads corners given either way round as the same volume", () => {
        const flipped = { x1: 19, y1: 109, z1: 19, x2: 10, y2: 100, z2: 10 };
        expect(stage.sweepFills(flipped)).toEqual(stage.sweepFills(volume));
        expect(stage.dropsGone(flipped)).toBe(stage.dropsGone(volume));
    });
});

describe("a stage left over at the end", () => {
    it("takes out a foreign block inside the proved volume, and nothing one past its edge", async () => {
        const { server, blocks, lines } = world(seeded());
        expect(
            await settle(server, leftover(volume), { items: "components", top: 319 }, "en-US")
        ).toBeNull();
        expect(blocks.get("14,101,14")).toBeUndefined();
        expect(blocks.get("15,109,19")).toBeUndefined();
        for (const key of OUTSIDE) expect(blocks.has(key)).toBe(true);
        expect(
            lines.some((line) =>
                /kill @e\[type=minecraft:item,x=10,y=100,z=10,dx=9,dy=9,dz=9\]/.test(line)
            )
        ).toBe(true);
        // The per-box removal first, then the sweep, then the area let go.
        const removal = lines.findIndex((line) => line === stage.removeLine(floor));
        const sweep = lines.findIndex((line) => line === stage.sweepFills(volume)[0]);
        const release = lines.findIndex((line) => line === stage.releaseArea(stage.areaOf(volume)));
        expect(removal).toBeGreaterThan(-1);
        expect(sweep).toBeGreaterThan(removal);
        expect(release).toBeGreaterThan(sweep);
    });

    it("never sweeps a leftover with no proof written down: only its own boxes come out", async () => {
        const { server, blocks, lines } = world(seeded());
        expect(
            await settle(server, leftover(null), { items: "components", top: 319 }, "en-US")
        ).toBeNull();
        expect(blocks.get("14,101,14")).toBe(FOREIGN);
        expect(blocks.get("15,109,19")).toBe("minecraft:cobblestone");
        expect(lines.some((line) => / fill (-?\d+ ){6}minecraft:air$/.test(line))).toBe(false);
        expect(lines.some((line) => / kill @e\[type=minecraft:item/.test(line))).toBe(false);
    });

    it("keeps the proof and the area when a slice of the sweep does not answer", async () => {
        const sweep = stage.sweepFills(volume)[0]!;
        const { server, blocks } = world(seeded(), (line) => line === sweep);
        const kept = await settle(
            server,
            leftover(volume),
            { items: "components", top: 319 },
            "en-US"
        );
        expect(kept).toMatchObject({ boxes: [], proved: volume, area: stage.areaOf(volume) });
        expect(blocks.get("14,101,14")).toBe(FOREIGN);
        const { server: again, blocks: after } = world(Object.fromEntries(blocks));
        expect(await settle(again, kept!, { items: "components", top: 319 }, "en-US")).toBeNull();
        expect(after.get("14,101,14")).toBeUndefined();
        for (const key of OUTSIDE) expect(after.has(key)).toBe(true);
    });

    it("carries the proof from the run to its leftover, and an old run's as none", () => {
        const proved = { ...stage.EMPTY_STAGE, boxes: [floor], proved: volume };
        expect(stage.leftoverOf("run-1", proved)?.proved).toEqual(volume);
        expect(stage.leftoverOf("run-1", { ...proved, boxes: [] })?.proved).toEqual(volume);
        const old = stage.stageLeftoverSchema.parse({
            runId: "old",
            area: null,
            boxes: [floor],
            saved: []
        });
        expect(old.proved).toBeNull();
        expect(stage.stageSchema.parse({}).proved).toBeNull();
    });
});

describe("an arena taken down", () => {
    const box = { x1: 10, y1: 100, z1: 10, x2: 19, y2: 109, z2: 19 };
    const left = (proved: boolean): ArenaLeftover => ({
        id: "run-arena",
        kind: "sky-wars",
        arena: { box, blocks: [floor.block], ...(proved ? { proved: box } : {}) },
        site: null,
        marker: null,
        kit: [],
        entrants: [],
        gamerules: {},
        keepForced: null,
        createdAt: 0
    });

    it("sweeps its proved box after its own blocks, and nothing past it", async () => {
        const lines = arena.teardown(left(true).arena!);
        const sweep = stage.sweepLines(box);
        expect(lines.slice(-sweep.length)).toEqual(sweep);
        const { server, blocks } = world(seeded());
        expect(await closeArena(server, left(true))).toBeNull();
        expect(blocks.get("14,101,14")).toBeUndefined();
        expect(blocks.get("15,109,19")).toBeUndefined();
        for (const key of OUTSIDE) expect(blocks.has(key)).toBe(true);
    });

    it("never sweeps an arena with no proof written down", async () => {
        const lines = arena.teardown(left(false).arena!);
        expect(lines.every((line) => / replace minecraft:\S+$/.test(line))).toBe(true);
        const { server, blocks } = world(seeded());
        // Its box still holds the player's blocks: kept to try again, never swept.
        expect(await closeArena(server, left(false))).toMatchObject({ checks: 1 });
        expect(blocks.get("14,101,14")).toBe(FOREIGN);
        expect(blocks.get("15,109,19")).toBe("minecraft:cobblestone");
    });
});
