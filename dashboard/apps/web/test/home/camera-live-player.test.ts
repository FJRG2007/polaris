/**
 * Keeping a live picture live.
 *
 * The player appends fragments as they arrive and moves the playhead to the
 * newest one when it falls behind. Both rules are what separate "opens on the
 * first keyframe and stays a quarter of a second behind" from "opens after the
 * browser has buffered several seconds and stays that far behind", which is the
 * delay this player exists to remove - so they are pinned here rather than left
 * to be found by leaving a tab in the background.
 */

import { describe, expect, it } from "vitest";
import {
    EDGE_S,
    KEEP_BEHIND_S,
    MAX_LAG_S,
    RECONNECT_MAX_MS,
    RECONNECT_MIN_MS,
    keepLive,
    mediaSourceType,
    reconnectDelay
} from "@polaris-app/places/src/lib/live-player";

describe("the live edge", () => {
    it("does nothing before anything is buffered", () => {
        expect(keepLive(null, null, 0)).toEqual({ seekTo: null, trimTo: null });
    });

    it("leaves a playhead that is keeping up where it is", () => {
        const plan = keepLive(0, { start: 0, end: 3 }, 3 - MAX_LAG_S + 0.1);
        expect(plan.seekTo).toBeNull();
    });

    it("moves a playhead that has fallen behind up to just short of the newest frame", () => {
        const plan = keepLive(0, { start: 0, end: 6 }, 2);
        expect(plan.seekTo).toBeCloseTo(6 - EDGE_S);
    });

    it("starts at the first frame the relay sent, wherever its clock begins", () => {
        // The relay's timestamps need not start at zero, and a playhead at zero
        // in front of a buffer that starts at 41 seconds waits forever.
        const plan = keepLive(41, { start: 41, end: 41.07 }, 0);
        expect(plan.seekTo).toBe(41);
    });

    it("jumps a gap rather than waiting in it", () => {
        const plan = keepLive(0, { start: 10, end: 10.5 }, 9.8);
        expect(plan.seekTo).toBe(Math.max(10, 10.5 - EDGE_S));
    });

    it("drops what is far behind, in steps rather than on every fragment", () => {
        const near = keepLive(0, { start: 0, end: KEEP_BEHIND_S + 1 }, KEEP_BEHIND_S + 0.9);
        expect(near.trimTo).toBeNull();
        const far = keepLive(0, { start: 0, end: KEEP_BEHIND_S + 3 }, KEEP_BEHIND_S + 2.9);
        expect(far.trimTo).toBeCloseTo(2.9);
    });
});

describe("finding a media source", () => {
    it("prefers the standard one and takes the managed one an iPhone has", () => {
        class Standard {}
        class Managed {}
        expect(mediaSourceType({ MediaSource: Standard, ManagedMediaSource: Managed })).toBe(
            Standard
        );
        expect(mediaSourceType({ ManagedMediaSource: Managed })).toBe(Managed);
        expect(mediaSourceType({})).toBeNull();
    });
});

describe("reconnecting a stream that dropped", () => {
    it("tries again after a second the first time", () => {
        expect(reconnectDelay(0)).toBe(RECONNECT_MIN_MS);
    });

    it("waits longer with each drop in a row, up to a ceiling", () => {
        expect(reconnectDelay(1)).toBe(RECONNECT_MIN_MS * 2);
        expect(reconnectDelay(2)).toBe(RECONNECT_MIN_MS * 4);
        expect(reconnectDelay(50)).toBe(RECONNECT_MAX_MS);
    });
});
