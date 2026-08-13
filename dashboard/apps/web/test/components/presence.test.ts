/**
 * Who counts as being here.
 *
 * The directory called an account absent while its owner was demonstrably using
 * Polaris, so the window is deliberately wider than the interval a session records
 * activity at: a stamp written at most once a minute must not read as "gone"
 * between two writes.
 */

import { describe, expect, it } from "vitest";
import { isOnline, ONLINE_WINDOW_MS } from "../../src/components/presence";

const NOW = Date.parse("2026-08-14T00:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("presence", () => {
    it("counts activity from a moment ago", () => {
        expect(isOnline(ago(5_000), NOW)).toBe(true);
    });

    it("survives the gap between two activity writes", () => {
        // The session guard writes at most once a minute; a window of one would
        // blink off for someone who never left.
        expect(isOnline(ago(90_000), NOW)).toBe(true);
    });

    it("lets someone go once the window passes", () => {
        expect(isOnline(ago(ONLINE_WINDOW_MS + 1_000), NOW)).toBe(false);
    });

    it("treats an account that was never seen as absent", () => {
        expect(isOnline(null, NOW)).toBe(false);
        expect(isOnline(undefined, NOW)).toBe(false);
    });

    it("treats an unreadable timestamp as absent rather than as present", () => {
        expect(isOnline("not a date", NOW)).toBe(false);
    });

    it("does not call a clock-skewed future timestamp absent", () => {
        expect(isOnline(new Date(NOW + 30_000).toISOString(), NOW)).toBe(true);
    });
});
