/**
 * Sleep mode reading the edge's log through the reader it shares with the
 * autoscaler: a visit in the log keeps a service awake, a stretch without one
 * puts it to sleep, and a request to another address is not a visit to it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { log, findMany, setApplicationAsleep } = vi.hoisted(() => ({
    log: { text: "" },
    findMany: vi.fn(),
    setApplicationAsleep: vi.fn(async () => undefined)
}));

vi.mock("@polaris/db", () => ({
    prisma: { application: { findMany }, deployment: { findMany: async () => [] } }
}));
vi.mock("@/lib/deploy-service", () => ({ setApplicationAsleep, syncAppRoutes: async () => undefined }));
vi.mock("@/lib/edge-access-log", () => ({
    EDGE_LOG_RECENT_WINDOW_BYTES: 1024,
    readEdgeLogTail: async () => log.text
}));
vi.mock("@/lib/deploy/quick-tunnel-service", () => ({ tunnelHostForApp: (id: string) => `${id}.tunnel.test` }));

const { runSleepPass } = await import("@/lib/deploy/sleep-service");

// Well after this process started, which is as far back as a service is known
// to have been awake.
const NOW = Date.now() + 60 * 60_000;

function visit(minutesAgo: number, host: string): string {
    return JSON.stringify({
        StartUTC: new Date(NOW - minutesAgo * 60_000).toISOString(),
        RequestHost: host,
        RequestMethod: "GET",
        RequestPath: "/",
        DownstreamStatus: 200,
        "request_User-Agent": "Mozilla/5.0"
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([
        {
            id: "app-1",
            replicas: 1,
            autoscale: null,
            sleepAfterMinutes: 5,
            asleepSince: null,
            currentDeploymentId: "d1",
            target: { kind: "local" },
            environment: { project: { ownerId: "owner-1" } },
            domains: [{ hostname: "shop.example.com" }]
        }
    ]);
});

describe("the sleep pass", () => {
    it("puts a service nobody visited for the stretch to sleep", async () => {
        log.text = [visit(30, "shop.example.com"), visit(1, "other.example.com")].join("\n");
        await expect(runSleepPass(NOW)).resolves.toEqual({ asleep: 1, woke: 0, slept: 1 });
        expect(setApplicationAsleep).toHaveBeenCalledWith("app-1", "owner-1", true);
    });

    it("keeps a service somebody just visited awake", async () => {
        log.text = [visit(30, "shop.example.com"), visit(1, "SHOP.example.com:443")].join("\n");
        await expect(runSleepPass(NOW)).resolves.toEqual({ asleep: 0, woke: 0, slept: 0 });
        expect(setApplicationAsleep).not.toHaveBeenCalled();
    });
});
