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
    handQueue,
    handRaised,
    handRaisedAt
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
