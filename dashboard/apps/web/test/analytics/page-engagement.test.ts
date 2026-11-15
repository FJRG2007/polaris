/**
 * Scroll depth and time on page: the leave beat fills the latest unmeasured
 * view of the page being left (clamped, never twice), and the report says a
 * range past 31 days is not answered rather than reading the raw rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn(async (_args: unknown) => ({ id: "event-1" }) as { id: string } | null);
const updateEvents = vi.fn(async (_args: unknown) => ({ count: 1 }));
const queryRaw = vi.fn(async () => []);

vi.mock("@polaris/db", () => ({
    Prisma: { sql: () => ({}), empty: {} },
    prisma: {
        analyticsSession: { updateMany: async () => ({ count: 1 }) },
        analyticsEvent: { findFirst: (args: unknown) => findFirst(args), updateMany: (args: unknown) => updateEvents(args) },
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

const leave = { siteId: "site-1", at: Date.UTC(2026, 10, 15), ip: "203.0.113.5", userAgent: "Mozilla/5.0", url: "/pricing?ref=x" };

beforeEach(() => {
    findFirst.mockClear();
    updateEvents.mockClear();
    queryRaw.mockClear();
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
    it("is unavailable past 31 days, without reading the raw rows", async () => {
        const report = await engagement({ siteId: "site-1", from: 0, to: 90 * 86_400_000, filters: [] });
        expect(report).toEqual({ pages: [], unavailable: true });
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("formats the time on a page", () => {
        expect(pageTime(null)).toBe("-");
        expect(pageTime(42_000)).toBe("42s");
        expect(pageTime(65_000)).toBe("1m 05s");
    });
});
