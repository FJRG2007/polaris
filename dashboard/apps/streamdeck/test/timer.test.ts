/**
 * The timer kept in the plugin: started, paused, reset, set by a dial, read
 * back from what was stored, and shown.
 */

import * as timers from "../src/timer";
import { describe, expect, it } from "vitest";

const MINUTE = 60_000;

describe("timer", () => {
    it("counts down while running and holds while paused", () => {
        let timer = timers.newTimer("countdown", 5 * MINUTE);
        expect(timers.display(timer, 0)).toBe("5:00");
        timer = timers.toggle(timer, 0);
        expect(timers.display(timer, 61_000)).toBe("3:59");
        timer = timers.toggle(timer, 61_000);
        expect(timers.display(timer, 600_000)).toBe("3:59");
        expect(timers.running(timer)).toBe(false);
    });

    it("finishes at zero, and a press then starts it over", () => {
        let timer = timers.toggle(timers.newTimer("countdown", MINUTE), 0);
        expect(timers.finished(timer, 59_999)).toBe(false);
        expect(timers.display(timer, 59_001)).toBe("0:01");
        expect(timers.finished(timer, 60_000)).toBe(true);
        expect(timers.display(timer, 90_000)).toBe("0:00");
        timer = timers.toggle(timer, 90_000);
        expect(timers.display(timer, 90_000)).toBe("1:00");
        expect(timers.running(timer)).toBe(true);
    });

    it("counts up as a stopwatch, past an hour, and never finishes", () => {
        const timer = timers.toggle(timers.newTimer("stopwatch"), 0);
        expect(timers.display(timer, 3_725_000)).toBe("1:02:05");
        expect(timers.finished(timer, 10 ** 9)).toBe(false);
    });

    it("resets to the start", () => {
        const timer = timers.reset(timers.toggle(timers.newTimer("countdown", MINUTE), 0));
        expect(timers.display(timer, 30_000)).toBe("1:00");
    });

    it("is set by a dial a minute a tick, only while stopped, within a day", () => {
        let timer = timers.newTimer("countdown", 5 * MINUTE);
        timer = timers.adjust(timer, 3);
        expect(timer.durationMs).toBe(8 * MINUTE);
        expect(timers.adjust(timer, -100).durationMs).toBe(MINUTE);
        expect(timers.adjust(timer, 10_000).durationMs).toBe(timers.TIMER_LIMITS.maxMs);
        const started = timers.toggle(timer, 0);
        expect(timers.adjust(started, 5)).toBe(started);
    });

    it("reads back what was stored, and starts over on anything else or a new mode", () => {
        const stored = timers.toggle(timers.newTimer("countdown", 2 * MINUTE), 1000);
        expect(timers.readTimer(stored, "countdown")).toEqual(stored);
        expect(timers.readTimer({ mode: "nonsense" }, "countdown")).toEqual(
            timers.newTimer("countdown")
        );
        expect(timers.readTimer(stored, "stopwatch").mode).toBe("stopwatch");
        expect(timers.readTimer(null, "countdown", 10 * MINUTE).durationMs).toBe(10 * MINUTE);
    });
});
