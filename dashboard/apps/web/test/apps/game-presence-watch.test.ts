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
import type { ServerPresence } from "@polaris-app/game-servers/src/lib/games-service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ONE = "aaaaaaaa-1111-4111-8111-111111111111";
const TWO = "bbbbbbbb-1111-4111-8111-111111111111";

/** What the next reading will say, and every call made to take one. */
let answer: ServerPresence[] = [];
const reads: { only: readonly string[] | undefined }[] = [];
const sweeps: { only: unknown; known: ReadonlyMap<string, number | null> | undefined }[] = [];

vi.mock("@polaris-app/game-servers/src/lib/games-service", () => ({
    listGameServerPresence: async (
        _ownerId: string,
        _alsoIds: readonly string[],
        only?: readonly string[]
    ) => {
        reads.push({ only });
        return answer;
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/schedule-service", () => ({
    sweepWatchedGameSchedules: async (
        _ownerId: string,
        options: { only?: unknown; known?: ReadonlyMap<string, number | null> }
    ) => {
        sweeps.push({ only: options.only, known: options.known });
        return { started: 0, stopped: 0 };
    }
}));

/** What each reading wrote into the record of who played, and what it said about
 *  when their visits began. */
const recorded: { id: string; names: string[]; log: string | undefined }[] = [];
const closed: string[] = [];
let visitSince = new Map<string, Date>();

vi.mock("@polaris-app/game-servers/src/lib/games-activity-service", () => ({
    recordRoster: async (
        id: string,
        players: readonly { name: string }[],
        _now: Date,
        options: { log?: string }
    ) => {
        recorded.push({ id, names: players.map((player) => player.name), log: options.log });
        return { arrived: 0, left: 0, since: visitSince };
    },
    closeGameSessions: async (id: string) => {
        closed.push(id);
    },
    readSessionLog: async () => null
}));

const { subscribeGamePresence } = await import("@polaris-app/game-servers/src/lib/games-presence");

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
    recorded.length = 0;
    closed.length = 0;
    visitSince = new Map();
    answer = [playing(ONE, [])];
});

describe("subscribeGamePresence", () => {
    it("reads once for everybody watching the same thing", async () => {
        const seen: number[] = [];
        const first = subscribeGamePresence(OWNER, [], (reading) =>
            seen.push(reading.servers.length)
        );
        await vi.advanceTimersByTimeAsync(0);
        // A second screen joins: it is handed what is already known rather than
        // starting a reading of its own.
        const second = subscribeGamePresence(OWNER, [], (reading) =>
            seen.push(reading.servers.length)
        );
        await vi.advanceTimersByTimeAsync(0);

        expect(reads).toHaveLength(1);
        expect(seen).toEqual([1, 1]);
        first();
        second();
    });

    it("hands on a change and says nothing when nothing moved", async () => {
        const seen: string[][] = [];
        const stop = subscribeGamePresence(OWNER, [], (reading) =>
            seen.push(
                reading.servers.flatMap((server) => server.players.map((player) => player.name))
            )
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

    it("writes every reading into the record, so 'since' is as fresh as the feed", async () => {
        // The minute's sweep only sees who is on once a minute, and not at all on
        // an instance with no cron configured. While a screen watches, this does.
        answer = [playing(ONE, ["PlayerOne"])];
        visitSince = new Map([["@playerone", new Date("2026-09-29T15:04:00.000Z")]]);
        const frames: (string | null | undefined)[] = [];
        const stop = subscribeGamePresence(OWNER, [], (reading) =>
            frames.push(reading.servers[0]?.players[0]?.since)
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(recorded).toEqual([{ id: ONE, names: ["PlayerOne"], log: "changes" }]);
        expect(frames).toEqual(["2026-09-29T15:04:00.000Z"]);

        // He reconnects: the record opens a new visit and the next frame says so.
        visitSince = new Map([["@playerone", new Date("2026-09-29T15:30:10.000Z")]]);
        await vi.advanceTimersByTimeAsync(3000);
        expect(frames).toEqual(["2026-09-29T15:04:00.000Z", "2026-09-29T15:30:10.000Z"]);
        stop();
    });

    it("closes what was open on a server whose container is down, and records nothing else", async () => {
        answer = [{ ...playing(ONE, []), answering: false, containerRunning: false }];
        const stop = subscribeGamePresence(OWNER, [], () => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toEqual([ONE]);
        expect(recorded).toEqual([]);
        stop();
    });

    it("leaves a server that is only slow to answer alone", async () => {
        answer = [{ ...playing(ONE, []), answering: false, containerRunning: true }];
        const stop = subscribeGamePresence(OWNER, [], () => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toEqual([]);
        expect(recorded).toEqual([]);
        stop();
    });
});
