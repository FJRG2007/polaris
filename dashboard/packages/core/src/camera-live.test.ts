/**
 * The two rules that keep a rectangle honest.
 *
 * Both failures this pins are the same failure to a reader: a box over a place
 * where nothing is. Live, that happens when a frame is drawn after the thing
 * left; in a recording, when a mark is drawn outside the span it was written
 * for. Neither is visible in a screenshot and both are obvious to somebody
 * watching, which is the worst combination to leave untested.
 */

import * as live from "./camera-live.js";
import { describe, expect, it } from "vitest";

const BOX = { x1: 0.2, y1: 0.3, x2: 0.4, y2: 0.8 };

const FRAME: live.LiveFrame = {
    at: 1_000_000,
    boxes: [{ id: "t1", label: "person", score: 88, box: BOX }]
};

describe("a live frame", () => {
    it("is drawn while it is current", () => {
        expect(live.freshBoxes(FRAME, FRAME.at + 200)).toHaveLength(1);
    });

    it("stops being drawn once it is older than its window", () => {
        expect(live.freshBoxes(FRAME, FRAME.at + live.LIVE_TTL_MS + 1)).toEqual([]);
    });

    it("survives an ordinary gap between detector frames", () => {
        // Five a second, so two missed frames is 400ms. A window that expired
        // inside that would make every box blink.
        expect(live.freshBoxes(FRAME, FRAME.at + 400)).toHaveLength(1);
    });

    it("refuses a frame stamped in the future rather than holding it twice as long", () => {
        expect(live.freshBoxes(FRAME, FRAME.at - live.LIVE_TTL_MS - 1)).toEqual([]);
    });

    it("says nothing when nothing has been published", () => {
        expect(live.freshBoxes(null, Date.now())).toEqual([]);
        expect(live.freshBoxes(undefined, Date.now())).toEqual([]);
    });
});

const MARKS: live.ClipMark[] = [
    { id: "a", label: "person", score: 90, box: BOX, fromMs: 2_000, toMs: 6_000 },
    { id: "b", label: "vehicle", score: 70, box: BOX, fromMs: 5_000, toMs: null }
];

describe("a recording's marks", () => {
    it("covers the moment it was written for", () => {
        expect(live.marksAt(MARKS, 3_000).map((mark) => mark.id)).toEqual(["a"]);
    });

    it("draws two things that were there at once", () => {
        expect(live.marksAt(MARKS, 5_500).map((mark) => mark.id)).toEqual(["a", "b"]);
    });

    it("draws nothing before anything happened", () => {
        expect(live.marksAt(MARKS, 500)).toEqual([]);
    });

    it("lets something with no ending go rather than leaving it up for good", () => {
        expect(live.marksAt(MARKS, 6_500).map((mark) => mark.id)).toEqual(["b"]);
        expect(live.marksAt(MARKS, 5_000 + live.MARK_FALLBACK_MS + 1)).toEqual([]);
    });
});

describe("building a clip's marks", () => {
    const START = "2026-08-21T10:00:00.000Z";
    const events = [
        {
            id: "e1",
            kind: "person",
            label: "Ana",
            score: 91,
            box: BOX,
            at: "2026-08-21T10:00:04.000Z",
            endedAt: "2026-08-21T10:00:09.000Z"
        },
        // Before the recording started - a box on the first frame it does not
        // belong to.
        { id: "e2", kind: "person", label: null, score: 60, box: BOX, at: "2026-08-21T09:59:50.000Z" },
        // After it ended.
        { id: "e3", kind: "person", label: null, score: 60, box: BOX, at: "2026-08-21T10:01:30.000Z" },
        // The movement rung keeps no position, so there is nothing to draw.
        { id: "e4", kind: "motion", label: null, score: null, box: null, at: "2026-08-21T10:00:05.000Z" }
    ];

    it("keeps only what happened during the clip, timed from its start", () => {
        const marks = live.marksForClip(events, START, 30_000);
        expect(marks.map((mark) => mark.id)).toEqual(["e1"]);
        expect(marks[0]).toMatchObject({ fromMs: 4_000, toMs: 9_000, label: "Ana" });
    });

    it("falls back to what it was detected as when nobody was recognized", () => {
        const marks = live.marksForClip(
            [{ id: "e5", kind: "vehicle", label: null, score: 55, box: BOX, at: "2026-08-21T10:00:02.000Z" }],
            START,
            30_000
        );
        expect(marks[0]?.label).toBe("vehicle");
        expect(marks[0]?.toMs).toBeNull();
    });

    it("says nothing about a clip whose start makes no sense", () => {
        expect(live.marksForClip(events, "not a date", 30_000)).toEqual([]);
    });
});
