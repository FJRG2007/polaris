/**
 * The update estimate: the median of the last ten updates, a default before
 * there are any, a bar that never claims done, and a run closed by the build
 * that lands it.
 */

import { describe, expect, it } from "vitest";
import {
    DEFAULT_UPDATE_MS,
    MAX_UPDATE_MS,
    UPDATE_HISTORY_SIZE,
    estimateUpdateMs,
    parseUpdateTiming,
    recordUpdateSample,
    settleUpdateTiming,
    updateProgress
} from "@/lib/update-timing";

const MIN = 60_000;

describe("estimateUpdateMs", () => {
    it("falls back to the default with no history", () => {
        expect(estimateUpdateMs([])).toBe(DEFAULT_UPDATE_MS);
    });

    it("is the median, so one slow update barely moves it", () => {
        expect(estimateUpdateMs([2 * MIN, 3 * MIN, 40 * MIN])).toBe(3 * MIN);
        expect(estimateUpdateMs([2 * MIN, 4 * MIN])).toBe(3 * MIN);
    });

    it("ignores durations no update could have taken", () => {
        expect(estimateUpdateMs([1000, -5, MAX_UPDATE_MS + 1, Number.NaN])).toBe(DEFAULT_UPDATE_MS);
    });
});

describe("recordUpdateSample", () => {
    it("keeps only the latest ten", () => {
        let history: number[] = [];
        for (let index = 1; index <= 12; index += 1) history = recordUpdateSample(history, index * MIN);
        expect(history).toHaveLength(UPDATE_HISTORY_SIZE);
        expect(history[0]).toBe(3 * MIN);
        expect(history.at(-1)).toBe(12 * MIN);
    });

    it("drops an impossible duration", () => {
        expect(recordUpdateSample([MIN], 10)).toEqual([MIN]);
    });
});

describe("updateProgress", () => {
    it("is linear within the estimate and says what is left", () => {
        const half = updateProgress(2 * MIN, 4 * MIN);
        expect(half.fraction).toBeCloseTo(0.475);
        expect(half.remainingMs).toBe(2 * MIN);
        expect(half.overdue).toBe(false);
    });

    it("keeps moving past the estimate without reaching the end", () => {
        const late = updateProgress(5 * MIN, 4 * MIN);
        const later = updateProgress(40 * MIN, 4 * MIN);
        expect(late.overdue).toBe(true);
        expect(late.remainingMs).toBe(0);
        expect(later.fraction).toBeGreaterThan(late.fraction);
        expect(later.fraction).toBeLessThan(1);
    });

    it("treats a clock behind the start as zero", () => {
        expect(updateProgress(-5000, 4 * MIN).fraction).toBe(0);
    });
});

describe("settleUpdateTiming", () => {
    const run = { startedAt: 1_000_000, from: "old" };

    it("measures to the moment a different build answers", () => {
        const next = settleUpdateTiming({ run, history: [] }, "new", null, 1_000_000 + 3 * MIN);
        expect(next).toEqual({ run: null, history: [3 * MIN] });
    });

    it("leaves a run that is still going", () => {
        expect(settleUpdateTiming({ run, history: [] }, "old", null, 1_000_000 + MIN)).toBeNull();
    });

    it("drops a failed run unmeasured", () => {
        const outcome = { exitCode: 1, endedAt: 1_000_000 + MIN };
        expect(settleUpdateTiming({ run, history: [MIN] }, "old", outcome, 1_000_000 + MIN)).toEqual({
            run: null,
            history: [MIN]
        });
    });

    it("does not take the last run's leftover result for this one", () => {
        const outcome = { exitCode: 1, endedAt: 1_000_000 - 1 };
        expect(settleUpdateTiming({ run, history: [] }, "old", outcome, 1_000_000 + MIN)).toBeNull();
    });

    it("uses the updater's exit where the build is unknown", () => {
        const outcome = { exitCode: 0, endedAt: 1_000_000 + 2 * MIN };
        const next = settleUpdateTiming({ run: { ...run, from: null }, history: [] }, null, outcome, 1_000_000 + 3 * MIN);
        expect(next).toEqual({ run: null, history: [2 * MIN] });
    });

    it("gives up on a run older than any update", () => {
        expect(settleUpdateTiming({ run, history: [] }, "old", null, 1_000_000 + MAX_UPDATE_MS + 1)).toEqual({
            run: null,
            history: []
        });
    });
});

describe("parseUpdateTiming", () => {
    it("reads anything unreadable as an empty history", () => {
        expect(parseUpdateTiming(null)).toEqual({ run: null, history: [] });
        expect(parseUpdateTiming("{not json")).toEqual({ run: null, history: [] });
        expect(parseUpdateTiming(JSON.stringify({ run: "x", history: [MIN] }))).toEqual({ run: null, history: [MIN] });
    });
});
