/**
 * Combining audio is only offered with three or more people in the call.
 *
 * With two, the devices "in one room" are the whole call. The offer follows the
 * roster and the media connection live: it opens when a third person joins and
 * closes again when they leave, taking the smaller of the two counts because the
 * roster keeps a seat until its heartbeat runs out.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { combineOffered } from "@/app/(app)/chat/call-combine";
import type { CallState } from "@/app/(app)/chat/call-state";
import { CombineRequestDialog, CombineStrip } from "@/app/(app)/chat/call-combine-panel";

describe("whether combining is offered", () => {
    it("is not with two people", () => {
        expect(combineOffered(2, 1)).toBe(false);
    });

    it("is once a third joins", () => {
        expect(combineOffered(3, 2)).toBe(true);
    });

    it("is not once the third drops off the connection, before the roster notices", () => {
        expect(combineOffered(3, 1)).toBe(false);
    });

    it("is not while the third is connecting but has no seat yet", () => {
        expect(combineOffered(2, 2)).toBe(false);
    });
});

function call(open: boolean): CallState {
    return {
        audioRole: null,
        nearby: new Set(["seat-bo"]),
        combineOpen: open,
        combineAsked: null,
        combineRequest: { from: "seat-bo" },
        meeting: {
            participants: [
                { id: "seat-me", name: "Me", admission: "admitted" },
                { id: "seat-bo", name: "Bo", admission: "admitted" }
            ]
        }
    } as unknown as CallState;
}

describe("the suggestion strip", () => {
    it("suggests combining with somebody heard nearby when it is offered", () => {
        expect(renderToStaticMarkup(<CombineStrip call={call(true)} />)).toContain(
            "sounds like they are in this room"
        );
    });

    it("says nothing in a call of two", () => {
        expect(renderToStaticMarkup(<CombineStrip call={call(false)} />)).toBe("");
        expect(renderToStaticMarkup(<CombineRequestDialog call={call(false)} />)).toBe("");
    });
});
