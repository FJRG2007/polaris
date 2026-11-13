/**
 * Transactions arriving at the ingest, and the job that turns a slow route into
 * an issue. The database is a mock: what is asserted is what would be written.
 */

import * as perf from "@/lib/telemetry/performance";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserInp, browserPageload, envelopeOf, nodeRequest } from "./fixtures";

const captureEvent = vi.fn(async () => undefined);
const db = {
    telemetryPerfRoute: {
        upsert: vi.fn(async () => ({ id: "route-1", p95: null, metric: "duration", targetMs: null })),
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    telemetryPerfBucket: {
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    telemetryPerfSample: { create: vi.fn(async () => ({})) },
    telemetryIssue: { findUnique: vi.fn(async () => ({ id: "issue-1" })) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db))
};

vi.mock("@polaris/db", async (original) => ({
    ...(await original<typeof import("@polaris/db")>()),
    prisma: db
}));
vi.mock("@/lib/telemetry/store", () => ({ captureEvent }));
vi.mock("@/lib/telemetry/project-service", () => ({
    projectForIngest: vi.fn(async () => ({
        id: "p1",
        platform: null,
        secretHash: null,
        rules: { reporters: "anywhere", allowedCidrs: [], allowedUserAgents: [], deniedUserAgents: [], requireSecret: false }
    })),
    recordRefusal: vi.fn(async () => undefined),
    secretAccepted: vi.fn(() => false)
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: vi.fn(async () => ({ ok: true, remaining: 1, resetAt: new Date() }))
}));

const route = await import("../../../src/app/api/telemetry/api/[projectId]/[kind]/route");
const store = await import("@/lib/telemetry/performance-store");

const KEY = "abc123def456abc123def456abc12345";
const NOW = new Date("2026-01-01T12:00:00Z");

function post(body: string) {
    return route.POST(
        new Request(`https://polaris.test/api/telemetry/api/7/envelope/?sentry_key=${KEY}`, { method: "POST", body }),
        { params: Promise.resolve({ projectId: "7", kind: "envelope" }) }
    );
}

beforeEach(() => vi.clearAllMocks());

describe("a transaction envelope", () => {
    it("adds the browser's page load and INP to the route's histograms, and opens no issue", async () => {
        const response = await post(
            envelopeOf([
                { type: "transaction", payload: browserPageload },
                { type: "span", payload: browserInp }
            ])
        );
        expect(response.status).toBe(200);
        expect(captureEvent).not.toHaveBeenCalled();
        expect(db.telemetryPerfRoute.upsert).toHaveBeenCalledTimes(2);
        expect(db.telemetryPerfRoute.upsert.mock.calls.map((call) => (call as unknown[])[0])).toMatchObject([
            { where: { projectId_op_name: { projectId: "p1", op: "pageload", name: "/checkout/:step" } } },
            { where: { projectId_op_name: { projectId: "p1", op: "pageload", name: "/checkout/:step" } } }
        ]);
        // One statement per transaction, whatever it carried.
        expect(db.$executeRaw).toHaveBeenCalledTimes(2);
        // Over the default target with no p95 yet: kept as a slow sample.
        expect(db.telemetryPerfSample.create).toHaveBeenCalledTimes(1);
    });

    it("keeps a node request and stores a fast one only as a count", async () => {
        db.telemetryPerfRoute.upsert.mockResolvedValueOnce({ id: "route-2", p95: 2000, metric: "duration", targetMs: null });
        await post(envelopeOf([{ type: "transaction", payload: nodeRequest }]));
        expect(db.$executeRaw).toHaveBeenCalledTimes(1);
        expect(db.telemetryPerfSample.create).not.toHaveBeenCalled();
    });

    it("still stores the crash beside a transaction", async () => {
        await post(
            envelopeOf([
                { type: "transaction", payload: nodeRequest },
                { type: "event", payload: { exception: { values: [{ type: "TypeError", value: "boom" }] } } }
            ])
        );
        expect(captureEvent).toHaveBeenCalledTimes(1);
    });
});

/** An hourly bucket holding `values`, `hoursAgo` before NOW. */
function bucket(routeId: string, metric: string, hoursAgo: number, values: readonly number[]) {
    return {
        routeId,
        metric,
        at: new Date(NOW.getTime() - hoursAgo * 3_600_000),
        hist: values.reduce<number[]>((hist, value) => perf.mergeHistograms(hist, perf.histogramOf(value)), [])
    };
}

describe("the telemetry-performance job", () => {
    const slowRoute = {
        id: "route-1",
        projectId: "p1",
        name: "/checkout/:step",
        op: "pageload",
        targetMs: null,
        flaggedAt: null,
        project: { perfTargetMs: null, platform: "javascript" }
    };

    it("opens a performance issue for a page over its LCP target, through the issue workflow", async () => {
        db.telemetryPerfRoute.findMany.mockResolvedValueOnce([slowRoute]);
        db.telemetryPerfBucket.findMany
            .mockResolvedValueOnce([]) // no hours to fold
            .mockResolvedValueOnce([
                bucket("route-1", "lcp", 2, Array.from({ length: 40 }, () => 3200)),
                bucket("route-1", "duration", 2, Array.from({ length: 40 }, () => 3500))
            ]);
        const result = await store.runPerformanceJob(NOW);
        expect(result).toMatchObject({ evaluated: 1, flagged: 1 });
        expect(captureEvent).toHaveBeenCalledTimes(1);
        const [project, event] = captureEvent.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(project).toEqual({ id: "p1", platform: "javascript" });
        expect(event).toMatchObject({
            level: "warning",
            type: "slow.pageload",
            fingerprint: "performance:route-1",
            culprit: "/checkout/:step"
        });
        expect(db.telemetryPerfRoute.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "route-1" },
                data: expect.objectContaining({ metric: "lcp", count: 40, issueId: "issue-1", flaggedAt: NOW })
            })
        );
    });

    it("leaves a fast route alone, and tells a slow one at most hourly", async () => {
        db.telemetryPerfRoute.findMany.mockResolvedValueOnce([
            { ...slowRoute, id: "fast", op: "http.server" },
            { ...slowRoute, id: "told", flaggedAt: new Date(NOW.getTime() - 10 * 60_000) }
        ]);
        db.telemetryPerfBucket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
            bucket("fast", "duration", 1, Array.from({ length: 40 }, () => 120)),
            bucket("told", "lcp", 1, Array.from({ length: 40 }, () => 4000))
        ]);
        const result = await store.runPerformanceJob(NOW);
        expect(result.flagged).toBe(0);
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("folds hours older than two days into their day in one transaction", async () => {
        const old = new Date(NOW.getTime() - 3 * 24 * 3_600_000);
        db.telemetryPerfBucket.findMany.mockResolvedValueOnce([
            { id: "h1", routeId: "r", metric: "duration", at: old, count: 1, sum: 10, hist: perf.histogramOf(10) },
            { id: "h2", routeId: "r", metric: "duration", at: new Date(old.getTime() + 3_600_000), count: 2, sum: 30, hist: perf.histogramOf(15) }
        ]);
        const result = await store.runPerformanceJob(NOW);
        expect(result.folded).toBe(2);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(db.telemetryPerfBucket.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["h1", "h2"] } } });
    });

    it("splits buckets into the last day and the week before", () => {
        const stats = store.windowStats(
            [bucket("r", "duration", 3, [100]), bucket("r", "duration", 30, [200, 300])],
            NOW
        );
        const window = stats.get("duration");
        expect(window?.recent.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(window?.baseline.reduce((sum, count) => sum + count, 0)).toBe(2);
    });
});
