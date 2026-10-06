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
import { closeArena } from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena-service";

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

function fakeServer(lost: ReadonlySet<number>, failing = -1) {
    const batches: string[][] = [];
    const alone: string[] = [];
    const server = {
        say: async (lines: readonly string[]) => {
            alone.push(...lines);
            return "Successfully filled";
        },
        sayAll: async () => undefined,
        sayEach: async (commands: readonly (readonly string[])[]) => {
            batches.push(commands.map((one) => one.join(" ")));
            if (batches.length - 1 === failing) throw new Error("no answer in time");
            return commands.map((_, index) => (lost.has(index) ? null : "Successfully filled"));
        }
    } as unknown as ServerContainer;
    return { server, batches, alone };
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
