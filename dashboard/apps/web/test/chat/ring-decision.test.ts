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
import { ringDecision, roomAfter } from "@/lib/chat/ring-decision";

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

/**
 * And what became of the room, which is the other half of the same reading.
 *
 * A card that turns into "Missed call" because the ringing ran out disagrees
 * with the server, which writes nothing at all once anybody but the caller has
 * sat in the room. So a group call one person answered used to leave everybody
 * else with a persistent card and a Call back button for a conversation that was
 * answered and might still be running.
 */
describe("what became of the room", () => {
    const RANG = { state: "ringing", userId: THEM, count: 1 } as const;

    it("starts from the ringing frame, with the caller alone in it", () => {
        expect(roomAfter(undefined, RANG)).toEqual({ ringing: 1, answered: false });
    });

    it("says nothing about a call this browser never heard ring", () => {
        expect(roomAfter(undefined, { state: "moved", userId: THEM, count: 2 })).toBeUndefined();
        expect(roomAfter(undefined, { state: "ended", userId: "", count: 0 })).toBeUndefined();
    });

    it("is answered once somebody walks in", () => {
        const rang = roomAfter(undefined, RANG);
        expect(roomAfter(rang, { state: "moved", userId: THEM, count: 2 })?.answered).toBe(true);
    });

    it("stays answered after they leave again, and after the room closes", () => {
        const joined = roomAfter(roomAfter(undefined, RANG), {
            state: "moved",
            userId: THEM,
            count: 2
        });
        const left = roomAfter(joined, { state: "moved", userId: "", count: 1 });
        expect(left?.answered).toBe(true);
        expect(roomAfter(left, { state: "ended", userId: "", count: 0 })?.answered).toBe(true);
    });

    it("is not answered by a call that only ever held the person who rang", () => {
        // The missed call itself. Nobody joined, it timed out, the room closed.
        const rang = roomAfter(undefined, RANG);
        const ended = roomAfter(rang, { state: "ended", userId: "", count: 0 });
        expect(ended?.answered).toBe(false);
    });

    it("is not answered by a second ringing frame", () => {
        // Inviting somebody into a group rings them with a frame of its own.
        const rang = roomAfter(undefined, RANG);
        expect(roomAfter(rang, { state: "ringing", userId: THEM, count: 1 })?.answered).toBe(false);
    });
});
