/**
 * Scroll depth and time on page: the leave beat fills the latest unmeasured
 * view of the page being left (clamped, never twice), and the report says a
 * range past 31 days is not answered rather than reading the raw rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn(async (_args: unknown) => ({ id: "event-1" }) as { id: string } | null);
const updateEvents = vi.fn(async (_args: unknown) => ({ count: 1 }));
const queryRaw = vi.fn(async () => []);
const groupDays = vi.fn(async (_args: unknown) => [
    { value: "/pricing", _sum: { engagedViews: 10, scrollSum: 600, scrollViews: 8, deepViews: 4, engagedMsSum: 90_000, timedViews: 9 } }
]);

vi.mock("@polaris/db", () => ({
    Prisma: { sql: () => ({}), empty: {} },
    prisma: {
        analyticsSession: { updateMany: async () => ({ count: 1 }) },
        analyticsEvent: { findFirst: (args: unknown) => findFirst(args), updateMany: (args: unknown) => updateEvents(args) },
        analyticsDay: { groupBy: (args: unknown) => groupDays(args) },
        setting: { findUnique: async () => null },
        $queryRaw: () => queryRaw()
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => "salt", setSetting: async () => undefined }));
vi.mock("@/lib/analytics-geoip", () => ({ countryForIp: () => null }));
vi.mock("@/lib/access/forget", () => ({ forgetSubject: async () => undefined }));
vi.mock("@/app/(app)/analytics/analytics-reports", () => ({ Empty: () => null, Failure: () => null, Rows: () => null, useReport: () => ({}) }));

const { recordVisitLeave } = await import("@/lib/analytics-service");
const { engagement } = await import("@/lib/analytics-reports");
const { pageTime } = await import("@/app/(app)/analytics/engagement-card");
const { foldEngagement } = await import("@/lib/analytics-ingest");

const leave = { siteId: "site-1", at: Date.UTC(2026, 10, 15), ip: "203.0.113.5", userAgent: "Mozilla/5.0", url: "/pricing?ref=x" };

beforeEach(() => {
    findFirst.mockClear();
    updateEvents.mockClear();
    queryRaw.mockClear();
    groupDays.mockClear();
});

describe("the leave beat", () => {
    it("fills the latest unmeasured view of the page left, clamped", async () => {
        await recordVisitLeave({ ...leave, durationMs: 42_000, scroll: 140 });
        expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
            where: { siteId: "site-1", kind: "pageview", path: "/pricing", engagedMs: null, scrollPct: null },
            orderBy: { at: "desc" }
        });
        expect(updateEvents).toHaveBeenCalledWith({ where: { id: "event-1" }, data: { engagedMs: 42_000, scrollPct: 100 } });
    });

    it("writes nothing when the view was already measured", async () => {
        findFirst.mockResolvedValueOnce(null);
        await recordVisitLeave({ ...leave, durationMs: 5000, scroll: 30 });
        expect(updateEvents).not.toHaveBeenCalled();
    });

    it("looks for no view when the beat measured nothing", async () => {
        await recordVisitLeave({ ...leave });
        expect(findFirst).not.toHaveBeenCalled();
    });
});

describe("the report", () => {
    it("answers past 31 days from the daily rollup, without reading the raw rows", async () => {
        const report = await engagement({ siteId: "site-1", from: 0, to: 90 * 86_400_000, filters: [] });
        expect(report).toEqual({
            unavailable: false,
            pages: [{ path: "/pricing", measured: 10, avgScroll: 75, deepShare: 0.4, avgEngagedMs: 10_000 }]
        });
        expect(groupDays.mock.calls[0]?.[0]).toMatchObject({ where: { siteId: "site-1", dimension: "path" }, take: 20 });
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("is unavailable past 31 days with a filter, which the rollup cannot apply", async () => {
        const filters = [{ dimension: "country", value: "ES" }] as never;
        const report = await engagement({ siteId: "site-1", from: 0, to: 90 * 86_400_000, filters });
        expect(report).toEqual({ pages: [], unavailable: true });
        expect(groupDays).not.toHaveBeenCalled();
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("formats the time on a page", () => {
        expect(pageTime(null)).toBe("-");
        expect(pageTime(42_000)).toBe("42s");
        expect(pageTime(65_000)).toBe("1m 05s");
    });
});

describe("the daily rollup", () => {
    it("folds sums and counts, skipping views that measured nothing", () => {
        const row = { engagedViews: 0, scrollSum: 0, scrollViews: 0, deepViews: 0, engagedMsSum: 0, timedViews: 0 };
        foldEngagement(row, { scrollPct: 80, engagedMs: 4000 });
        foldEngagement(row, { scrollPct: 20, engagedMs: null });
        foldEngagement(row, { scrollPct: null, engagedMs: 2000 });
        foldEngagement(row, { scrollPct: null, engagedMs: null });
        expect(row).toEqual({ engagedViews: 3, scrollSum: 100, scrollViews: 2, deepViews: 1, engagedMsSum: 6000, timedViews: 2 });
    });
});
