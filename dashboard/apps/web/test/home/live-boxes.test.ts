/**
 * The rules the live positions are held under.
 *
 * All three failures this pins look identical on a screen - a rectangle sitting
 * over a place where there is nobody - and none of them can be found by looking
 * at the code, because each depends on a clock. A worker running fast, a camera
 * that went quiet, an id nothing will ever ask about again.
 */

import { LIVE_TTL_MS, type LiveBox } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveBoxes, publishLiveBoxes, forgetLiveBoxes } from "@/lib/home/live-boxes";

const CAMERA = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

const SOMEBODY: LiveBox[] = [
    { id: "t1", label: "person", score: 88, box: { x1: 0.2, y1: 0.3, x2: 0.4, y2: 0.9 } }
];

afterEach(() => {
    vi.useRealTimers();
    forgetLiveBoxes(CAMERA);
});

describe("what a camera is looking at", () => {
    it("comes back as it was published", () => {
        publishLiveBoxes(CAMERA, SOMEBODY);
        expect(liveBoxes(CAMERA)).toEqual(SOMEBODY);
    });

    it("says nothing about a camera nothing has published for", () => {
        expect(liveBoxes("019f0000-0000-7000-8000-000000000009")).toEqual([]);
    });

    it("goes quiet on its own when the worker stops publishing", () => {
        vi.useFakeTimers();
        publishLiveBoxes(CAMERA, SOMEBODY);
        vi.advanceTimersByTime(LIVE_TTL_MS + 1);
        // The camera did not say the person left - it stopped saying anything,
        // which is what a burst ending or a worker dying both look like. Either
        // way the box has to go.
        expect(liveBoxes(CAMERA)).toEqual([]);
    });

    it("is replaced by the next frame rather than added to", () => {
        publishLiveBoxes(CAMERA, SOMEBODY);
        publishLiveBoxes(CAMERA, []);
        // The end of a burst publishes nothing, and it has to mean nothing is
        // there - not "keep showing the last thing you were told".
        expect(liveBoxes(CAMERA)).toEqual([]);
    });

    it("is timed by this machine's clock, not the worker's", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-21T10:00:00.000Z"));
        publishLiveBoxes(CAMERA, SOMEBODY);
        // A worker a minute fast would have stamped this a minute ahead, and
        // every box it ever sent would either expire before it was drawn or sit
        // on screen long after the person had gone.
        vi.advanceTimersByTime(LIVE_TTL_MS - 100);
        expect(liveBoxes(CAMERA)).toHaveLength(1);
    });

    it("forgets a camera on request, without waiting for it to expire", () => {
        publishLiveBoxes(CAMERA, SOMEBODY);
        forgetLiveBoxes(CAMERA);
        expect(liveBoxes(CAMERA)).toEqual([]);
    });
});
