/**
 * Letting a flooded service go again.
 *
 * The mark is stored with an expiry and the edge is only re-rendered when who is
 * challenged changes, so the case worth pinning is the quiet one: the last mark
 * running out with nothing else happening must still take the challenge down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { settings, syncAppRoutes, findMany, flooded } = vi.hoisted(() => ({
    settings: new Map<string, string>(),
    syncAppRoutes: vi.fn(async () => undefined),
    findMany: vi.fn(),
    flooded: { hosts: [] as string[] }
}));

vi.mock("@polaris/db", () => ({ prisma: { application: { findMany } } }));
vi.mock("@polaris/deploy", () => ({ parseHttpLogs: () => [] }));
vi.mock("@/lib/deploy/quick-tunnel-service", () => ({
    tunnelHostForApp: (id: string) => `${id}.tunnel.test`
}));
vi.mock("@/lib/edge-access-log", () => ({
    EDGE_LOG_RECENT_WINDOW_BYTES: 1024,
    readEdgeLogTail: async () => "log"
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value)
}));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes }));
vi.mock("@polaris/core", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@polaris/core")>()),
    detectFloodedHosts: () => flooded.hosts
}));

const { runFloodWatch } = await import("@/lib/deploy/flood-watch");

const NOW = Date.parse("2026-09-10T12:00:00Z");
const APP = {
    id: "app-1",
    edgeConfig: JSON.stringify({ challenge: "auto" }),
    domains: [{ hostname: "shop.example.com" }]
};

function stored(): Record<string, number> {
    return JSON.parse(settings.get("deploy.flooded") ?? "{}") as Record<string, number>;
}

beforeEach(() => {
    settings.clear();
    syncAppRoutes.mockClear();
    findMany.mockResolvedValue([APP]);
    flooded.hosts = [];
});

describe("the flood watch", () => {
    it("marks a flooded service and re-renders the edge", async () => {
        flooded.hosts = ["shop.example.com"];
        await expect(runFloodWatch(NOW)).resolves.toEqual({ flooded: 1, changed: true });
        expect(stored()["app-1"]).toBeGreaterThan(NOW);
        expect(syncAppRoutes).toHaveBeenCalledTimes(1);
    });

    it("does not re-render while a mark is only held", async () => {
        settings.set("deploy.flooded", JSON.stringify({ "app-1": NOW + 60_000 }));
        await expect(runFloodWatch(NOW)).resolves.toEqual({ flooded: 1, changed: false });
        expect(syncAppRoutes).not.toHaveBeenCalled();
    });

    it("takes the challenge down when the last mark runs out", async () => {
        settings.set("deploy.flooded", JSON.stringify({ "app-1": NOW - 1 }));
        await expect(runFloodWatch(NOW)).resolves.toEqual({ flooded: 0, changed: true });
        expect(syncAppRoutes).toHaveBeenCalledTimes(1);
        expect(stored()).toEqual({});

        // Gone from storage, so the next quiet pass has nothing left to do.
        await expect(runFloodWatch(NOW + 60_000)).resolves.toEqual({ flooded: 0, changed: false });
        expect(syncAppRoutes).toHaveBeenCalledTimes(1);
    });

    it("drops a run-out mark even when no service is set to auto any more", async () => {
        findMany.mockResolvedValue([]);
        settings.set("deploy.flooded", JSON.stringify({ "app-1": NOW - 1 }));
        await expect(runFloodWatch(NOW)).resolves.toEqual({ flooded: 0, changed: true });
        expect(stored()).toEqual({});
    });

    it("re-renders a service flooded again after its mark ran out", async () => {
        settings.set("deploy.flooded", JSON.stringify({ "app-1": NOW - 1 }));
        flooded.hosts = ["shop.example.com"];
        await expect(runFloodWatch(NOW)).resolves.toEqual({ flooded: 1, changed: true });
        expect(syncAppRoutes).toHaveBeenCalledTimes(1);
    });
});
