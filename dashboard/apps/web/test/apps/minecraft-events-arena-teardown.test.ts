/**
 * An arena taken down in a few trips: the fills of its teardown sent a few
 * dozen at a time (`sayEach`), in order, and only a fill whose answer never
 * came back asked again on its own - the podium waits on this, so it must not
 * be hundreds of round trips. A trip that failed outright is not asked over:
 * the arena is kept and tried again later.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import type { ServerContainer } from "@polaris-app/game-servers/src/lib/minecraft/service";
import type { ArenaLeftover } from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import {
    CLEAR_CHECKS,
    closeArena,
    leftForOperator
} from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-service";

const box = { x1: 0, y1: 100, z1: 0, x2: 80, y2: 140, z2: 80 };
const left: ArenaLeftover = {
    id: "run-1",
    kind: "sky-wars",
    arena: {
        box,
        blocks: ["minecraft:grass_block", "minecraft:dirt", "minecraft:stone", "minecraft:barrier"]
    },
    site: null,
    marker: null,
    kit: [],
    entrants: [],
    gamerules: {},
    keepForced: null,
    createdAt: 0
};

/** What the box is counted as once it is down. */
const counted = (left: number) => `Test passed, count: ${left}`;

function fakeServer(lost: ReadonlySet<number>, failing = -1, still = 0) {
    const batches: string[][] = [];
    const alone: string[] = [];
    const all: string[] = [];
    /** Every line, in the order the server got it. */
    const order: string[] = [];
    const server = {
        installedAppId: `teardown-${Math.random()}`,
        edition: "java",
        say: async (lines: readonly string[]) => {
            alone.push(...lines);
            order.push(...lines);
            if (lines[0] === "polaris caps")
                return '{"ok":true,"polaris":"0.4.0","caps":["stash","batch","seek"]}';
            return lines[0]!.endsWith(" masked") ? counted(still) : "Successfully filled";
        },
        sayAll: async (lines: readonly string[]) => {
            all.push(...lines);
        },
        sayEach: async (commands: readonly (readonly string[])[]) => {
            batches.push(commands.map((one) => one.join(" ")));
            order.push(...commands.map((one) => one.join(" ")));
            if (batches.length - 1 === failing) throw new Error("no answer in time");
            return commands.map((_, index) => (lost.has(index) ? null : "Successfully filled"));
        }
    } as unknown as ServerContainer;
    return { server, batches, alone, all, order };
}

describe("an arena taken down", () => {
    it("sends the fills in bounded trips, in order, and asks again only for what did not answer", async () => {
        const fills = arena.teardown(left.arena!);
        expect(fills.length).toBeGreaterThan(25);
        const { server, batches, alone } = fakeServer(new Set([2]));
        expect(await closeArena(server, left)).toBeNull();
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every((batch) => batch.length <= 25)).toBe(true);
        expect(batches.flat()).toEqual(fills);
        expect(alone.filter((line) => fills.includes(line))).toEqual(
            batches.map((batch) => batch[2]).filter((line) => line !== undefined)
        );
    });

    it("stops and keeps the arena when a trip fails outright, asking nothing over it", async () => {
        const { server, batches, alone } = fakeServer(new Set(), 0);
        const fills = arena.teardown(left.arena!);
        expect(await closeArena(server, left)).toMatchObject({ id: "run-1", entrants: [] });
        expect(batches).toHaveLength(1);
        expect(alone.filter((line) => fills.includes(line))).toEqual([]);
    });

    it("keeps the arena loaded and tries again when a fill could not reach its blocks", async () => {
        const { server } = fakeServer(new Set());
        const refusing = {
            ...server,
            sayEach: async (commands: readonly (readonly string[])[]) =>
                commands.map(() => "That position is not loaded")
        } as unknown as ServerContainer;
        expect(await closeArena(refusing, left)).toMatchObject({ id: "run-1", entrants: [] });
    });

    it("sends everybody home in the same trip, before anybody is waited on or given anything", async () => {
        const entrant = (name: string, x: number) => ({
            name,
            uuid: null,
            dimension: "minecraft:overworld",
            x,
            y: 64,
            z: 0,
            yaw: 0,
            pitch: 0,
            gamemode: "survival" as const,
            side: 0,
            away: true,
            tagged: false,
            stash: null
        });
        const entrants = [entrant("Ana", 1), entrant("Ben", 2), entrant("Cleo", 3)];
        const log: { how: "say" | "sayAll" | "sayEach"; lines: string[] }[] = [];
        const server = {
            say: async (lines: readonly string[]) => {
                log.push({ how: "say", lines: [...lines] });
                return lines[0]!.includes(" tp ") ? "Teleported" : "Successfully filled";
            },
            sayAll: async (lines: readonly string[]) => {
                log.push({ how: "sayAll", lines: [...lines] });
            },
            sayEach: async (commands: readonly (readonly string[])[]) => {
                const lines = commands.map((one) => one.join(" "));
                log.push({ how: "sayEach", lines });
                return lines.map((line) =>
                    line.includes(" tp ") ? `Teleported ${line}` : "Successfully filled"
                );
            }
        } as unknown as ServerContainer;
        await closeArena(server, { ...left, arena: null, entrants });
        const homes = entrants.map((one) => arena.sendHome(one));
        const trips = log.filter((one) => one.lines.some((line) => homes.includes(line)));
        // One trip, everybody's teleport in it, nothing else.
        expect(trips).toEqual([{ how: "sayEach", lines: homes }]);
        const sent = log.flatMap((one) => one.lines);
        const home = sent.indexOf(homes[0]!);
        // Everybody's fall protection and kit first; game mode and tag after.
        for (const one of entrants) {
            for (const line of arena.homeward(one, null, []))
                expect(sent.indexOf(line)).toBeLessThan(home);
            expect(sent.indexOf(arena.homeMode(one))).toBeGreaterThan(home);
            expect(sent.indexOf(arena.leftArena(one.name))).toBeGreaterThan(home);
        }
    });

    it("keeps whoever the teleport did not reach owed the trip, and sends the rest", async () => {
        const one = {
            name: "Gone",
            uuid: null,
            dimension: "minecraft:overworld",
            x: 0,
            y: 64,
            z: 0,
            yaw: 0,
            pitch: 0,
            gamemode: "survival" as const,
            side: 0,
            away: true,
            tagged: false,
            stash: null
        };
        const server = {
            say: async () => "No player was found",
            sayAll: async () => undefined,
            sayEach: async (commands: readonly (readonly string[])[]) =>
                commands.map(() => "No player was found")
        } as unknown as ServerContainer;
        expect(await closeArena(server, { ...left, arena: null, entrants: [one] })).toMatchObject({
            entrants: [one]
        });
    });
});

