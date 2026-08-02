import { describe, expect, it } from "vitest";
import { summarizeWafAddress, summarizeWafTraffic, type WafTrafficEntry } from "../src/waf-analytics.js";

const TO = Date.parse("2026-08-02T12:00:00.000Z");
const FROM = TO - 3600 * 1000;

function entry(overrides: Partial<WafTrafficEntry> = {}): WafTrafficEntry {
    return {
        time: new Date(TO - 60_000).toISOString(),
        ip: "203.0.113.5",
        path: "/",
        status: 200,
        userAgent: "Mozilla/5.0",
        ...overrides
    };
}

describe("summarizeWafTraffic", () => {
    it("reports nothing for an empty window", () => {
        const summary = summarizeWafTraffic([], FROM, TO);
        expect(summary).toMatchObject({ total: 0, blocked: 0, blockedRate: null });
        expect(summary.topAddresses).toEqual([]);
    });

    it("refuses an inverted or unusable window rather than guessing", () => {
        expect(summarizeWafTraffic([entry()], TO, FROM).series).toEqual([]);
        expect(summarizeWafTraffic([entry()], Number.NaN, TO).total).toBe(0);
    });

    it("counts a 403 as blocked and everything else as allowed", () => {
        const summary = summarizeWafTraffic([entry(), entry({ status: 403 }), entry({ status: 404 })], FROM, TO);
        expect(summary.total).toBe(3);
        expect(summary.blocked).toBe(1);
        expect(summary.blockedRate).toBeCloseTo(33.33, 1);
    });

    it("ignores traffic outside the window", () => {
        const old = entry({ time: new Date(FROM - 60_000).toISOString() });
        expect(summarizeWafTraffic([old], FROM, TO).total).toBe(0);
    });

    it("ignores an entry whose time does not parse", () => {
        expect(summarizeWafTraffic([entry({ time: null }), entry({ time: "nope" })], FROM, TO).total).toBe(0);
    });

    it("places entries on the series and keeps the totals in step with it", () => {
        const summary = summarizeWafTraffic([entry(), entry({ status: 403 })], FROM, TO, 4);
        expect(summary.series).toHaveLength(4);
        const allowed = summary.series.reduce((sum, point) => sum + point.allowed, 0);
        const blocked = summary.series.reduce((sum, point) => sum + point.blocked, 0);
        expect(allowed + blocked).toBe(summary.total);
        expect(blocked).toBe(summary.blocked);
    });

    it("breaks down only what was blocked", () => {
        const summary = summarizeWafTraffic(
            [
                entry({ path: "/pricing" }),
                entry({ status: 403, ip: "198.51.100.9", path: "/wp-login.php", userAgent: "sqlmap/1.7" }),
                entry({ status: 403, ip: "198.51.100.9", path: "/wp-login.php", userAgent: "sqlmap/1.7" }),
                entry({ status: 403, ip: "198.51.100.10", path: "/.env", userAgent: "curl/8" })
            ],
            FROM,
            TO
        );
        expect(summary.topAddresses).toEqual([
            { value: "198.51.100.9", count: 2 },
            { value: "198.51.100.10", count: 1 }
        ]);
        expect(summary.topPaths.map((row) => row.value)).toEqual(["/wp-login.php", "/.env"]);
        expect(summary.topAgents[0]).toEqual({ value: "sqlmap/1.7", count: 2 });
        // The allowed request contributed to the totals but to none of the lists.
        expect(summary.topPaths.some((row) => row.value === "/pricing")).toBe(false);
    });

    it("skips placeholder addresses and agents in the breakdowns", () => {
        const summary = summarizeWafTraffic(
            [entry({ status: 403, ip: "-", userAgent: null })],
            FROM,
            TO
        );
        expect(summary.blocked).toBe(1);
        expect(summary.topAddresses).toEqual([]);
        expect(summary.topAgents).toEqual([]);
    });

    it("caps each breakdown so one busy hour cannot render a thousand rows", () => {
        const many = Array.from({ length: 40 }, (_, index) =>
            entry({ status: 403, ip: `198.51.100.${index}` })
        );
        expect(summarizeWafTraffic(many, FROM, TO).topAddresses.length).toBeLessThanOrEqual(8);
    });
});

