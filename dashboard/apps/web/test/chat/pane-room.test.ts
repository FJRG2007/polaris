/**
 * How wide a panel may actually be drawn.
 *
 * A panel's own limits say whether that panel is usable at that size, which is
 * not the question this answers. Two panels each inside their own limits can
 * still come to more than the window, and because everything in that row holds
 * its width and the conversation takes what is left, the cost lands there first
 * and then off the right-hand edge - so the panel somebody widened is the one
 * drawn half outside the screen, with the button that closes it cut off.
 *
 * What is pinned here is that the ceiling follows the room rather than the
 * limit, that it never drops below the floor the divider starts at - a ceiling
 * under the minimum inverts the control it is handed to - and that a panel with
 * nothing measured yet is held to its stated limit rather than to a guess.
 */

import { describe, expect, it } from "vitest";
import { CONVERSATION_FLOOR, paneCeiling } from "@/app/(app)/chat/pane-room";

const BOUNDS = { min: 280, max: 560 };

describe("what a panel may grow to", () => {
    it("leaves the stated ceiling alone while there is room to spare", () => {
        // A wide window: the conversation can give up a lot and still be a
        // conversation, so the panel's own limit is the one that applies.
        expect(paneCeiling(BOUNDS, 384, 900)).toBe(BOUNDS.max);
    });

    it("stops where the conversation would stop being readable", () => {
        // 384 wide with 500 beside it: 240 of that 500 is spare, and the panel
        // may have exactly that much.
        expect(paneCeiling(BOUNDS, 384, 500)).toBe(384 + 500 - CONVERSATION_FLOOR);
    });

    it("never hands back a ceiling under the floor the divider starts at", () => {
        // A window too narrow to hold both. The honest answer is that the panel
        // stops growing, not that it folds away - and a maximum below the
        // minimum is a divider whose two ends have swapped over.
        const ceiling = paneCeiling(BOUNDS, 400, 40);
        expect(ceiling).toBe(BOUNDS.min);
        expect(ceiling).toBeGreaterThanOrEqual(BOUNDS.min);
    });

    it("asks a panel already over the room to come back", () => {
        // The case a remembered width arrives in: sized on a wide monitor, opened
        // in a narrow window. The ceiling is under what it is drawn at, which is
        // what pulls it back rather than pushing the conversation off the screen.
        expect(paneCeiling(BOUNDS, 560, 100)).toBeLessThan(560);
    });

    it("settles rather than shrinking twice", () => {
        // The measurement happens again once the panel has been redrawn at the
        // new size, and what it sees then is a wider conversation. It has to
        // arrive at the same number, or the panel walks itself down to nothing a
        // frame at a time.
        const row = 900;
        const first = Math.min(560, paneCeiling(BOUNDS, 560, row - 560));
        const second = Math.min(560, paneCeiling(BOUNDS, first, row - first));
        expect(second).toBe(first);
        expect(row - first).toBeGreaterThanOrEqual(CONVERSATION_FLOOR);
    });

    it("holds to the stated limit until something has been measured", () => {
        // Before the first paint there is nothing to divide. A ceiling invented
        // from a zero would open every panel at its minimum.
        expect(paneCeiling(BOUNDS, 0, 0)).toBe(BOUNDS.max);
        expect(paneCeiling(BOUNDS, Number.NaN, 800)).toBe(BOUNDS.max);
        expect(paneCeiling(BOUNDS, 384, Number.NaN)).toBe(BOUNDS.max);
    });

    it("takes a floor of its own when the caller has one", () => {
        // Not every panel is beside a conversation, so the floor is an argument
        // rather than a constant this reaches for on its own.
        expect(paneCeiling(BOUNDS, 300, 300, 200)).toBe(400);
        expect(paneCeiling(BOUNDS, 300, 300)).toBe(BOUNDS.min);
    });
});
