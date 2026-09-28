/**
 * The poll behind a Minecraft server's page.
 *
 * Every read that does not need the server to be answering starts at once,
 * beside the one that asks it - the firewall, the history, what was remembered -
 * rather than queued behind it; only the roster, the levels and the timeout sweep
 * wait for the answer. And the roster Polaris remembered is only ever handed out
 * in place of a live one, never beside it, so a current roster is never labelled
 * as an old reading.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
const OWNER = "11111111-1111-4111-8111-111111111111";

const LIVE = { ops: ["Ana"], whitelist: [], bans: [], whitelistEnforced: true };
const KEPT = { roster: { ops: ["Old"], whitelist: [], bans: [], whitelistEnforced: false }, at: "2026-09-01T00:00:00.000Z" };

let answering = true;
let releaseStatus: () => void = () => undefined;
let holdStatus = false;
const started: string[] = [];

function status() {
    return {
        edition: "java",
        running: true,
        containerRunning: true,
        answering,
        players: { online: 0, max: 20, players: [] },
        address: null,
        message: null,
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null,
        crashLoop: null
    };
}

vi.mock("next/server", async (original) => ({
    ...(await original<typeof import("next/server")>()),
    after: () => undefined
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallAccess: {
            requireGameServer: async () => ({ access: { ownerId: OWNER } })
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    sharingInstallReads: <T,>(work: () => Promise<T>) => work(),
    getServerStatus: async () => {
        started.push("status");
        if (holdStatus) await new Promise<void>((resolve) => (releaseStatus = resolve));
        return status();
    },
    getServerRoster: async () => {
        started.push("roster");
        return LIVE;
    },
    getServerFirewall: async () => {
        started.push("firewall");
        return { blocked: [], applied: [], ranges: [] };
    },
    getPlayerSessions: async () => {
        started.push("sessions");
        return [];
    },
    getPlayerLevels: async () => ({})
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/reach", () => ({ reachAdviceFor: async () => null }));
vi.mock("@polaris-app/game-servers/src/lib/games-activity-service", () => ({ readLastSeen: async () => ({}) }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/schedule-service", () => ({
    sweepWatchedGameSchedules: async () => null
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/queue-service", () => ({
    drainQueue: async () => null,
    pendingFor: async () => []
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/inventory-service", () => ({
    sweepInventorySnapshots: async () => 0
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/roster-memory", () => ({
    rememberRoster: async () => undefined,
    rememberedRoster: async () => {
        started.push("remembered");
        return KEPT;
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/level-memory", () => ({
    rememberLevels: async () => undefined,
    rememberedLevels: async () => ({})
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    readPlayerTimeouts: async () => [],
    sweepTimeouts: async () => 0
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-access", () => ({
    enforcePlayerAddresses: async () => null,
    forViewer: (value: unknown) => value,
    listPlayerAccess: async () => ({ rules: [] })
}));

const { GET } = await import(
    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/route"
);

function poll(): Promise<Response> {
    return GET(new Request(`http://polaris.test/api/apps/installed/${SERVER}/minecraft?roster=1`), {
        params: Promise.resolve({ id: SERVER })
    });
}

beforeEach(() => {
    answering = true;
    holdStatus = false;
    started.length = 0;
});

describe("the Minecraft poll", () => {
    it("starts the reads that do not need an answer while the server is still being asked", async () => {
        holdStatus = true;
        const response = poll();
        await vi.waitFor(() => expect(started).toContain("status"));
        expect(started).toEqual(expect.arrayContaining(["firewall", "sessions", "remembered"]));
        expect(started).not.toContain("roster");
        releaseStatus();
        expect((await response).status).toBe(200);
        expect(started).toContain("roster");
    });

    it("hands out the live roster as current when the server answers", async () => {
        const body = await (await poll()).json();
        expect(body.roster).toEqual(LIVE);
        expect(body.rosterAsOf).toBeNull();
    });

    it("hands out the remembered roster, and when it was read, when the server does not", async () => {
        answering = false;
        const body = await (await poll()).json();
        expect(started).not.toContain("roster");
        expect(body.roster).toEqual(KEPT.roster);
        expect(body.rosterAsOf).toBe(KEPT.at);
    });
});
