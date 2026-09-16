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

/**
 * Two panels, one conversation.
 *
 * The room a conversation has to spare is one pool, and each panel works its own
 * ceiling out from the same measurement of it. Handed whole to each of them it
 * is a pool they both take at once, and the pair never lands anywhere: each
 * gives back what it is over by, each then sees the other's pixels going spare
 * and takes them, and they are over again. What that costs is not a wasted
 * frame - it is the conversation under the floor this whole file exists to
 * defend, on every other one of them.
 */
describe("what two panels beside the same conversation may grow to", () => {
    it("divides what is spare rather than offering it whole to each", () => {
        // 500 beside them leaves 140 going spare. One panel may have all of it;
        // two may have half each, because they are going to take it at the same
        // time.
        expect(paneCeiling(BOUNDS, 384, 500, CONVERSATION_FLOOR, 1)).toBe(524);
        expect(paneCeiling(BOUNDS, 384, 500, CONVERSATION_FLOOR, 2)).toBe(454);
    });

    it("hands out less than there is rather than more, when it will not divide", () => {
        // 41 spare between two. Twenty each and a pixel left with the
        // conversation: rounded the other way they would be a pixel over, which
        // is this mechanism in reverse - given back next frame and taken again
        // the frame after, for as long as the window is that size.
        const ceiling = paneCeiling(BOUNDS, 300, CONVERSATION_FLOOR + 41, CONVERSATION_FLOOR, 2);
        expect(ceiling).toBe(320);
        expect((ceiling - 300) * 2).toBeLessThanOrEqual(41);
    });

    it("asks each of them for the whole shortfall, not a share of it", () => {
        // Over the edge, and every panel has to stand out of the way for the
        // conversation to be whole again. Sharing a debt leaves it owed.
        expect(paneCeiling(BOUNDS, 500, 300, CONVERSATION_FLOOR, 2)).toBe(440);
    });

    it("settles the pair instead of cycling between two sizes", () => {
        // 957 across a list, a conversation and a members column, with the list
        // remembering 480 from a wider monitor. Taken whole, the two ceilings
        // walk 357/208 -> 389/240 -> 357/208 for as long as the window is open.
        const LIST = { min: 208, max: 480 };
        const MEMBERS = { min: 208, max: 420 };
        const total = 957;
        let list = 480;
        let members = 240;
        const seen: string[] = [];
        for (let pass = 0; pass < 8; pass += 1) {
            const conversation = total - list - members;
            // Both are drawn at their ceiling here, so both are still asking.
            const share = 2;
            list = Math.min(480, paneCeiling(LIST, list, conversation, CONVERSATION_FLOOR, share));
            members = Math.min(
                240,
                paneCeiling(MEMBERS, members, conversation, CONVERSATION_FLOOR, share)
            );
            seen.push(`${list}/${members}`);
        }
        // The last four passes are the same arrangement, not two taking turns.
        expect(new Set(seen.slice(-4)).size).toBe(1);
        expect(total - list - members).toBeGreaterThanOrEqual(CONVERSATION_FLOOR);
    });
});
