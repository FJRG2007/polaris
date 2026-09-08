/**
 * A hand and a reaction, checked without a call server.
 *
 * The rule worth asserting is the ordering: a hand is a queue, every browser in
 * the call sorts it for itself, and they all have to reach the same answer or
 * the person chairing and the person waiting disagree about who is next.
 *
 * The schema is here for the same reason a request body's is: a reaction arrives
 * from somebody else's browser and is drawn over everybody's picture, so what it
 * refuses matters more than what it accepts.
 */

import { describe, expect, it } from "vitest";
import {
    HAND,
    HAND_AT,
    callSignalSchema,
    handPlaces,
    handQueue,
    handRaised,
    handRaisedAt,
    handsQueueSummary,
    handsSummary
} from "@/app/(app)/chat/call-signals";

describe("a raised hand", () => {
    it("is read off the attribute everybody is handed, latecomers included", () => {
        expect(handRaised({ [HAND]: "1" })).toBe(true);
        expect(handRaised({ [HAND]: "" })).toBe(false);
        expect(handRaised(undefined)).toBe(false);
    });

    it("treats a missing or nonsense moment as not raised", () => {
        expect(handRaisedAt(undefined)).toBe(0);
        expect(handRaisedAt({ [HAND_AT]: "soon" })).toBe(0);
        expect(handRaisedAt({ [HAND_AT]: "1757000000000" })).toBe(1757000000000);
    });
});

describe("the queue of hands", () => {
    it("is oldest first, so whoever is chairing knows who is next", () => {
        expect(
            handQueue([
                { id: "c", hand: true, handAt: 300 },
                { id: "a", hand: true, handAt: 100 },
                { id: "b", hand: true, handAt: 200 }
            ])
        ).toEqual(["a", "b", "c"]);
    });

    it("leaves out the hands that are down", () => {
        expect(
            handQueue([
                { id: "a", hand: false, handAt: 0 },
                { id: "b", hand: true, handAt: 100 }
            ])
        ).toEqual(["b"]);
    });

    it("breaks a tie the same way in every browser", () => {
        // Two hands in the same millisecond must not come out in the order the
        // list happened to arrive in, or two people see two different queues.
        const one = handQueue([
            { id: "zoe", hand: true, handAt: 100 },
            { id: "ada", hand: true, handAt: 100 }
        ]);
        const two = handQueue([
            { id: "ada", hand: true, handAt: 100 },
            { id: "zoe", hand: true, handAt: 100 }
        ]);
        expect(one).toEqual(two);
    });
});

describe("what the queue is drawn as", () => {
    it("numbers every hand from one, in the order they went up", () => {
        const places = handPlaces(["ada", "bo", "cy"]);
        expect(places.get("ada")).toBe(1);
        expect(places.get("bo")).toBe(2);
        expect(places.get("cy")).toBe(3);
    });

    it("knows nothing about a hand that is down", () => {
        expect(handPlaces(["ada"]).get("bo")).toBeUndefined();
    });

    it("says who, while who is still the question", () => {
        // One hand is a person asking to speak, and the only thing worth saying
        // about it is their name.
        expect(handsSummary([{ id: "a", name: "Ada", own: false }])).toBe("Ada has their hand up");
        expect(handsSummary([{ id: "a", name: "Ada", own: true }])).toBe("Your hand is up");
    });

    it("counts once who stops being the question and next starts", () => {
        expect(
            handsSummary([
                { id: "a", name: "Ada", own: false },
                { id: "b", name: "Bo", own: true }
            ])
        ).toBe("2 hands are up");
    });

    it("says nothing at all when nobody has asked", () => {
        expect(handsSummary([])).toBe("");
    });

    it("names who is next for a bar that has no room to draw the queue", () => {
        const hands = [
            { id: "a", name: "Ada", own: false },
            { id: "b", name: "Bo", own: true }
        ];
        expect(handsQueueSummary(hands)).toBe("2 hands are up. Ada is first");
    });

    it("never puts the reader's own hand in the third person", () => {
        // The bar built this sentence itself and substituted a pronoun into it,
        // which read "You has a hand up" to the one person it was about - and
        // "3 hands are up. You is first" once there were three.
        expect(handsQueueSummary([{ id: "b", name: "Bo", own: true }])).toBe("Your hand is up");
        expect(
            handsQueueSummary([
                { id: "b", name: "Bo", own: true },
                { id: "a", name: "Ada", own: false }
            ])
        ).toBe("2 hands are up. You are first");
    });

    it("says nothing when no hand is up", () => {
        expect(handsQueueSummary([])).toBe("");
    });
});

describe("being asked to lower a hand", () => {
    it("is a message, because a browser may only write its own attributes", () => {
        expect(callSignalSchema.safeParse({ kind: "lower-hand" }).success).toBe(true);
    });

    it("carries nothing, so there is nothing to aim it with", () => {
        // Who it is about is who received it, and who may ask is who sent it -
        // both read off the connection rather than off the body, where somebody
        // else's browser could write them. See `use-sfu-call`, which drops one
        // that did not come from the host's seat.
        const parsed = callSignalSchema.safeParse({ kind: "lower-hand", participantId: "someone" });
        expect(parsed.success && parsed.data).toEqual({ kind: "lower-hand" });
    });
});

describe("a reaction arriving from another browser", () => {
    it("is accepted when it is one of the ones on offer", () => {
        expect(callSignalSchema.safeParse({ kind: "reaction", reaction: "clap" }).success).toBe(
            true
        );
    });

    it("refuses anything else, because it is drawn over everybody's picture", () => {
        for (const junk of [
            { kind: "reaction", reaction: "\u{1F4A9}" },
            { kind: "reaction", reaction: "<script>" },
            { kind: "reaction" },
            { kind: "combine-ask" },
            "clap",
            null
        ]) {
            expect(callSignalSchema.safeParse(junk).success).toBe(false);
        }
    });
});
