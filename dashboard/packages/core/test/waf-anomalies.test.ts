import { describe, expect, it } from "vitest";
import { detectWafAnomalies, routeOf, type WafTrafficLike } from "../src/waf-anomalies.js";

const TO = Date.parse("2026-08-02T22:00:00.000Z");
const FROM = TO - 5 * 60 * 1000;

function hits(
    ip: string,
    path: string,
    count: number,
    { status = 200, method = "GET" }: { status?: number; method?: string } = {}
): WafTrafficLike[] {
    return Array.from({ length: count }, (_, index) => ({
        ip,
        path,
        status,
        method,
        time: new Date(TO - 60_000 - index * 100).toISOString()
    }));
}

/** Ordinary traffic from several addresses, so a route has a baseline to be judged
 *  against - without one nothing can be called unusual. */
function crowd(path: string, perIp = 5, addresses = 6): WafTrafficLike[] {
    return Array.from({ length: addresses }, (_, index) => hits(`203.0.113.${index}`, path, perIp)).flat();
}

const kinds = (entries: WafTrafficLike[]) =>
    detectWafAnomalies(entries, FROM, TO).map((anomaly) => `${anomaly.kind}:${anomaly.ip}`);

describe("routeOf", () => {
    it("drops the query and a trailing slash", () => {
        expect(routeOf("/pricing/?ref=x")).toBe("/pricing");
        expect(routeOf("/pricing/")).toBe("/pricing");
        expect(routeOf("/")).toBe("/");
        expect(routeOf(null)).toBe("/");
    });
});

describe("detectWafAnomalies", () => {
    it("finds nothing in ordinary traffic", () => {
        expect(detectWafAnomalies(crowd("/pricing"), FROM, TO)).toEqual([]);
    });

    it("refuses an unusable window", () => {
        expect(detectWafAnomalies(crowd("/pricing"), TO, FROM)).toEqual([]);
        expect(detectWafAnomalies(crowd("/pricing"), Number.NaN, TO)).toEqual([]);
    });

    it("ignores traffic outside the window", () => {
        const old = hits("198.51.100.9", "/pricing", 400).map((entry) => ({
            ...entry,
            time: new Date(FROM - 60_000).toISOString()
        }));
        expect(detectWafAnomalies([...crowd("/pricing"), ...old], FROM, TO)).toEqual([]);
    });

    it("flags an address far above what the route's other visitors do", () => {
        const entries = [...crowd("/pricing"), ...hits("198.51.100.9", "/pricing", 200)];
        const found = detectWafAnomalies(entries, FROM, TO);
        const flood = found.find((anomaly) => anomaly.kind === "route-flood");
        expect(flood).toMatchObject({ ip: "198.51.100.9", route: "/pricing", severity: "high" });
        expect(flood?.baseline).toBe(5);
        expect(flood?.detail).toContain("200 requests");
    });

    it("does not call a busy route abusive when everyone is busy", () => {
        // Every address makes 200 requests: high traffic, no outlier.
        expect(detectWafAnomalies(crowd("/api/poll", 200, 6), FROM, TO)).toEqual([]);
    });

    it("does not judge an address with no one to compare it against", () => {
        expect(kinds(hits("198.51.100.9", "/only-visitor", 200))).not.toContain("route-flood:198.51.100.9");
    });

    it("flags a static file fetched far more often than a browser would", () => {
        const entries = [...crowd("/assets/app.js"), ...hits("198.51.100.9", "/assets/app.js", 300)];
        const asset = detectWafAnomalies(entries, FROM, TO).find((a) => a.kind === "asset-abuse");
        expect(asset).toMatchObject({ ip: "198.51.100.9", severity: "high" });
        expect(asset?.detail).toContain("caches it");
    });

    it("flags cache busting by the number of distinct query strings", () => {
        const entries = Array.from({ length: 80 }, (_, index) => hits("198.51.100.9", `/assets/app.js?v=${index}`, 1)).flat();
        const found = kinds(entries);
        expect(found).toContain("cache-buster:198.51.100.9");
    });

    it("flags a sweep under a route that really exists", () => {
        const entries = Array.from({ length: 40 }, (_, index) =>
            hits("198.51.100.9", `/api/users/${index}`, 1, { status: 404 })
        ).flat();
        // Every one is a different path, so they land on different routes; the sweep
        // is caught on the shared prefix only when the path repeats.
        const sameRoute = hits("198.51.100.9", "/api/users", 40, { status: 404 });
        const found = detectWafAnomalies([...entries, ...sameRoute], FROM, TO);
        expect(found.some((a) => a.kind === "path-enumeration" && a.ip === "198.51.100.9")).toBe(true);
    });

    it("flags an injection payload on the first request that carries one", () => {
        const found = detectWafAnomalies(hits("198.51.100.9", "/search?q=1' OR '1'='1", 1), FROM, TO);
        expect(found[0]).toMatchObject({ kind: "query-payload", severity: "high" });
        expect(found[0]?.detail).toContain("or '");
    });

    it("sees through percent-encoding", () => {
        const found = detectWafAnomalies(hits("198.51.100.9", "/search?q=%3Cscript%3E", 1), FROM, TO);
        expect(found[0]?.kind).toBe("query-payload");
    });

    it("flags an absurd query as worth seeing but not acting on", () => {
        const found = detectWafAnomalies(hits("198.51.100.9", `/search?q=${"a".repeat(2000)}`, 1), FROM, TO);
        expect(found[0]).toMatchObject({ kind: "query-payload", severity: "low" });
    });

    it("flags writing to a static file", () => {
        const found = kinds(hits("198.51.100.9", "/assets/app.js", 1, { method: "POST" }));
        expect(found).toContain("method-mismatch:198.51.100.9");
    });

    it("leaves an ordinary POST to a real route alone", () => {
        expect(kinds(hits("198.51.100.9", "/api/checkout", 1, { method: "POST" }))).toEqual([]);
    });

    it("puts the ones worth acting on first", () => {
        const entries = [
            ...hits("198.51.100.1", "/assets/app.js", 1, { method: "POST" }),
            ...crowd("/pricing"),
            ...hits("198.51.100.9", "/pricing", 200)
        ];
        const found = detectWafAnomalies(entries, FROM, TO);
        expect(found[0]?.severity).toBe("high");
        expect(found.at(-1)?.severity).toBe("low");
    });

    it("honours the thresholds it is given", () => {
        const entries = [...crowd("/pricing"), ...hits("198.51.100.9", "/pricing", 60)];
        expect(detectWafAnomalies(entries, FROM, TO, { overBaseline: 100 })).toEqual([]);
        expect(
            detectWafAnomalies(entries, FROM, TO, { overBaseline: 2 }).some((a) => a.kind === "route-flood")
        ).toBe(true);
    });

    it("skips entries with no usable address", () => {
        expect(detectWafAnomalies(hits("-", "/pricing", 500), FROM, TO)).toEqual([]);
    });
});
