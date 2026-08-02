import { describe, expect, it } from "vitest";
import { summarizeWafTraffic, type WafTrafficEntry } from "../src/waf-analytics.js";

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
