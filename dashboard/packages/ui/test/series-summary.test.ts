import { describe, expect, it } from "vitest";
import { summarizeSeries } from "../src/lib/series-summary.js";

describe("what a chart header reports", () => {
    it("headlines the latest reading by default, with the window's mean and peak beside it", () => {
        const { headline, stats } = summarizeSeries([10, 90, 20]);
        expect(headline).toBe(20);
        expect(stats).toEqual([
            { label: "avg", value: 40 },
            { label: "peak", value: 90 }
        ]);
    });

    it("does not print the average twice when the headline already is the average", () => {
        const { headline, stats } = summarizeSeries([10, 90, 20], "avg");
        expect(headline).toBe(40);
        expect(stats.map((stat) => stat.label)).toEqual(["peak"]);
    });

    it("does not print the peak twice when the headline already is the peak", () => {
        const { headline, stats } = summarizeSeries([10, 90, 20], "max");
        expect(headline).toBe(90);
        expect(stats.map((stat) => stat.label)).toEqual(["avg"]);
    });

    it("totals a count but still averages it, so a request chart says both", () => {
        const { headline, stats } = summarizeSeries([10, 90, 20], "sum");
        expect(headline).toBe(120);
        expect(stats).toEqual([
            { label: "avg", value: 40 },
            { label: "peak", value: 90 }
        ]);
    });

    it("reports nothing rather than zero for a window with no readings", () => {
        expect(summarizeSeries([])).toEqual({ headline: null, stats: [] });
    });

    it("summarizes a single reading without dividing by zero", () => {
        const { headline, stats } = summarizeSeries([7]);
        expect(headline).toBe(7);
        expect(stats).toEqual([
            { label: "avg", value: 7 },
            { label: "peak", value: 7 }
        ]);
    });

    it("averages the readings it was given, so a gap cannot drag the mean down", () => {
        // The chart passes only the present values; a dropped sample is absent,
        // never a zero.
        expect(summarizeSeries([50, 50]).stats[0]).toEqual({ label: "avg", value: 50 });
    });
});