describe("summarizeWafAddress", () => {
    const SWEEP: WafTrafficEntry[] = [
        entry({ ip: "198.51.100.9", path: "/wp-login.php", status: 404, method: "GET", userAgent: "sqlmap/1.7" }),
        entry({
            ip: "198.51.100.9",
            path: "/wp-login.php",
            status: 404,
            method: "POST",
            userAgent: "sqlmap/1.7",
            time: new Date(TO - 30_000).toISOString()
        }),
        entry({
            ip: "198.51.100.9",
            path: "/.env",
            status: 403,
            method: "GET",
            userAgent: "sqlmap/1.7",
            time: new Date(TO - 10_000).toISOString()
        }),
        entry({ ip: "203.0.113.5", path: "/pricing", status: 200 })
    ];

    it("reports only the address that was asked about", () => {
        const activity = summarizeWafAddress(SWEEP, "198.51.100.9", FROM, TO);
        expect(activity.total).toBe(3);
        expect(activity.blocked).toBe(1);
        expect(activity.requests.every((request) => request.path !== "/pricing")).toBe(true);
    });

    it("lists the requests most recent first, with the method and status intact", () => {
        const activity = summarizeWafAddress(SWEEP, "198.51.100.9", FROM, TO);
        expect(activity.requests.map((request) => request.path)).toEqual([
            "/.env",
            "/wp-login.php",
            "/wp-login.php"
        ]);
        expect(activity.requests[1]).toMatchObject({ method: "POST", status: 404 });
    });

    it("brackets the visit with a first and a last time", () => {
        const activity = summarizeWafAddress(SWEEP, "198.51.100.9", FROM, TO);
        expect(activity.firstSeen).toBe(TO - 60_000);
        expect(activity.lastSeen).toBe(TO - 10_000);
    });

    it("counts the codes it collected and what it called itself", () => {
        const activity = summarizeWafAddress(SWEEP, "198.51.100.9", FROM, TO);
        expect(activity.statuses).toEqual([
            { value: "404", count: 2 },
            { value: "403", count: 1 }
        ]);
        expect(activity.agents).toEqual([{ value: "sqlmap/1.7", count: 3 }]);
        expect(activity.topPaths[0]).toEqual({ value: "/wp-login.php", count: 2 });
    });

    it("says nothing at all for an address with no traffic in the window", () => {
        const activity = summarizeWafAddress(SWEEP, "192.0.2.1", FROM, TO);
        expect(activity).toMatchObject({ total: 0, blocked: 0, firstSeen: null, lastSeen: null, truncated: false });
        expect(activity.requests).toEqual([]);
    });

    it("ignores traffic from outside the window", () => {
        const old = entry({ ip: "198.51.100.9", time: new Date(FROM - 1000).toISOString() });
        expect(summarizeWafAddress([old], "198.51.100.9", FROM, TO).total).toBe(0);
    });

    it("keeps the totals exact when the list is cut short", () => {
        // A truncated list that also truncated the numbers would understate exactly
        // the addresses worth looking at.
        const many = Array.from({ length: 50 }, (_, index) =>
            entry({ ip: "198.51.100.9", status: 404, time: new Date(TO - (index + 1) * 1000).toISOString() })
        );
        const activity = summarizeWafAddress(many, "198.51.100.9", FROM, TO, 10);
        expect(activity.total).toBe(50);
        expect(activity.requests).toHaveLength(10);
        expect(activity.truncated).toBe(true);
        expect(activity.requests[0]!.at).toBe(TO - 1000);
    });
});
