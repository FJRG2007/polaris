/**
 * A telephone that stops ringing when it has been answered.
 *
 * Somebody signed in on a phone and on a desk was rung on both, answered on the
 * phone, and the desk went on ringing - card up, sound going, and a notice from
 * the operating system offering to join a call they were already in. An account
 * holds one seat, so there was never a second call to answer; there was one
 * call and one machine that had not been told.
 *
 * There is no frame for "answered elsewhere" and there did not need to be:
 * joining a call is already announced to the conversation, carrying who joined.
 */

import { describe, expect, it } from "vitest";
import { ringDecision } from "@/lib/chat/ring-decision";

const ME = "user-me";
const THEM = "user-them";

describe("what a call frame means to a browser that is not in the call", () => {
    it("rings for somebody else's call", () => {
        expect(ringDecision({ state: "ringing", userId: THEM, count: 1 }, ME)).toBe("ring");
    });

    it("does not ring at the person who pressed the button", () => {
        // The frame is addressed to the conversation, and the caller is in it.
        expect(ringDecision({ state: "ringing", userId: ME, count: 1 }, ME)).toBe("ignore");
    });

    it("stops ringing when this person answers on another device", () => {
        // The one this was written for. `moved` carrying your own id is you,
        // somewhere else, picking up.
        expect(ringDecision({ state: "moved", userId: ME, count: 2 }, ME)).toBe("settle");
    });

    it("leaves the card alone when it is somebody else who joined", () => {
        // A third person answering a group call is not an answer on your
        // behalf: a card that vanished then would be a call you were never
        // given the chance to take. Nor is it an invitation - the card is
        // already up, put there by the ringing frame - so the honest answer is
        // neither of the two that change anything.
        expect(ringDecision({ state: "moved", userId: THEM, count: 2 }, ME)).toBe("ignore");
    });

    it("drops a call that ended or emptied", () => {
        expect(ringDecision({ state: "ended", userId: "", count: 0 }, ME)).toBe("drop");
        expect(ringDecision({ state: "moved", userId: THEM, count: 0 }, ME)).toBe("drop");
    });

    it("never reads an empty actor as somebody", () => {
        // The server sends one when a thing happened rather than when somebody
        // did it - a seat swept, a room closed. A viewer whose id compared equal
        // to "" would have every one of those silence their telephone.
        expect(ringDecision({ state: "moved", userId: "", count: 2 }, "")).toBe("ignore");
        expect(ringDecision({ state: "moved", userId: "", count: 2 }, ME)).toBe("ignore");
    });
});
