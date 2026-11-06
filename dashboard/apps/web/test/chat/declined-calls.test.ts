/**
 * Hanging up on one device stops the ring on every other one, including a
 * device that missed the frame saying so: the decline is remembered for the
 * length of a ring and handed to the next ask, and a ringing telephone stops
 * every call in that answer.
 */

import { describe, expect, it } from "vitest";
import { DECLINE_KEPT_MS, declinedCalls, rememberDecline } from "@/lib/chat/declined-calls";
import { ringsToStop } from "@/lib/chat/ring-decision";

describe("declined calls", () => {
    it("are kept for the account that declined, and nobody else", () => {
        rememberDecline("u-decline-1", "m1", 1_000);
        expect(declinedCalls("u-decline-1", 2_000)).toEqual(["m1"]);
        expect(declinedCalls("u-decline-2", 2_000)).toEqual([]);
    });

    it("are forgotten once no call could still be ringing", () => {
        rememberDecline("u-decline-3", "m1", 1_000);
        expect(declinedCalls("u-decline-3", 1_000 + DECLINE_KEPT_MS)).toEqual([]);
        rememberDecline("u-decline-3", "m2", 1_000 + DECLINE_KEPT_MS);
        expect(declinedCalls("u-decline-3", 1_000 + DECLINE_KEPT_MS)).toEqual(["m2"]);
    });

    it("stay bounded however many are declined", () => {
        for (let index = 0; index < 100; index++)
            rememberDecline("u-decline-4", `m${index}`, 1_000);
        expect(declinedCalls("u-decline-4", 1_000)).toHaveLength(20);
        expect(declinedCalls("u-decline-4", 1_000).at(-1)).toBe("m99");
    });
});

describe("ringsToStop", () => {
    const ringing = [{ meetingId: "m1" }, { meetingId: "m2" }];

    it("stops a call declined on another device", () => {
        expect(ringsToStop({ call: null, declined: ["m2", "m9"] }, ringing)).toEqual(["m2"]);
    });

    it("stops the call this account sits in elsewhere, as it always did", () => {
        expect(ringsToStop({ call: { meetingId: "m1" }, declined: [] }, ringing)).toEqual(["m1"]);
    });

    it("stops nothing when nothing was answered or declined", () => {
        expect(ringsToStop({ call: null, declined: [] }, ringing)).toEqual([]);
    });
});