describe("what an arena turned into, and its box counted once it is down", () => {
    it("takes the dirt grass went to, right after the grass, and the snow on top first", () => {
        expect(
            arena.withDecayed(["minecraft:poppy", "minecraft:grass_block", "minecraft:stone"])
        ).toEqual([
            "minecraft:snow",
            "minecraft:poppy",
            "minecraft:grass_block",
            "minecraft:dirt",
            "minecraft:stone"
        ]);
        expect(arena.withDecayed(["minecraft:water"])).toEqual([
            "minecraft:snow",
            "minecraft:water",
            "minecraft:ice"
        ]);
        expect(arena.withDecayed([])).toEqual([]);
    });

    it("fills the dirt out of a manor that listed only its grass floor", () => {
        const fills = arena.teardown({
            box: { x1: 0, y1: 100, z1: 0, x2: 9, y2: 109, z2: 9 },
            blocks: ["minecraft:oak_log", "minecraft:grass_block"]
        });
        expect(fills).toContain(
            "execute in minecraft:overworld run fill 0 100 0 9 109 9 minecraft:air replace minecraft:dirt"
        );
    });

    it("counts every slice and is never empty on an answer it could not read", async () => {
        const big = { x1: 0, y1: 0, z1: 0, x2: 199, y2: 9, z2: 199 };
        const asked: string[] = [];
        const count = await arena.leftIn(big, async (line) => {
            asked.push(line);
            return counted(1);
        });
        expect(asked).toHaveLength(arena.slices(big).length);
        expect(count).toBe(arena.slices(big).length);
        expect(await arena.leftIn(big, async () => "That position is not loaded")).toBeNull();
        expect(await arena.leftIn(big, async () => "Unknown command")).toBeNull();
    });

    it("lets an arena go once its box is empty again", async () => {
        const { server, alone } = fakeServer(new Set());
        expect(await closeArena(server, left)).toBeNull();
        expect(alone.some((line) => line.endsWith(" masked"))).toBe(true);
    });

    it("keeps an arena whose box still holds blocks, and leaves it for the operator after a few goes", async () => {
        let held: ArenaLeftover | null = left;
        for (let go = 1; go < CLEAR_CHECKS; go += 1) {
            const { server, all } = fakeServer(new Set(), -1, 4);
            held = await closeArena(server, held!);
            expect(held).toMatchObject({ id: "run-1", checks: go, entrants: [] });
            expect(leftForOperator(held!)).toBe(false);
            // Still held loaded, to be taken down again.
            expect(all.some((line) => line.includes("forceload remove"))).toBe(false);
        }
        const { server, all } = fakeServer(new Set(), -1, 4);
        held = await closeArena(server, held!);
        expect(held).toMatchObject({
            checks: CLEAR_CHECKS,
            remains: 4 * arena.slices(box).length,
            arena: left.arena
        });
        expect(leftForOperator(held!)).toBe(true);
        // Its chunks let go: nobody is coming back to it on their own.
        expect(all.some((line) => line.includes("forceload remove"))).toBe(true);
    });

    it("calls off the batch it was built by before a single block comes down", async () => {
        const { server, order } = fakeServer(new Set());
        const built = { ...left, arena: { ...left.arena!, batch: "pbabc123" } };
        expect(await closeArena(server, built)).toBeNull();
        const cancel = order.indexOf("polaris batch cancel pbabc123");
        const firstFill = order.indexOf(arena.teardown(built.arena)[0]!);
        expect(cancel).toBeGreaterThanOrEqual(0);
        expect(firstFill).toBeGreaterThan(cancel);
    });

    it("does not count an arena that built nothing: the hill on the world's own ground", async () => {
        const { server, alone } = fakeServer(new Set(), -1, 500);
        const ground = { ...left, kind: "king-of-the-hill" as const, arena: { box, blocks: [] } };
        expect(await closeArena(server, ground)).toBeNull();
        expect(alone.some((line) => line.endsWith(" masked"))).toBe(false);
    });
});
