/**
 * An arena taken down in one trip: every fill of its teardown sent together
 * (`sayEach`), in order, and only a fill whose answer never came back asked
 * again on its own - the podium waits on this, so it must not be hundreds of
 * round trips.
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

function fakeServer(lost: ReadonlySet<number>) {
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
            return commands.map((_, index) => (lost.has(index) ? null : "Successfully filled"));
        }
    } as unknown as ServerContainer;
    return { server, batches, alone };
}

describe("an arena taken down", () => {
    it("sends every fill in one trip, in order, and asks again only for what did not answer", async () => {
        const fills = arena.teardown(left.arena!);
        expect(fills.length).toBeGreaterThan(8);
        const { server, batches, alone } = fakeServer(new Set([2]));
        expect(await closeArena(server, left)).toBeNull();
        expect(batches).toEqual([fills]);
        expect(alone.filter((line) => fills.includes(line))).toEqual([fills[2]]);
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
});
