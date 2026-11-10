/**
 * The sessions screen's reads: visits split on a half-hour gap, the session
 * list keyset-paged on (last seen, id) with an opaque cursor, the totals over
 * the window, identify() properties, and a face that is the same for the same
 * session every time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    queries: [] as { sql: string; values: unknown[] }[],
    answers: [] as unknown[][],
    findFirst: null as unknown,
    count: 0
}));

vi.mock("@polaris/db", async () => {
    const actual = await vi.importActual<typeof import("@polaris/db")>("@polaris/db");
    return {
        Prisma: actual.Prisma,
        prisma: {
            $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
                db.queries.push({ sql: query.sql, values: query.values });
                return db.answers.shift() ?? [];
            }),
            analyticsSession: {
                findFirst: vi.fn(async () => db.findFirst),
                count: vi.fn(async () => db.count)
            },
            analyticsEvent: { findMany: vi.fn(async () => db.answers.shift() ?? []) },
            analyticsDay: {
                aggregate: vi.fn(async () => ({ _sum: { visitors: 40, views: 90 } })),
                findMany: vi.fn(async () => [{ value: "ES" }, { value: "FR" }, { value: "" }])
            }
        }
    };
});

const reports = await import("@/lib/analytics-reports");
const { avatarShape, seedOf } = await import("@/app/(app)/analytics/session-face");

const SITE = "0192f0aa-0000-7000-8000-0000000000f1";
const DAY = 86_400_000;
const window = (span = DAY) => ({ siteId: SITE, from: 1_700_000_000_000, to: 1_700_000_000_000 + span, filters: [] });

function session(id: string, lastSeen: number) {
    return {
        id,
        ip: "203.0.113.7",
        browser: "Firefox",
        os: "Linux",
        device: "desktop",
        country: "ES",
        language: "es-ES",
        screen: "1920x1080",
        distinctId: null,
        views: 3,
        startedAt: new Date(lastSeen - 60_000),
        lastSeenAt: new Date(lastSeen)
    };
}

beforeEach(() => {
    db.queries = [];
    db.answers = [];
    db.findFirst = null;
    db.count = 0;
});

describe("visitIndexes", () => {
    it("starts a new visit after more than thirty idle minutes", () => {
        const minute = 60_000;
        expect(reports.visitIndexes([0, 10 * minute, 40 * minute, 41 * minute, 120 * minute])).toEqual([0, 0, 0, 0, 1]);
        expect(reports.visitIndexes([0, 31 * minute, 61 * minute])).toEqual([0, 1, 1]);
        expect(reports.visitIndexes([])).toEqual([]);
    });
});

describe("session cursor", () => {
    it("round-trips and refuses anything it did not write", () => {
        const at = new Date("2026-11-10T10:00:00.000Z");
        const cursor = reports.encodeSessionCursor(at, "abc123def");
        expect(reports.decodeSessionCursor(cursor)).toEqual({ at, id: "abc123def" });
        expect(reports.decodeSessionCursor("not-a-cursor")).toBeNull();
        expect(reports.decodeSessionCursor(Buffer.from('["nope","x"]').toString("base64url"))).toBeNull();
        expect(reports.decodeSessionCursor("x".repeat(600))).toBeNull();
        expect(reports.decodeSessionCursor(null)).toBeNull();
    });
});

describe("sessionPage", () => {
    it("pages on (lastSeenAt, id), binds the cursor, and folds in the counts", async () => {
        const rows = Array.from({ length: reports.SESSION_PAGE + 1 }, (_, index) => session(`s-${index}`, 1_700_000_050_000 - index));
        db.answers.push(rows, [{ sessionId: "s-0", visits: 2, views: 7, events: 3, lastPath: "/pricing" }]);
        const page = await reports.sessionPage(window(), null);
        expect(page.rows).toHaveLength(reports.SESSION_PAGE);
        expect(page.rows[0]).toMatchObject({ id: "s-0", visits: 2, views: 7, events: 3, lastPath: "/pricing", ip: "203.0.113.7" });
        expect(page.rows[1]).toMatchObject({ visits: 1, views: 3, events: 0 });
        expect(page.next).not.toBeNull();
        expect(db.queries[0]!.sql).toContain('ORDER BY s."lastSeenAt" DESC, s.id DESC');
        expect(db.queries[1]!.sql).toContain("interval '30 minutes'");

        db.queries = [];
        db.answers.push([], []);
        const next = await reports.sessionPage(window(), page.next);
        expect(next).toEqual({ rows: [], next: null });
        expect(db.queries[0]!.sql).toContain('(s."lastSeenAt", s.id) <');
        const last = rows[reports.SESSION_PAGE - 1]!;
        expect(db.queries[0]!.values).toContain(last.id);
        expect(db.queries[0]!.sql).not.toContain(last.id);
    });

    it("says there is no next page on the last one", async () => {
        db.answers.push([session("only-one", 1_700_000_050_000)], []);
        const page = await reports.sessionPage(window(), null);
        expect(page.rows).toHaveLength(1);
        expect(page.next).toBeNull();
    });
});

describe("sessionStats", () => {
    it("counts visitors, visits, views and countries from the raw rows inside a month", async () => {
        db.answers.push([{ visitors: 12, countries: 4 }], [{ visits: 15, views: 40 }]);
        await expect(reports.sessionStats(window())).resolves.toEqual({
            visitors: 12,
            visits: 15,
            views: 40,
            countries: 4,
            source: "raw"
        });
    });

    it("reads the daily totals past a month and does not invent visits", async () => {
        await expect(reports.sessionStats(window(90 * DAY))).resolves.toEqual({
            visitors: 40,
            visits: null,
            views: 90,
            countries: 2,
            source: "daily"
        });
        expect(db.queries).toHaveLength(0);
    });
});

describe("sessionProperties", () => {
    it("lists keys, then one key's values, with the key bound", async () => {
        await reports.sessionProperties(window());
        await reports.sessionProperties(window(), "plan'; DROP TABLE x;--");
        expect(db.queries[0]!.sql).toContain("jsonb_each_text(s.data::jsonb)");
        expect(db.queries[1]!.values).toContain("plan'; DROP TABLE x;--");
        expect(db.queries[1]!.sql).not.toContain("DROP TABLE");
    });
});

describe("sessionJourney", () => {
    it("adds visit numbers, totals and linked sessions", async () => {
        const base = 1_700_000_000_000;
        db.findFirst = { ...session("journey-1", base + 3 * 3_600_000), distinctId: "user-9", startedAt: new Date(base), data: null, referrerKind: "direct", referrerSource: null, campaign: null, medium: null };
        db.count = 3;
        db.answers.push(
            [
                { at: new Date(base), kind: "pageview", name: null, path: "/", rawPath: null, props: null },
                { at: new Date(base + 60_000), kind: "event", name: "signup", path: "/", rawPath: null, props: '{"plan":"pro"}' },
                { at: new Date(base + 3 * 3_600_000), kind: "pageview", name: null, path: "/docs", rawPath: null, props: null }
            ],
            [{ sessionId: "journey-1", visits: 2, views: 2, events: 1, lastPath: "/docs" }]
        );
        const journey = await reports.sessionJourney(SITE, "journey-1");
        expect(journey).toMatchObject({ visitCount: 2, pageviews: 2, eventCount: 1, linkedSessions: 3, durationSec: 10_800, truncated: false });
        expect(journey!.events.map((event) => event.visit)).toEqual([0, 0, 1]);
        expect(journey!.events[1]!.props).toEqual({ plan: "pro" });
    });
});

describe("session avatar", () => {
    it("is the same for the same id and differs between ids", () => {
        expect(avatarShape("abc")).toEqual(avatarShape("abc"));
        expect(seedOf("abc")).not.toBe(seedOf("abd"));
        expect(avatarShape("abc")).not.toEqual(avatarShape("xyz"));
    });
});
