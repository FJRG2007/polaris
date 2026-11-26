/**
 * The page's side of the performance log: only a slow input or long task is
 * reported, only its event name and numbers leave, the observer runs in the
 * page's own world and reports through the one global the preload exposes, and
 * a page without a timeline, or a world that refuses the script, breaks nothing.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { eventReport, observerSource, pageEntry, PERFORMANCE_GLOBAL, watchPagePerformance, type MainWorld } from "@/preload/perf-watch";

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

describe("an entry from the page's world", () => {
    it("reads a long task over the threshold", () => {
        expect(pageEntry({ type: "longtask", name: "self", duration: 700, startTime: 1 }, 500)).toEqual({ kind: "longtask", duration: 700 });
        expect(pageEntry({ type: "longtask", duration: 120, startTime: 1 }, 500)).toBeNull();
    });

    it.each([null, "x", { type: "paint", duration: 900, startTime: 0 }, { type: "event", duration: "900", startTime: 0 }, { type: "longtask", duration: Number.NaN, startTime: 0 }])(
        "refuses %j",
        (raw) => expect(pageEntry(raw, 500)).toBeNull()
    );
});

/** A page's world as the observer sees it: a timeline that hands over the given entries. */
function pageWorld(supported: string[], entries: Record<string, object[]>) {
    const reported: unknown[] = [];
    const observed: unknown[] = [];
    class PerformanceObserver {
        static supportedEntryTypes = supported;
        constructor(private readonly callback: (list: { getEntries(): object[]; }) => void) {}
        observe(options: { type: string; }) {
            observed.push(options);
            this.callback({ getEntries: () => entries[options.type] ?? [] });
        }
    }
    const window: Record<string, unknown> = {};
    const world: MainWorld = {
        expose: (name, api) => void (window[name] = { report: (raw: unknown) => (reported.push(raw), api.report(raw)) }),
        run: async (source) => runInNewContext(source, { window, PerformanceObserver })
    };
    return { world, reported, observed };
}

describe("watching", () => {
    it("observes in the page's world and reports what is slow", async () => {
        const { world, observed } = pageWorld(["longtask", "event"], {
            longtask: [{ name: "self", duration: 800, startTime: 5 }],
            event: [
                { name: "click", duration: 20_000, startTime: 10, processingStart: 30, processingEnd: 35 },
                { name: "keydown", duration: 40, startTime: 10, processingStart: 11, processingEnd: 12 }
            ]
        });
        const report = vi.fn();
        watchPagePerformance(report, world);
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
        expect(observed).toEqual([{ type: "longtask" }, { type: "event", durationThreshold: 500 }]);
        expect(report.mock.calls.map(([found]) => found)).toEqual([
            { kind: "longtask", duration: 800 },
            { kind: "event", duration: 20_000, name: "click", delay: 20, processing: 5 }
        ]);
    });

    it("observes nothing a page's timeline does not support", async () => {
        const { world, observed } = pageWorld([], {});
        watchPagePerformance(vi.fn(), world);
        await Promise.resolve();
        expect(observed).toEqual([]);
    });

    it("breaks nothing when the script is refused or the global cannot be exposed", () => {
        expect(() => watchPagePerformance(vi.fn(), { expose: vi.fn(), run: () => Promise.reject(new Error("refused")) })).not.toThrow();
        expect(() =>
            watchPagePerformance(vi.fn(), {
                expose: () => {
                    throw new Error("no");
                },
                run: vi.fn()
            })
        ).not.toThrow();
    });

    it("is a script that names only the exposed global", () => {
        expect(observerSource(500)).toContain(JSON.stringify(PERFORMANCE_GLOBAL));
        expect(() => runInNewContext(observerSource(500), { window: {} })).not.toThrow();
    });
});
