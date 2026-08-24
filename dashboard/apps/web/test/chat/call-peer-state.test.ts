/**
 * Whether the room can tell that you are muted.
 *
 * The bug this holds down needed two people, two browsers and a call server to
 * see, and none of that is needed to state it: join a call with your microphone
 * already off, have somebody join after you, and they see you unmuted for the
 * rest of the call. The mute rode on the signalling of a publication that
 * already existed, so it reached everybody who was in the room at the time and
 * nobody who arrived later - who were handed a track whose muted flag was
 * settled at publish, a moment before the mute.
 *
 * So it is said out loud, and what is said wins over what the publication
 * carries. The publication is still read for a browser in the room from before
 * this existed, which never says anything at all.
 */

import { describe, expect, it } from "vitest";
import { peerState } from "@/app/(app)/chat/call-peer-state";

describe("somebody who says how they are", () => {
    it("is muted when they say so, whatever their publication carries", () => {
        // The reported case exactly: the publication went up unmuted, the mute
        // that followed reached nobody who was not already in the room.
        expect(peerState({ attributes: { muted: "1" }, isMicrophoneEnabled: true }).muted).toBe(
            true
        );
    });

    it("is not muted when they say so, whatever their publication carries", () => {
        expect(peerState({ attributes: { muted: "0" }, isMicrophoneEnabled: false }).muted).toBe(
            false
        );
    });

    it("is deafened only on the word for it", () => {
        expect(peerState({ attributes: { deafened: "1" }, isMicrophoneEnabled: true }).deafened).toBe(
            true
        );
        expect(peerState({ attributes: {}, isMicrophoneEnabled: true }).deafened).toBe(false);
    });
});

describe("somebody who says nothing", () => {
    it("falls back to the publication, which is what a browser from before this does", () => {
        expect(peerState({ isMicrophoneEnabled: false }).muted).toBe(true);
        expect(peerState({ isMicrophoneEnabled: true }).muted).toBe(false);
    });

    it("reads an empty answer as no answer rather than as unmuted", () => {
        // "" is how an attribute is removed, so it arrives as absence. Treating
        // it as a spoken "not muted" would let a stale removal outrank the truth.
        expect(peerState({ attributes: { muted: "" }, isMicrophoneEnabled: false }).muted).toBe(
            true
        );
    });
});
