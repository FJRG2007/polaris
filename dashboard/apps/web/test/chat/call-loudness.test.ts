/**
 * Comparing voices in a call, so the quiet one can be told.
 *
 * Pinned: a level needs enough speech behind it before it is compared; the
 * comparison is against the typical voice (the median), so one loud person does
 * not make everybody else look quiet; the hint has hysteresis; and nothing under
 * the floor counts as speech.
 */

import { describe, expect, it } from "vitest";
import {
    ENOUGH_SPEECH_MS,
    gapBelow,
    gapFor,
    gapWords,
    LIFT_FROM_DB,
    LIFT_MAX,
    liftFor,
    LOUDNESS_START,
    QUIET_CLEAR_DB,
    QUIET_GAP_DB,
    quietVerdict,
    SELF,
    stepLoudness,
    VOICE_FLOOR_DB,
    type Loudness
} from "@/app/(app)/chat/call-loudness";

function talked(db: number, ms = ENOUGH_SPEECH_MS + 2000): Loudness {
    let state = LOUDNESS_START;
    for (let at = 0; at < ms; at += 200) state = stepLoudness(state, db, 200);
    return state;
}

describe("a voice's level", () => {
    it("is what it has been speaking at, and counts the speech behind it", () => {
        const level = talked(-30);
        expect(level.speechDb).toBeCloseTo(-30, 5);
        expect(level.speechMs).toBeGreaterThanOrEqual(ENOUGH_SPEECH_MS);
    });

    it("ignores readings under the floor, and gaps longer than a second", () => {
        expect(stepLoudness(LOUDNESS_START, VOICE_FLOOR_DB - 1, 200)).toBe(LOUDNESS_START);
        expect(stepLoudness(LOUDNESS_START, -30, 60_000).speechMs).toBe(1000);
    });
});

describe("the gap", () => {
    it("is unknown until both sides have talked enough", () => {
        expect(gapBelow(talked(-40, 2000), [talked(-25)])).toBeNull();
        expect(gapBelow(talked(-40), [talked(-25, 2000)])).toBeNull();
        expect(gapBelow(talked(-40), [])).toBeNull();
    });

    it("is measured against the typical voice, not the loudest", () => {
        const gap = gapBelow(talked(-40), [talked(-26), talked(-28), talked(-6)]);
        expect(gap).toBeCloseTo(14, 1);
    });

    it("reads each person against everybody else, yourself included", () => {
        const all = new Map([
            [SELF, talked(-27)],
            ["sam", talked(-42)],
            ["ana", talked(-26)]
        ]);
        expect(gapFor(all, "sam")).toBeCloseTo(15.5, 1);
        expect(gapWords(gapFor(all, "sam"))).toBe("quieter");
        expect(gapWords(gapFor(all, "ana"))).toBe("louder");
        expect(gapWords(gapFor(all, "nobody"))).toBe("unknown");
        expect(gapWords(2)).toBe("same");
    });
});

describe("the hint", () => {
    it("appears past the gap and only goes once the voice is well back", () => {
        expect(quietVerdict(QUIET_GAP_DB - 1, false)).toBe(false);
        expect(quietVerdict(QUIET_GAP_DB, false)).toBe(true);
        expect(quietVerdict(QUIET_CLEAR_DB + 1, true)).toBe(true);
        expect(quietVerdict(QUIET_CLEAR_DB - 1, true)).toBe(false);
    });

    it("keeps what it said while there is nothing new to go on", () => {
        expect(quietVerdict(null, true)).toBe(true);
        expect(quietVerdict(null, false)).toBe(false);
    });
});

describe("lifting a quiet voice", () => {
    it("leaves anybody at or above the room alone", () => {
        expect(liftFor(null)).toBe(1);
        expect(liftFor(-12)).toBe(1);
        expect(liftFor(0)).toBe(1);
        expect(liftFor(LIFT_FROM_DB)).toBe(1);
    });

    it("rises with the gap, without a step, and stops at the ceiling", () => {
        expect(liftFor(LIFT_FROM_DB + 0.01)).toBeCloseTo(1, 2);
        expect(liftFor(LIFT_FROM_DB + 6)).toBeCloseTo(10 ** (6 / 20), 5);
        expect(liftFor(LIFT_FROM_DB + 5)).toBeGreaterThan(liftFor(LIFT_FROM_DB + 2));
        expect(liftFor(40)).toBe(LIFT_MAX);
    });

    it("lifts the voice that arrives below everybody else, and only that one", () => {
        const all = new Map([
            ["quiet", talked(-40)],
            ["a", talked(-25)],
            ["b", talked(-26)]
        ]);
        expect(liftFor(gapFor(all, "quiet"))).toBe(LIFT_MAX);
        expect(liftFor(gapFor(all, "a"))).toBe(1);
        expect(liftFor(gapFor(all, "b"))).toBe(1);
    });
});
