/**
 * The watcher behind the live player feed.
 *
 * What it is for is not the reading itself - that already existed - but who pays
 * for it. Asking a server who is on it is a command inside its container, so a
 * dashboard open in three tabs, on two devices, must not be three or six times the
 * work; and a dashboard nobody has open must be none of it. Both halves are
 * asserted here, because getting the second one wrong is a machine quietly running
 * commands against every game server for the rest of the process's life.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerPresence } from "@/lib/apps/games-service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ONE = "aaaaaaaa-1111-4111-8111-111111111111";
const TWO = "bbbbbbbb-1111-4111-8111-111111111111";

/** What the next reading will say, and every call made to take one. */
let answer: ServerPresence[] = [];
const reads: { only: readonly string[] | undefined }[] = [];
const sweeps: { only: unknown; known: ReadonlyMap<string, number | null> | undefined }[] = [];

vi.mock("@/lib/apps/games-service", () => ({
    listGameServerPresence: async (_ownerId: string, _alsoIds: readonly string[], only?: readonly string[]) => {
        reads.push({ only });
        return answer;
    }
}));

vi.mock("@/lib/apps/minecraft/schedule-service", () => ({
    sweepGameSchedules: async (
        _ownerId: string,
        _at: Date,
        options: { only?: unknown; known?: ReadonlyMap<string, number | null> }
    ) => {
        sweeps.push({ only: options.only, known: options.known });
        return { started: 0, stopped: 0 };
    }
}));

const { subscribeGamePresence } = await import("@/lib/apps/games-presence");

function playing(id: string, names: string[]): ServerPresence {
    return {
        id,
        answering: true,
        containerRunning: true,
        online: names.length,
        max: 20,
        players: names.map((name) => ({ name, id: null })),
        message: null
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    reads.length = 0;
    sweeps.length = 0;
    answer = [playing(ONE, [])];
});

describe("subscribeGamePresence", () => {
    it("reads once for everybody watching the same thing", async () => {
        const seen: number[] = [];
        const first = subscribeGamePresence(OWNER, [], (reading) => seen.push(reading.servers.length));
        await vi.advanceTimersByTimeAsync(0);
        // A second screen joins: it is handed what is already known rather than
        // starting a reading of its own.
        const second = subscribeGamePresence(OWNER, [], (reading) => seen.push(reading.servers.length));
        await vi.advanceTimersByTimeAsync(0);

        expect(reads).toHaveLength(1);
        expect(seen).toEqual([1, 1]);
        first();
        second();
    });

    it("hands on a change and says nothing when nothing moved", async () => {
        const seen: string[][] = [];
        const stop = subscribeGamePresence(OWNER, [], (reading) =>
            seen.push(reading.servers.flatMap((server) => server.players.map((player) => player.name)))
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([[]]);

        // Nothing changed between these two readings, so nobody is told twice.
        await vi.advanceTimersByTimeAsync(3000);
        expect(reads.length).toBeGreaterThan(1);
        expect(seen).toEqual([[]]);

        answer = [playing(ONE, ["Pau"])];
        await vi.advanceTimersByTimeAsync(3000);
        expect(seen).toEqual([[], ["Pau"]]);
        stop();
    });

    it("stops reading the moment the last screen goes away", async () => {
        const stop = subscribeGamePresence(OWNER, [], () => undefined);
        await vi.advanceTimersByTimeAsync(0);
        const taken = reads.length;

        stop();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads).toHaveLength(taken);
    });

    it("reads only the server a page is about, and decides only that one's schedule", async () => {
        answer = [playing(TWO, ["Ana"])];
        const stop = subscribeGamePresence(OWNER, [], () => undefined, [TWO]);
        await vi.advanceTimersByTimeAsync(0);

        expect(reads[0]?.only).toEqual([TWO]);
        // The sweep is narrowed the same way: over every server it would have to
        // ask each of the others who is on it, which is the cost this avoids.
        expect(sweeps[0]?.only).toEqual([TWO]);
        expect(sweeps[0]?.known?.get(TWO)).toBe(1);
        stop();
    });

    it("passes a server it could not reach on as unknown rather than as empty", async () => {
        answer = [{ ...playing(ONE, []), answering: false, message: "The server is starting" }];
        const stop = subscribeGamePresence(OWNER, [], () => undefined);
        await vi.advanceTimersByTimeAsync(0);

        // Nought here would be a schedule stopping a server for being quiet when
        // it was only still starting.
        expect(sweeps[0]?.known?.get(ONE)).toBeNull();
        stop();
    });
});
