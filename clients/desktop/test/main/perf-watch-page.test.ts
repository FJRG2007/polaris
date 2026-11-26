/**
 * The page's side of the performance log: only a slow input is reported, only
 * its event name and numbers leave, and where the timeline is missing nothing
 * runs at all.
 */

import { describe, expect, it, vi } from "vitest";
import { eventReport, watchPagePerformance } from "@/preload/perf-watch";

describe("an input's report", () => {
    it("is nothing when the input was quick", () => {
        expect(eventReport({ name: "click", duration: 120, startTime: 0, processingStart: 5, processingEnd: 6 }, 500)).toBeNull();
    });

    it("says where a slow input's time went", () => {
        expect(eventReport({ name: "pointerdown", duration: 18_000, startTime: 100, processingStart: 160, processingEnd: 170 }, 500)).toEqual({
            kind: "event",
            duration: 18_000,
            name: "pointerdown",
            delay: 60,
            processing: 10
        });
    });

    it("drops a name that is not an event's and timings that were never taken", () => {
        expect(eventReport({ name: "Some Name", duration: 900, startTime: 0 }, 500)).toEqual({ kind: "event", duration: 900 });
    });
});

describe("watching", () => {
    it("observes nothing where long tasks and input timings are not supported", () => {
        const report = vi.fn();
        // Node's timeline has neither, as an older engine would not.
        expect(() => watchPagePerformance(report)).not.toThrow();
        expect(report).not.toHaveBeenCalled();
    });
});
