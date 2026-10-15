/**
 * The statistics behind server insights: bucketing, rolling median + MAD
 * anomalies, and the least-squares disk forecast.
 */

import { describe, expect, it } from "vitest";
import {
    bucketize,
    detectAnomalies,
    forecastDisk,
    median,
    slopePerDay,
    type ValuePoint
} from "../../src/lib/server-insights/stats";
import { forecastWarns, insightFromRows, type RollupRow } from "../../src/lib/server-insights/insights";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

describe("bucketize", () => {
    it("averages each bucket, skips gaps and leaves empty buckets out", () => {
        const points = [
            { t: 0, v: 10 },
            { t: 10 * 60_000, v: 20 },
            { t: 20 * 60_000, v: null },
            { t: 3 * HOUR + 5, v: 4 }
        ];
        expect(bucketize(points, HOUR)).toEqual([
            { t: 0, v: 15 },
            { t: 3 * HOUR, v: 4 }
        ]);
    });

    it("sorts its output and refuses a zero bucket", () => {
        expect(bucketize([{ t: 2 * HOUR, v: 1 }, { t: 0, v: 2 }], HOUR).map((point) => point.t)).toEqual([0, 2 * HOUR]);
        expect(() => bucketize([], 0)).toThrow();
    });

    it("returns nothing for nothing", () => {
        expect(bucketize([{ t: 0, v: null }], HOUR)).toEqual([]);
    });
});

describe("median", () => {
    it("handles odd, even and empty lists", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 2, 3])).toBe(2.5);
        expect(Number.isNaN(median([]))).toBe(true);
    });
});

/** A noisy but steady hourly series around `level`. */
function steady(hours: number, level: number): ValuePoint[] {
    return Array.from({ length: hours }, (_, index) => ({ t: index * HOUR, v: level + ((index * 7) % 5) - 2 }));
}

const OPTIONS = { window: 24, minHistory: 12, threshold: 3.5, minDelta: 15 };

describe("detectAnomalies", () => {
    it("finds nothing in a steady series", () => {
        expect(detectAnomalies(steady(72, 20), OPTIONS)).toEqual([]);
    });

    it("flags a spike against the hours before it, with its baseline and score", () => {
        const points = steady(48, 20);
        points[40] = { t: 40 * HOUR, v: 95 };
        const found = detectAnomalies(points, OPTIONS);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ start: 40 * HOUR, end: 40 * HOUR, direction: "high", peakValue: 95 });
        expect(found[0]!.baseline).toBeGreaterThan(17);
        expect(found[0]!.baseline).toBeLessThan(23);
        expect(found[0]!.score).toBeGreaterThan(3.5);
    });

    it("merges consecutive unusual hours into one episode reported by its worst point", () => {
        const points = steady(48, 20);
        points[30] = { t: 30 * HOUR, v: 70 };
        points[31] = { t: 31 * HOUR, v: 90 };
        points[32] = { t: 32 * HOUR, v: 75 };
        const found = detectAnomalies(points, OPTIONS);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ start: 30 * HOUR, end: 32 * HOUR, peakAt: 31 * HOUR, peakValue: 90 });
    });

    it("flags a drop as low", () => {
        const points = steady(48, 60);
        points[30] = { t: 30 * HOUR, v: 2 };
        expect(detectAnomalies(points, OPTIONS)[0]?.direction).toBe("low");
    });

    it("ignores a move smaller than the floor even on a flat line", () => {
        const flat = Array.from({ length: 30 }, (_, index) => ({ t: index * HOUR, v: 10 }));
        flat[20] = { t: 20 * HOUR, v: 14 };
        expect(detectAnomalies(flat, OPTIONS)).toEqual([]);
        flat[20] = { t: 20 * HOUR, v: 40 };
        expect(detectAnomalies(flat, OPTIONS)).toHaveLength(1);
    });

    it("judges nothing before it has enough history", () => {
        const points = steady(10, 20);
        points[9] = { t: 9 * HOUR, v: 99 };
        expect(detectAnomalies(points, OPTIONS)).toEqual([]);
    });
});

