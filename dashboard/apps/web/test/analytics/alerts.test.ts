/**
 * Traffic alerts and summaries: a spike is told once per 12 hours, a drop never
 * for a site younger than a day, a summary a whole period after it was asked
 * for, and a reader who can no longer see the site loses the alert instead of
 * being told about it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.UTC(2026, 10, 15, 12);
const HOUR = 3_600_000;

let rows: Record<string, unknown>[] = [];
let online = 0;
let access: object | null = { site: {} };
const notify = vi.fn(async () => ({ inapp: "created" }));
const updates: unknown[] = [];
const deletes: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsAlert: {
            findMany: async () => rows,
            updateMany: async (args: unknown) => updates.push(args),
            deleteMany: async (args: unknown) => deletes.push(args)
        },
        analyticsSession: {
            count: async () => online,
            aggregate: async ({ where }: { where: { startedAt: { gte: Date } } }) =>
                where.startedAt.gte.getTime() >= NOW - 7 * 24 * HOUR
                    ? { _count: { _all: 30 }, _sum: { views: 90 } }
                    : { _count: { _all: 20 }, _sum: { views: 90 } }
        }
    }
}));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => [] }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: (input: unknown) => notify(input as never) }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@/app/(app)/analytics/site-access", () => ({ siteAccess: async () => access }));
vi.mock("@/app/(app)/analytics/actions", () => ({ getAlertSettingsAction: vi.fn(), setAlertSettingsAction: vi.fn() }));

const alerts = await import("@/lib/analytics-alerts");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "alert-1",
    userId: "user-1",
    spikeVisitors: null,
    dropVisitors: null,
    digest: "off",
    spikeSentAt: null,
    dropSentAt: null,
    digestSentAt: null,
    createdAt: new Date(NOW - 30 * 24 * HOUR),
    site: { id: "site-1", name: "Shop", scopeType: "external", scopeId: "user-1:shop", createdAt: new Date(NOW - 60 * 24 * HOUR) },
    ...overrides
});

beforeEach(() => {
    rows = [];
    online = 0;
    access = { site: {} };
    notify.mockClear();
    updates.length = 0;
    deletes.length = 0;
});

describe("the decisions", () => {
    it("waits out the gap between two notices", () => {
        expect(alerts.due(null, alerts.SPIKE_GAP_MS, NOW)).toBe(true);
        expect(alerts.due(new Date(NOW - 11 * HOUR), alerts.SPIKE_GAP_MS, NOW)).toBe(false);
        expect(alerts.due(new Date(NOW - 12 * HOUR), alerts.SPIKE_GAP_MS, NOW)).toBe(true);
    });

    it("tells a drop only for a site at least a day old", () => {
        expect(alerts.isDrop(2, 10, new Date(NOW - 2 * HOUR), NOW)).toBe(false);
        expect(alerts.isDrop(2, 10, new Date(NOW - 25 * HOUR), NOW)).toBe(true);
        expect(alerts.isDrop(10, 10, new Date(NOW - 25 * HOUR), NOW)).toBe(false);
        expect(alerts.isDrop(0, null, new Date(0), NOW)).toBe(false);
    });

    it("has no percent change against nothing", () => {
        expect(alerts.percentChange(5, 0)).toBeNull();
        expect(alerts.percentChange(30, 20)).toBe(50);
    });
});

describe("a pass", () => {
    it("tells a spike once and stamps it", async () => {
        online = 12;
        rows = [row({ spikeVisitors: 10 })];
        await alerts.runAnalyticsAlerts(NOW);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toMatchObject({ userId: "user-1", event: "analytics.traffic", href: "/analytics?scope=external&id=user-1%3Ashop" });
        expect(updates).toHaveLength(1);

        notify.mockClear();
        rows = [row({ spikeVisitors: 10, spikeSentAt: new Date(NOW - HOUR) })];
        await alerts.runAnalyticsAlerts(NOW);
        expect(notify).not.toHaveBeenCalled();
    });

    it("sends a weekly summary with the change against the week before", async () => {
        rows = [row({ digest: "weekly", digestSentAt: new Date(NOW - 8 * 24 * HOUR) })];
        await alerts.runAnalyticsAlerts(NOW);
        expect(notify).toHaveBeenCalledTimes(1);
        const body = (notify.mock.calls[0]?.[0] as unknown as { body: string }).body;
        expect(body).toContain("\"visitorsChange\":\"+50%\"");
        expect(body).toContain("\"viewsChange\":\"analytics.noChange\"");
    });

    it("does not send a summary before a whole period has passed", async () => {
        rows = [row({ digest: "monthly", digestSentAt: new Date(NOW - 20 * 24 * HOUR) })];
        await alerts.runAnalyticsAlerts(NOW);
        expect(notify).not.toHaveBeenCalled();
    });

    it("drops the alert of a reader who lost the site", async () => {
        access = null;
        online = 50;
        rows = [row({ spikeVisitors: 10 })];
        await alerts.runAnalyticsAlerts(NOW);
        expect(notify).not.toHaveBeenCalled();
        expect(deletes).toEqual([{ where: { id: "alert-1" } }]);
    });
});

describe("the threshold field", async () => {
    const { parseThreshold } = await import("@/app/(app)/analytics/alert-settings");
    it("reads empty as off and refuses what is not a whole number in range", () => {
        expect(parseThreshold("  ")).toBeNull();
        expect(parseThreshold("1,000")).toBe(1000);
        expect(parseThreshold("0")).toBe("invalid");
        expect(parseThreshold("-3")).toBe("invalid");
        expect(parseThreshold("2000000")).toBe("invalid");
    });
});
