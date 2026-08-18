/**
 * Which screens get the big place in a call, and in what order.
 *
 * The bug this exists to hold shut: a shared screen used to be folded into the
 * sharer's own camera stream, so the one person in the call who could not see
 * what was being shared was the person sharing it. It arrived in their
 * head-sized tile down in the grid while everybody else had it across the top of
 * theirs - and "make it bigger" did nothing, because as far as the room was
 * concerned there was no screen in it.
 *
 * The other half is that several people can share at once. Each subscriber is
 * only sent what they are watching, so there was never a reason to allow one -
 * and a list that quietly kept the last one would be the same class of bug in
 * the other direction.
 */

import { describe, expect, it } from "vitest";
import { stagesOf } from "@/app/(app)/chat/call-media";

/** Standing in for a real one: nothing here reads a stream, only carries it. */
const stream = (label: string) => ({ label }) as unknown as MediaStream;

const named = (personId: string) => (personId === "p2" ? "Ada" : "Somebody");

describe("the screens on show", () => {
    it("is empty when nobody is sharing", () => {
        expect(
            stagesOf({
                localScreen: null,
                participantId: "p1",
                screens: new Map(),
                nameOf: named
            })
        ).toEqual([]);
    });

    it("includes your own screen, which is the whole point of it", () => {
        const mine = stream("mine");
        const stages = stagesOf({
            localScreen: mine,
            participantId: "p1",
            screens: new Map(),
            nameOf: named
        });
        expect(stages).toHaveLength(1);
        expect(stages[0]?.stream).toBe(mine);
        expect(stages[0]?.key).toBe("screen:p1");
    });

    it("puts yours first, so the one you are responsible for is the one you see", () => {
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages.map((stage) => stage.key)).toEqual(["screen:p1", "screen:p2"]);
    });

    it("names somebody else's by whose it is", () => {
        const stages = stagesOf({
            localScreen: null,
            participantId: "p1",
            screens: new Map([["p2", stream("theirs")]]),
            nameOf: named
        });
        expect(stages[0]?.name).toBe("Ada - screen");
    });

    it("keeps every screen when several people share at once", () => {
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([
                ["p2", stream("two")],
                ["p3", stream("three")],
                ["p4", stream("four")]
            ]),
            nameOf: named
        });
        expect(stages).toHaveLength(4);
    });

    it("draws your own screen once even if it comes back from the server", () => {
        // A client that subscribes to itself would otherwise put two copies of
        // one picture on the stage, the second of them a round trip behind.
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: "p1",
            screens: new Map([["p1", stream("mine, returned")]]),
            nameOf: named
        });
        expect(stages).toHaveLength(1);
        expect(stages[0]?.name).toBe("Your screen");
    });

    it("still gives your screen a key before the seat is known", () => {
        // The picture is on screen the moment the browser grants it, which can
        // be before the roster frame naming this browser's seat has arrived. A
        // key of "screen:null" would collide with nothing, but it would also
        // stop matching once the seat landed and drop the focus somebody had
        // just asked for.
        const stages = stagesOf({
            localScreen: stream("mine"),
            participantId: null,
            screens: new Map(),
            nameOf: named
        });
        expect(stages[0]?.key).toBe("screen:mine");
    });
});
