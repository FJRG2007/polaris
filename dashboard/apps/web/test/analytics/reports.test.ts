/**
 * The Analytics report builders: filters map to the right columns, every value
 * reaches the database as a bound parameter (never spliced into the SQL), a
 * funnel is one query with a step per CTE, and the per-site ignore rules match
 * what they say.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ queries: [] as { sql: string; values: unknown[] }[], answer: [] as unknown[] }));

vi.mock("@polaris/db", async () => {
    const actual = await vi.importActual<typeof import("@polaris/db")>("@polaris/db");
    return {
        Prisma: actual.Prisma,
        prisma: {
            $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
                db.queries.push({ sql: query.sql, values: query.values });
                return db.answer;
            })
        }
    };
});

const reports = await import("@/lib/analytics-reports");

const SITE = "0192f0aa-0000-7000-8000-0000000000f1";
const window = (filters: core.VisitFilter[] = []) => ({ siteId: SITE, from: 0, to: 86_400_000, filters });

beforeEach(() => {
    db.queries = [];
    db.answer = [];
});

describe("filters", () => {
    it("map each dimension to its session column, Direct to no referrer", () => {
        expect(reports.sessionWhere([])).toEqual({});
        expect(
            reports.sessionWhere([
                { dimension: "browser", value: "Firefox", negate: false },
                { dimension: "referrer", value: "Direct", negate: false },
                { dimension: "path", value: "/pricing", negate: false }
            ])
        ).toEqual({
            AND: [
                { browser: "Firefox" },
                { referrerSource: null },
                { events: { some: { kind: "pageview", path: "/pricing" } } }
            ]
        });
    });

    it("keep visits with no value when a filter is negated", () => {
        expect(reports.sessionWhere([{ dimension: "country", value: "ES", negate: true }])).toEqual({
            AND: [{ OR: [{ NOT: { country: "ES" } }, { country: null }] }]
        });
    });

    it("read malformed filters off a URL as none", () => {
        expect(core.parseVisitFilters("not json")).toEqual([]);
        expect(core.parseVisitFilters(JSON.stringify([{ dimension: "nope", value: "x" }]))).toEqual([]);
        expect(core.parseVisitFilters(JSON.stringify([{ dimension: "os", value: " Linux " }]))).toEqual([
            { dimension: "os", value: "Linux", negate: false }
        ]);
    });
});

describe("queries", () => {
    it("bind every value a visitor or reader typed", async () => {
        const hostile = "'; DROP TABLE \"AnalyticsEvent\"; --";
        await reports.eventProperties(window([{ dimension: "browser", value: hostile, negate: false }]), hostile);
        const [query] = db.queries;
        expect(query!.sql).not.toContain("DROP TABLE");
        expect(query!.values).toContain(hostile);
        expect(query!.sql).toContain("s.\"browser\" =");
    });

    it("build a funnel as one query with a CTE per step and a count per step", async () => {
        db.answer = [{ c0: 10, c1: 4, c2: 1 }];
        const steps = await reports.funnel(window(), {
            steps: [
                { type: "path", value: "/" },
                { type: "path", value: "/pricing*" },
                { type: "event", value: "signup" }
            ],
            windowMinutes: 30
        });
        expect(db.queries).toHaveLength(1);
        const { sql, values } = db.queries[0]!;
        expect(sql).toMatch(/f0 AS[\s\S]*f1 AS[\s\S]*f2 AS/);
        expect(values).toContain("/pricing%");
        expect(values).toContain("signup");
        expect(values).toContain(30);
        expect(steps.map((step) => step.visitors)).toEqual([10, 4, 1]);
    });

    it("escape LIKE's own characters in a path prefix", async () => {
        db.answer = [{ c0: 0, c1: 0 }];
        await reports.funnel(window(), {
            steps: [
                { type: "path", value: "/50%_off*" },
                { type: "event", value: "buy" }
            ],
            windowMinutes: 5
        });
        expect(db.queries[0]!.values).toContain("/50\\%\\_off%");
    });

    it("answer every goal in one pass", async () => {
        db.answer = [{ total: 20, v0: 5, n0: 7, v1: 2, n1: 2 }];
        const result = await reports.goals(window(), [
            { id: "a", goal: { type: "event", value: "signup" } },
            { id: "b", goal: { type: "path", value: "/thanks" } }
        ]);
        expect(db.queries).toHaveLength(1);
        expect(result).toEqual({
            total: 20,
            results: [
                { id: "a", visitors: 5, events: 7 },
                { id: "b", visitors: 2, events: 2 }
            ]
        });
    });

    it("bound retention to identified visitors and a month", async () => {
        await reports.retention({ siteId: SITE, from: 0, to: 400 * 86_400_000, filters: [] });
        const { sql, values } = db.queries[0]!;
        expect(sql).toContain("\"distinctId\" IS NOT NULL");
        const from = values.find((value) => value instanceof Date) as Date;
        expect(400 * 86_400_000 - from.getTime()).toBe(reports.RETENTION_MAX_DAYS * 86_400_000);
    });
});

describe("ignore rules", () => {
    it("match exact paths and prefixes", () => {
        expect(core.visitPathMatches("/admin*", "/admin/users")).toBe(true);
        expect(core.visitPathMatches("/health", "/health")).toBe(true);
        expect(core.visitPathMatches("/health", "/healthz")).toBe(false);
    });

    it("match exact addresses and IPv4 ranges", () => {
        expect(core.visitIpIgnored(["198.51.100.0/24"], "198.51.100.42")).toBe(true);
        expect(core.visitIpIgnored(["198.51.100.0/24"], "198.51.101.1")).toBe(false);
        expect(core.visitIpIgnored(["2001:db8::1"], "2001:DB8::1")).toBe(true);
        expect(core.visitIpIgnored(["0.0.0.0/0"], "203.0.113.9")).toBe(true);
    });

    it("refuse a malformed rule set", () => {
        expect(core.analyticsSiteSettingsSchema.safeParse({ excludedPaths: ["admin"], ignoredIps: [] }).success).toBe(false);
        expect(core.analyticsSiteSettingsSchema.safeParse({ excludedPaths: [], ignoredIps: ["evil host"] }).success).toBe(false);
    });
});