/** Hourly disk readings growing by `perDay` bytes a day. */
function growing(days: number, start: number, perDay: number, total = 100 * GB) {
    return Array.from({ length: days * 24 }, (_, index) => ({
        t: index * HOUR,
        used: start + (perDay * index) / 24,
        total
    }));
}

describe("forecastDisk", () => {
    it("says when there is too little history", () => {
        const result = forecastDisk(growing(1, 10 * GB, GB));
        expect(result.kind).toBe("insufficient");
        expect(forecastDisk([]).kind).toBe("insufficient");
    });

    it("draws a line through steady growth and counts the days left", () => {
        const result = forecastDisk(growing(7, 50 * GB, 2 * GB));
        expect(result.kind).toBe("filling");
        if (result.kind !== "filling") return;
        expect(result.bytesPerDay / GB).toBeCloseTo(2, 5);
        // Last reading is about 50 + 2 * (167/24) GB; the rest at 2 GB a day.
        const used = 50 * GB + (2 * GB * 167) / 24;
        expect(result.days).toBeCloseTo((100 * GB - used) / (2 * GB), 5);
        expect(forecastWarns(result)).toBe(false);
    });

    it("warns when the disk fills inside the threshold", () => {
        const result = forecastDisk(growing(7, 80 * GB, 2 * GB));
        expect(result.kind).toBe("filling");
        expect(forecastWarns(result)).toBe(true);
    });

    it("calls a flat or shrinking disk steady", () => {
        expect(forecastDisk(growing(5, 40 * GB, 0)).kind).toBe("steady");
        expect(forecastDisk(growing(5, 40 * GB, -GB)).kind).toBe("steady");
    });

    it("reports a full disk as full", () => {
        const result = forecastDisk(growing(3, 100 * GB, GB));
        expect(result.kind).toBe("full");
        expect(forecastWarns(result)).toBe(true);
    });

    it("computes an exact least-squares slope", () => {
        expect(slopePerDay([{ t: 0, used: 0 }, { t: DAY, used: 10 }, { t: 2 * DAY, used: 20 }])).toBeCloseTo(10);
        expect(slopePerDay([{ t: 0, used: 5 }])).toBe(0);
    });
});

describe("insightFromRows", () => {
    function row(hour: number, cpu: number): RollupRow {
        return {
            subjectId: "s",
            bucket: new Date(hour * HOUR),
            cpuPercentAvg: cpu,
            memUsedBytesAvg: BigInt(4 * GB),
            memTotalBytesAvg: BigInt(16 * GB),
            diskUsedBytesAvg: BigInt(Math.round(50 * GB + (hour * GB) / 24)),
            diskTotalBytesAvg: BigInt(100 * GB),
            netRxBytesSum: 3600n * 1000n,
            netTxBytesSum: 3600n * 1000n
        };
    }

    it("lists a CPU surge with severity, newest first, and forecasts the disk", () => {
        const rows = Array.from({ length: 96 }, (_, hour) => row(hour, 10 + (hour % 3)));
        rows[90] = row(90, 98);
        rows[60] = row(60, 45);
        const insight = insightFromRows("s", rows, 96 * HOUR);
        expect(insight.anomalies.map((one) => [one.metric, one.start])).toEqual([
            ["cpu", 90 * HOUR],
            ["cpu", 60 * HOUR]
        ]);
        expect(insight.anomalies[0]!.severity).toBe("danger");
        expect(insight.forecast.kind).toBe("filling");
        expect(insight.diskWarning).toBe(false);
    });

    it("drops stretches older than the lookback and handles a server with no rows", () => {
        const rows = Array.from({ length: 96 }, (_, hour) => row(hour, 10 + (hour % 3)));
        rows[20] = row(20, 98);
        expect(insightFromRows("s", rows, 20 * HOUR + 8 * DAY).anomalies).toEqual([]);
        const empty = insightFromRows("s", [], 0);
        expect(empty.anomalies).toEqual([]);
        expect(empty.forecast.kind).toBe("insufficient");
    });
});
