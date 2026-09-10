/**
 * A month's statement, read from the tables the collector writes.
 *
 * The arithmetic is pinned in `@polaris/core`; this pins the reading around it:
 * that the folded hours and the not-yet-folded tail are read from the right
 * table each, never both for the same hour; that a service's CPU is turned into
 * cores by the machine it runs on and left unmeasured when that machine's count
 * is unknown; that volumes land on their service's project; and that a month
 * nothing is kept for is refused rather than answered with zeros.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const GB = 1024 ** 3;
const projectFindMany = vi.fn();
const rollupAggregate = vi.fn();
const rollupFindMany = vi.fn();
const sampleFindMany = vi.fn();
const settingFindMany = vi.fn();
const settingFindUnique = vi.fn();
const snapshots = new Map<string, Record<string, unknown>>();
const FROZEN_AT = new Date("2026-09-02T08:00:00Z");
const snapshotFindUnique = vi.fn(async (query: { where: { month: string } }) => snapshots.get(query.where.month) ?? null);
const snapshotCreateMany = vi.fn(async (query: { data: { month: string }[] }) => {
    for (const row of query.data) if (!snapshots.has(row.month)) snapshots.set(row.month, { ...row, createdAt: FROZEN_AT });
    return { count: query.data.length };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        project: { findMany: projectFindMany },
        metricRollup: { aggregate: rollupAggregate, findMany: rollupFindMany },
        metricSample: { findMany: sampleFindMany },
        setting: { findMany: settingFindMany, findUnique: settingFindUnique },
        statementSnapshot: { findUnique: snapshotFindUnique, createMany: snapshotCreateMany }
    }
}));

const { LOCAL_HOST_SUBJECT } = await import("@/lib/metrics-shared");
const { readStatement, resolveMonth, BillingRequestError } = await import("../../src/lib/billing/statement");

const NOW = new Date("2026-09-10T11:30:00Z");
const RATES = { currency: "EUR", cpuHour: 0.1, memoryGbHour: null, storageGbMonth: 1, egressGb: 0.5 };

beforeEach(() => {
    vi.clearAllMocks();
    snapshots.clear();
    projectFindMany.mockResolvedValue([
        {
            id: "p1",
            name: "Site",
            ownerId: "u1",
            orgId: "o1",
            org: { name: "Acme", slug: "acme" },
            owner: { name: "Ana", username: "ana" },
            environments: [
                {
                    applications: [
                        { id: "a1", target: { kind: "local", hostId: null }, volumes: [{ id: "v1" }] }
                    ]
                }
            ]
        },
        {
            id: "p2",
            name: "Blog",
            ownerId: "u2",
            orgId: null,
            org: null,
            owner: { name: null, username: "bo" },
            environments: [{ applications: [{ id: "a2", target: { kind: "host", hostId: "h1" }, volumes: [] }] }]
        }
    ]);
    // The box Polaris runs on has four cores; the server h1 has not said yet.
    settingFindMany.mockResolvedValue([{ key: `metrics.cpus.${LOCAL_HOST_SUBJECT}`, value: "4" }]);
    settingFindUnique.mockResolvedValue({ value: JSON.stringify(RATES) });
    // Folded up to and including the 09:00 hour, so the tail starts at 10:00.
    rollupAggregate.mockResolvedValue({ _max: { bucket: new Date("2026-09-10T09:00:00Z") } });
    rollupFindMany.mockImplementation(async (query: { cursor?: unknown }) =>
        query.cursor
            ? []
            : [
                  {
                      subjectType: "app",
                      subjectId: "a1",
                      bucket: new Date("2026-09-01T00:00:00Z"),
                      cpuPercentAvg: 50,
                      memUsedBytesAvg: BigInt(GB),
                      diskUsedBytesAvg: null,
                      netTxBytesSum: null,
                      samples: 60
                  },
                  {
                      subjectType: "app",
                      subjectId: "a2",
                      bucket: new Date("2026-09-01T00:00:00Z"),
                      cpuPercentAvg: 25,
                      memUsedBytesAvg: null,
                      diskUsedBytesAvg: null,
                      netTxBytesSum: null,
                      samples: 60
                  },
                  {
                      subjectType: "volume",
                      subjectId: "v1",
                      bucket: new Date("2026-09-01T00:00:00Z"),
                      cpuPercentAvg: null,
                      memUsedBytesAvg: null,
                      diskUsedBytesAvg: BigInt(10 * GB),
                      netTxBytesSum: null,
                      samples: 12
                  }
              ]
    );
    // Two raw readings of a1 in the unfolded 10:00 hour, a gigabyte sent between.
    sampleFindMany.mockResolvedValue([
        {
            subjectType: "app",
            subjectId: "a1",
            ts: new Date("2026-09-10T10:00:00Z"),
            cpuPercent: 30,
            memUsedBytes: null,
            diskUsedBytes: null,
            netTxBytes: BigInt(5 * GB)
        },
        {
            subjectType: "app",
            subjectId: "a1",
            ts: new Date("2026-09-10T10:01:00Z"),
            cpuPercent: 30,
            memUsedBytes: null,
            diskUsedBytes: null,
            netTxBytes: BigInt(6 * GB)
        }
    ]);
});

describe("reading a month's statement", () => {
    it("reads folded hours from the rollups and the rest from the raw samples, never both", async () => {
        await readStatement({ kind: "all" }, "2026-09", NOW);
        const rollupWhere = rollupFindMany.mock.calls[0]?.[0]?.where;
        expect(rollupWhere.bucket).toEqual({
            gte: new Date("2026-09-01T00:00:00Z"),
            lt: new Date("2026-09-10T10:00:00Z")
        });
        const rawWhere = sampleFindMany.mock.calls[0]?.[0]?.where;
        expect(rawWhere.ts).toEqual({ gte: new Date("2026-09-10T10:00:00Z"), lt: NOW });
    });

    it("bills each subject to its project, and turns CPU into cores by its machine", async () => {
        const view = await readStatement({ kind: "all" }, "2026-09", NOW);
        const site = view.statement.lines.find((line) => line.projectId === "p1");
        const blog = view.statement.lines.find((line) => line.projectId === "p2");

        // Half of a four-core machine for an hour, plus 30% of it for two minutes.
        expect(site?.usage.cpuHours).toBeCloseTo(2 + 0.3 * 4 * (2 / 60));
        expect(site?.usage.memoryGbHours).toBeCloseTo(1);
        expect(site?.usage.storageGbHours).toBeCloseTo(10);
        expect(site?.usage.egressGb).toBeCloseTo(1);
        expect(site?.owner).toEqual({ kind: "org", id: "o1", name: "Acme", handle: "acme" });

        // h1 has not reported its cores: its CPU is flagged, not guessed.
        expect(blog?.usage.cpuHours).toBe(0);
        expect(blog?.usage.cpuUnmeasuredHours).toBeCloseTo(1);
        expect(blog?.owner).toEqual({ kind: "user", id: "u2", name: "@bo", handle: "bo" });
    });

    it("prices the lines at the stored rates", async () => {
        const view = await readStatement({ kind: "all" }, "2026-09", NOW);
        const site = view.statement.lines.find((line) => line.projectId === "p1");
        // 2.04 vCPU-h at 0.10, 10 GB-h of a 720-hour month at 1.00, 1 GB out at 0.50.
        expect(site?.cost).toEqual({ cpu: 0.2, memory: null, storage: 0.01, egress: 0.5, total: 0.71 });
        expect(view.current).toBe(true);
        expect(view.through).toBe(NOW.toISOString());
        expect(view.monthLabel).toBe("September 2026");
    });

    it("scopes the projects it reads to the organizations it was handed", async () => {
        await readStatement({ kind: "orgs", orgIds: ["o1"] }, "2026-09", NOW);
        expect(projectFindMany.mock.calls[0]?.[0]?.where).toEqual({ orgId: { in: ["o1"] } });
    });

    it("reads no raw samples for a month that has ended", async () => {
        await readStatement({ kind: "all" }, "2026-08", NOW);
        expect(sampleFindMany).not.toHaveBeenCalled();
    });

    it("says when the start of a month is older than the figures kept", async () => {
        const view = await readStatement({ kind: "all" }, "2026-06", NOW);
        expect(view.keptFrom).not.toBeNull();
        expect(view.current).toBe(false);
    });
});

describe("a month that has ended", () => {
    it("is frozen the first time it is read, and read back unchanged after the prices and projects change", async () => {
        const first = await readStatement({ kind: "all" }, "2026-08", NOW);
        expect(snapshotCreateMany).toHaveBeenCalledTimes(1);
        expect(first.generatedAt).toBe(FROZEN_AT.toISOString());

        settingFindUnique.mockResolvedValue({ value: JSON.stringify({ ...RATES, currency: "USD", cpuHour: 9 }) });
        projectFindMany.mockResolvedValue([]);
        const again = await readStatement({ kind: "all" }, "2026-08", new Date("2026-11-01T00:00:00Z"));

        expect(again.statement).toEqual(first.statement);
        expect(again.statement.rates?.currency).toBe("EUR");
        expect(projectFindMany).toHaveBeenCalledTimes(1);
        expect(snapshotCreateMany).toHaveBeenCalledTimes(1);
    });

    it("gives each scope its own projects from the one frozen month", async () => {
        await readStatement({ kind: "all" }, "2026-08", NOW);
        const org = await readStatement({ kind: "orgs", orgIds: ["o1"] }, "2026-08", NOW);
        expect(org.statement.lines.map((line) => line.projectId)).toEqual(["p1"]);
        expect(projectFindMany).toHaveBeenCalledTimes(1);
        expect(projectFindMany.mock.calls[0]?.[0]?.where).toEqual({});
    });

    it("stays live until its last readings have landed, and the running month is never frozen", async () => {
        await readStatement({ kind: "all" }, "2026-09", NOW);
        await readStatement({ kind: "all" }, "2026-08", new Date("2026-09-01T00:10:00Z"));
        expect(snapshotFindUnique).not.toHaveBeenCalled();
        expect(snapshotCreateMany).not.toHaveBeenCalled();
    });
});

describe("which months can be asked for", () => {
    it("takes this month when none is named", () => {
        expect(resolveMonth(undefined, NOW)).toBe("2026-09");
        expect(resolveMonth("2026-07", NOW)).toBe("2026-07");
    });

    it("refuses a month to come and one nothing is kept for", () => {
        expect(() => resolveMonth("2026-10", NOW)).toThrow(BillingRequestError);
        expect(() => resolveMonth("2025-01", NOW)).toThrow("No figures are kept for that month");
    });
});
