/**
 * The percentile maths, the reading of what the SDKs send, and the rule for
 * "slower than it should be" - all pure, so asserted without a database.
 */

import { describe, expect, it } from "vitest";
import * as perf from "@/lib/telemetry/performance";
import { browserInp, browserPageload, nodeRequest } from "./fixtures";

function histogramOfAll(values: readonly number[]): number[] {
    return values.reduce<number[]>((hist, value) => perf.mergeHistograms(hist, perf.histogramOf(value)), []);
}

describe("histograms and percentiles", () => {
    it("reads percentiles back within the bucket error", () => {
        const values = Array.from({ length: 1000 }, (_, index) => index + 1);
        const hist = histogramOfAll(values);
        for (const [q, exact] of [
            [0.5, 500],
            [0.75, 750],
            [0.95, 950]
        ] as const) {
            const read = perf.percentile(hist, q) ?? 0;
            expect(Math.abs(read - exact) / exact).toBeLessThan(0.13);
        }
    });

    it("answers null for nothing and handles values below a millisecond and past the top", () => {
        expect(perf.percentile([], 0.75)).toBeNull();
        expect(perf.percentile(perf.histogramOf(0.2), 0.5)).toBe(1);
        expect(perf.bucketOf(1e12)).toBe(perf.HISTOGRAM.size - 1);
        expect(perf.bucketOf(Number.NaN)).toBe(0);
    });

    it("adds two histograms element by element, so an hour folds into its day", () => {
        const a = histogramOfAll([10, 20, 3000]);
        const b = histogramOfAll([10, 5000]);
        const merged = perf.mergeHistograms(a, b);
        expect(merged).toHaveLength(perf.HISTOGRAM.size);
        expect(merged.reduce((sum, count) => sum + count, 0)).toBe(5);
        expect(merged[perf.bucketOf(10)]).toBe(2);
    });
});

describe("reading the SDKs", () => {
    it("reads a browser page load with its vitals and spans", () => {
        const reading = perf.readTransaction(browserPageload);
        expect(reading).not.toBeNull();
        expect(reading?.name).toBe("/checkout/:step");
        expect(reading?.op).toBe("pageload");
        expect(reading?.durationMs).toBeCloseTo(3400, 0);
        expect(reading?.values.lcp).toBeCloseTo(3120.5, 1);
        expect(reading?.values.cls).toBeCloseTo(120, 5);
        expect(reading?.spans.map((span) => span.op)).toEqual(["browser.request", "resource.script"]);
        expect(reading?.spans[1]?.offsetMs).toBeCloseTo(100, 0);
    });

    it("reads a node request and skips a malformed span", () => {
        const reading = perf.readTransaction(nodeRequest);
        expect(reading?.op).toBe("http.server");
        expect(reading?.name).toBe("GET /api/orders/:id");
        expect(reading?.spans).toHaveLength(1);
        expect(reading?.spans[0]?.durationMs).toBeCloseTo(800, 0);
    });

    it("refuses what is not a transaction", () => {
        expect(perf.readTransaction({ type: "event", message: "x" })).toBeNull();
        expect(perf.readTransaction({ ...nodeRequest, timestamp: nodeRequest.start_timestamp - 1 })).toBeNull();
        expect(perf.readTransaction(null)).toBeNull();
    });

    it("reads the standalone INP span against its route", () => {
        expect(perf.readInpSpan(browserInp)).toMatchObject({ name: "/checkout/:step", value: 350 });
        expect(perf.readInpSpan({ ...browserInp, data: {} })).toBeNull();
    });

    it("groups raw URLs by replacing their ids, and keeps a parameterized name", () => {
        expect(perf.routeName("/orders/1234/items/550e8400-e29b-41d4-a716-446655440000?x=1", "url")).toBe(
            "/orders/*/items/*"
        );
        expect(perf.routeName("GET /users/42", undefined)).toBe("GET /users/*");
        expect(perf.routeName("/users/:id", "route")).toBe("/users/:id");
    });
});

describe("slower than it should be", () => {
    const base = { count: 100, p75: 900, baselineP75: 850, baselineCount: 500, target: 2500 };

    it("defaults to the Web Vitals good thresholds", () => {
        expect(perf.defaultTarget("pageload", "lcp")).toBe(2500);
        expect(perf.defaultTarget("http.server", "duration")).toBe(800);
        expect(perf.defaultTarget("pageload", "inp")).toBe(200);
        expect(
            perf.effectiveTarget({ op: "pageload", metric: "lcp", routeTarget: null, projectTarget: 1000 })
        ).toBe(1000);
        expect(
            perf.effectiveTarget({ op: "pageload", metric: "lcp", routeTarget: 700, projectTarget: 1000 })
        ).toBe(700);
    });

    it("flags a route over its target", () => {
        expect(perf.slowReason({ ...base, p75: 3000 })).toBe("target");
    });

    it("flags a route much slower than its own history", () => {
        expect(perf.slowReason({ ...base, p75: 1400 })).toBe("regression");
        // Half again, but only 3 ms: not news.
        expect(perf.slowReason({ ...base, p75: 9, baselineP75: 6 })).toBeNull();
        // Without enough history there is no baseline to regress against.
        expect(perf.slowReason({ ...base, p75: 1400, baselineCount: 10 })).toBeNull();
    });

    it("says nothing from too few samples", () => {
        expect(perf.slowReason({ ...base, count: 5, p75: 9000 })).toBeNull();
    });

    it("flags a page whose clicks answer slowly", () => {
        expect(perf.slowReason({ ...base, inpP75: 320, inpCount: 40 })).toBe("inp");
        expect(perf.slowReason({ ...base, inpP75: 150, inpCount: 40 })).toBeNull();
    });
});
