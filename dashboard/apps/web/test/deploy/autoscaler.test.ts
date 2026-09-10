/**
 * The autoscaler reading traffic from the edge's log.
 *
 * The decision itself is tested in core; this pins the wiring around it: the
 * requests a fake log holds for a service's addresses reach the decision as a
 * rate, the change it makes says which signal moved it in both the audit trail
 * and the service's history, and a service the log cannot speak for - one on
 * another server, or one with no traffic target - is never read for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { log, findMany, serving, scaleService, recordDeployAudit, record, readEdgeLogWindow, cpu } = vi.hoisted(() => {
    const log = { text: "", truncated: false };
    return {
        log,
        findMany: vi.fn(),
        serving: vi.fn(async (): Promise<{ id: string; replicas: number | null }[]> => []),
        scaleService: vi.fn(async () => undefined),
        recordDeployAudit: vi.fn(async () => undefined),
        record: vi.fn(async () => undefined),
        readEdgeLogWindow: vi.fn(async () => ({ text: log.text, truncated: log.truncated })),
        cpu: { percent: 5 }
    };
});

vi.mock("@polaris/db", () => ({
    prisma: { application: { findMany }, deployment: { count: async () => 0, findMany: serving } }
}));
vi.mock("@/lib/deploy/releases", () => ({
    servingContainerNames: async (apps: { id: string }[]) => new Map(apps.map((app) => [app.id, `${app.id}-web`]))
}));
vi.mock("@/lib/deploy/scaling-service", () => ({ scaleService, singleCopyReason: () => null }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit }));
vi.mock("@/lib/activity/activity", () => ({ record }));
vi.mock("@/lib/edge-access-log", () => ({ EDGE_LOG_RECENT_WINDOW_BYTES: 1024, readEdgeLogWindow }));
vi.mock("@/lib/deploy/quick-tunnel-service", () => ({ tunnelHostForApp: (id: string) => `${id}.tunnel.test` }));
vi.mock("@/lib/docker-service", () => {
    const driver = () => ({
        statsMany: async (names: string[]) => new Map(names.map((name) => [name, { cpuPercent: cpu.percent }])),
        dispose: async () => undefined
    });
    return { localDockerDriver: driver, hostDockerDriver: async () => driver() };
});

const { runAutoscale } = await import("@/lib/deploy/autoscaler");

const NOW = Date.parse("2026-09-10T12:00:00Z");

function service(id: string, autoscale: Record<string, unknown>, kind = "local") {
    return {
        id,
        replicas: 1,
        autoscale: JSON.stringify(autoscale),
        currentDeploymentId: `${id}-deployment`,
        target: { kind, runtime: "compose", hostId: kind === "local" ? null : "host-1" },
        environment: { project: { ownerId: "owner-1" } },
        domains: [{ hostname: "shop.example.com" }],
        _count: { volumes: 0 }
    };
}

/** A log holding `count` requests to the shop spread over the minute before `at`,
 *  after an older line from somewhere else that shows the log covers the minute. */
function traffic(at: number, count: number): string {
    const lines = [
        JSON.stringify({
            StartUTC: new Date(at - 10 * 60_000).toISOString(),
            RequestHost: "elsewhere.example.com",
            RequestMethod: "GET",
            RequestPath: "/",
            DownstreamStatus: 200
        })
    ];
    for (let index = 0; index < count; index++) {
        lines.push(
            JSON.stringify({
                StartUTC: new Date(at - 59_000 + Math.floor((index * 58_000) / count)).toISOString(),
                RequestHost: "shop.example.com",
                RequestMethod: "GET",
                RequestPath: "/",
                DownstreamStatus: 200,
                "request_User-Agent": "Mozilla/5.0"
            })
        );
    }
    return lines.join("\n");
}

beforeEach(() => {
    vi.clearAllMocks();
    cpu.percent = 5;
    log.truncated = false;
    serving.mockResolvedValue([]);
});

describe("the autoscaler on traffic", () => {
    it("adds the copies the requests need, and says traffic moved it", async () => {
        findMany.mockResolvedValue([service("app-busy", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 })]);
        for (let tick = 0; tick < 3; tick++) {
            const at = NOW + tick * 60_000;
            log.text = traffic(at, 250);
            await runAutoscale(at);
        }

        expect(scaleService).toHaveBeenCalledTimes(1);
        expect(scaleService).toHaveBeenCalledWith("app-busy", "owner-1", 3);
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.app.autoscale",
                metadata: expect.objectContaining({ from: 1, to: 3, signal: "traffic", requestsPerMinute: 250 })
            })
        );
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({
                subjectType: "app",
                subjectId: "app-busy",
                action: "autoscaled-traffic",
                fromValue: "1",
                toValue: "3"
            })
        );
    });

    it("reads the log once a pass, however many services count requests", async () => {
        findMany.mockResolvedValue([
            service("app-a", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 }),
            service("app-b", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 })
        ]);
        log.text = traffic(NOW, 10);
        await runAutoscale(NOW);
        expect(readEdgeLogWindow).toHaveBeenCalledTimes(1);
    });

    it("never reads the log for a service without a traffic target", async () => {
        findMany.mockResolvedValue([service("app-old", { min: 1, max: 4, cpuPercent: 50 })]);
        log.text = traffic(NOW, 10_000);
        for (let tick = 0; tick < 3; tick++) await runAutoscale(NOW + tick * 60_000);
        expect(readEdgeLogWindow).not.toHaveBeenCalled();
        expect(scaleService).not.toHaveBeenCalled();
    });

    it("scales a service on another server on CPU alone", async () => {
        findMany.mockResolvedValue([
            service("app-remote", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 }, "host")
        ]);
        cpu.percent = 80;
        log.text = traffic(NOW, 10_000);
        for (let tick = 0; tick < 3; tick++) await runAutoscale(NOW + tick * 60_000);
        expect(readEdgeLogWindow).not.toHaveBeenCalled();
        expect(scaleService).toHaveBeenCalledWith("app-remote", "owner-1", 2);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "autoscaled-cpu" }));
    });

    it("counts a log so busy that the part read holds only seconds", async () => {
        /** `count` requests in the five seconds before `at`, and nothing older. */
        const burst = (at: number, count: number) =>
            Array.from({ length: count }, (_, index) =>
                JSON.stringify({
                    StartUTC: new Date(at - 5_000 + index * 50).toISOString(),
                    RequestHost: "shop.example.com",
                    RequestMethod: "GET",
                    RequestPath: "/",
                    DownstreamStatus: 200,
                    "request_User-Agent": "Mozilla/5.0"
                })
            ).join("\n");
        findMany.mockResolvedValue([service("app-cut", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 })]);
        log.truncated = true;
        for (let tick = 0; tick < 3; tick++) {
            const at = NOW + tick * 60_000;
            log.text = burst(at, 100);
            await runAutoscale(at);
        }
        expect(scaleService).toHaveBeenCalledWith("app-cut", "owner-1", 4);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "autoscaled-traffic" }));
    });

    it("steps from the copies the serving release runs, not the count it is set to", async () => {
        // Set to three by a change-over that never came up: two are still serving.
        findMany.mockResolvedValue([
            { ...service("app-short", { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: 100 }), replicas: 3 }
        ]);
        serving.mockResolvedValue([{ id: "app-short-deployment", replicas: 2 }]);
        for (let tick = 0; tick < 3; tick++) {
            const at = NOW + tick * 60_000;
            log.text = traffic(at, 250);
            await runAutoscale(at);
        }
        expect(scaleService).toHaveBeenCalledWith("app-short", "owner-1", 3);
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ from: 2, to: 3 }) })
        );
    });
});
