/**
 * Taking old records away without taking the wrong ones.
 *
 * This is the one feature in Polaris whose bug is deleted data, so what is
 * asserted is mostly the refusals.
 *
 * - **Zero is forever.** It matches every other limit here, and the failure if it
 *   were read the other way round is not a bug report, it is an empty table. A
 *   policy that cannot be parsed falls back to the defaults for the same reason,
 *   field by field, so one bad number cannot take the other two with it.
 * - **The audit table's timestamp is called something else.** It is `at`, not
 *   `createdAt`. A sweep that guessed would delete nothing forever while
 *   reporting success, which is the quietest possible failure.
 * - **A pass is bounded and says so.** The first run on a year of history is
 *   millions of rows, and one statement holding that lock is an outage; `more`
 *   is what lets the schedule take the next bite instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Rows in each table, by the moment they were written. */
let rows: Record<"notification" | "activity" | "auditLog", { id: string; when: Date }[]>;
/** Every `where` each table was handed, so the column being filtered on can be
 *  asserted rather than assumed. */
let queried: Record<string, unknown[]>;
/** What the settings table holds for the policy. */
let stored: string | null = null;

function table(name: "notification" | "activity" | "auditLog", column: "createdAt" | "at") {
    return {
        findMany: async ({ where, take }: { where: Record<string, { lt: Date }>; take: number }) => {
            queried[name]?.push(where);
            const cutoff = where[column]?.lt;
            if (!cutoff) return [];
            return rows[name]
                .filter((row) => row.when < cutoff)
                .sort((left, right) => left.when.getTime() - right.when.getTime())
                .slice(0, take)
                .map((row) => ({ id: row.id }));
        },
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
            const going = new Set(where.id.in);
            const before = rows[name].length;
            rows[name] = rows[name].filter((row) => !going.has(row.id));
            return { count: before - rows[name].length };
        },
        count: async (args?: { where?: Record<string, { lt: Date }> }) => {
            const cutoff = args?.where?.[column]?.lt;
            return cutoff ? rows[name].filter((row) => row.when < cutoff).length : rows[name].length;
        }
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        notification: table("notification", "createdAt"),
        activity: table("activity", "createdAt"),
        auditLog: table("auditLog", "at")
    }
}));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => stored,
    setSetting: async (_key: string, value: string | null) => {
        stored = value;
    }
}));

const { retentionPolicy, retentionTotals, setRetentionPolicy, sweepRetention } = await import(
    "@/lib/retention-service"
);
const { RETENTION_DEFAULTS } = await import("@polaris/core");

const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A row written this many days before now. */
function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function fill(name: "notification" | "activity" | "auditLog", ages: number[]): void {
    rows[name] = ages.map((days, index) => ({ id: `${name}-${index}`, when: daysAgo(days) }));
}

beforeEach(() => {
    rows = { notification: [], activity: [], auditLog: [] };
    queried = { notification: [], activity: [], auditLog: [] };
    stored = null;
});

describe("what an instance nobody has configured does", () => {
    it("opens on the defaults", async () => {
        expect(await retentionPolicy()).toEqual(RETENTION_DEFAULTS);
    });

    it("falls back to them rather than throwing on a policy it cannot read", async () => {
        stored = "{not json";
        expect(await retentionPolicy()).toEqual(RETENTION_DEFAULTS);
        stored = JSON.stringify({ notifications: 45, activity: 365, audit: 365 });
        expect(await retentionPolicy()).toEqual(RETENTION_DEFAULTS);
    });

    it("keeps none of the three forever by default", async () => {
        // A default that never deletes quietly fills a disk on every instance
        // whose operator never opened the screen, which is every instance until
        // the day it matters.
        const policy = await retentionPolicy();
        expect(policy.notifications).toBeGreaterThan(0);
        expect(policy.activity).toBeGreaterThan(0);
        expect(policy.audit).toBeGreaterThan(0);
    });
});

describe("one pass", () => {
    it("takes what is past its period and leaves the rest", async () => {
        await setRetentionPolicy({ notifications: 30, activity: 365, audit: 365 });
        fill("notification", [1, 10, 29, 31, 400]);

        const result = await sweepRetention(NOW);

        expect(result.notifications).toBe(2);
        expect(rows.notification.map((row) => row.id)).toEqual([
            "notification-0",
            "notification-1",
            "notification-2"
        ]);
    });

    it("reads the audit table by its own timestamp column", async () => {
        // `at`, not `createdAt`. Guessing wrong here deletes nothing forever
        // while every pass reports success.
        await setRetentionPolicy({ notifications: 0, activity: 0, audit: 30 });
        fill("auditLog", [10, 90]);

        const result = await sweepRetention(NOW);

        expect(result.audit).toBe(1);
        expect(queried.auditLog[0]).toHaveProperty("at");
    });

    it("does not touch a table set to forever", async () => {
        await setRetentionPolicy({ notifications: 0, activity: 0, audit: 0 });
        fill("notification", [900]);
        fill("activity", [900]);
        fill("auditLog", [900]);

        const result = await sweepRetention(NOW);

        expect(result).toMatchObject({ notifications: 0, activity: 0, audit: 0, more: false });
        // Not merely deleted nothing: it did not ask, which is what keeps a
        // "forever" from costing a query per pass per table.
        expect(queried.notification).toHaveLength(0);
        expect(queried.activity).toHaveLength(0);
        expect(queried.auditLog).toHaveLength(0);
        expect(rows.notification).toHaveLength(1);
    });

    it("says when there is more, so the schedule takes the next bite", async () => {
        await setRetentionPolicy({ notifications: 1, activity: 0, audit: 0 });
        // Past the batch, which is what a deployment with a year of history looks
        // like on its first pass.
        fill(
            "notification",
            Array.from({ length: 5200 }, () => 30)
        );

        const first = await sweepRetention(NOW);
        expect(first.notifications).toBe(5000);
        expect(first.more).toBe(true);

        const second = await sweepRetention(NOW);
        expect(second.notifications).toBe(200);
        expect(second.more).toBe(false);
        expect(rows.notification).toHaveLength(0);
    });

    it("takes the oldest first", async () => {
        // A bounded pass has to catch up from the far end, or a table that grows
        // faster than the batch never loses its oldest rows.
        await setRetentionPolicy({ notifications: 1, activity: 0, audit: 0 });
        fill("notification", [400, 2, 200]);

        await sweepRetention(NOW);
        expect(rows.notification).toHaveLength(0);
    });
});

describe("what the screen is told", () => {
    it("counts what is kept and what is already due", async () => {
        const policy = await setRetentionPolicy({ notifications: 30, activity: 365, audit: 365 });
        fill("notification", [1, 40, 90]);
        fill("activity", [1, 400]);

        const totals = await retentionTotals(policy, NOW);

        expect(totals.notifications).toEqual({ total: 3, due: 2 });
        expect(totals.activity).toEqual({ total: 2, due: 1 });
    });

    it("says nothing is due where the answer is forever", async () => {
        const policy = await setRetentionPolicy({ notifications: 0, activity: 0, audit: 0 });
        fill("notification", [900, 900]);

        const totals = await retentionTotals(policy, NOW);

        expect(totals.notifications).toEqual({ total: 2, due: 0 });
    });
});
