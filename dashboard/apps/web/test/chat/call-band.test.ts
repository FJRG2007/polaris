/**
 * How much of the column a call takes.
 *
 * The defect this pins down: a one-to-one - two circles and a row of buttons -
 * was given three fifths of the screen, the same as a call in a channel, and it
 * buried the conversation it had been started from.
 *
 * The precedence is the part worth holding still. A screen somebody asked to
 * watch has to outrank the band, or enlarging a shared document would have
 * nowhere to enlarge into; and a voice channel has to ignore both, because the
 * conversation there is beside the call rather than under it.
 *
 * Sizes are compared rather than spelled out, so the band can be tuned without
 * a test failing over a number nobody promised.
 */

import { describe, expect, it } from "vitest";
import { callBandHeight, callBareFaces } from "@/app/(app)/chat/call-band";

/** The cap as a percentage, so an assertion can read as a size rather than as a
 *  class name. */
function cap(height: string): number {
    const found = /max-h-\[(\d+)%\]/.exec(height);
    if (!found) throw new Error(`Not a capped height: ${height}`);
    return Number(found[1]);
}

describe("the room a call is given", () => {
    it("fills the column in a voice channel, where the call is the point", () => {
        expect(callBandHeight("room", false)).toBe("flex-1");
        expect(callBandHeight("room", true)).toBe("flex-1");
    });

    it("gives a direct message less than a call in a channel", () => {
        expect(cap(callBandHeight("direct", false))).toBeLessThan(
            cap(callBandHeight("channel", false))
        );
    });

    it("leaves a direct message most of its conversation on screen", () => {
        // Half the column is the line between a conversation with a call over it
        // and a call with a conversation squeezed under it.
        expect(cap(callBandHeight("direct", false))).toBeLessThan(50);
    });

    it("hands a shared screen the same room wherever the call was started", () => {
        expect(callBandHeight("direct", true)).toBe(callBandHeight("channel", true));
        expect(cap(callBandHeight("direct", true))).toBeGreaterThan(
            cap(callBandHeight("direct", false))
        );
    });
});

describe("whether the people are faces or tiles", () => {
    it("is tiles in a voice channel, where the grid is the room", () => {
        expect(callBareFaces("room", false, false)).toBe(false);
        expect(callBareFaces("room", true, true)).toBe(false);
    });

    it("is faces in a conversation with nothing to look at", () => {
        // Which is most of a call: a wall of head-sized rectangles around
        // switched-off cameras is empty panel taken from the messages.
        expect(callBareFaces("direct", false, false)).toBe(true);
        expect(callBareFaces("channel", false, false)).toBe(true);
    });

    it("is tiles the moment a camera is sending", () => {
        // The defect this pins down: a face is an avatar and no video element,
        // so a call drawn as faces while somebody has a camera on showed nobody
        // - not the person who pressed "Start video", not the people watching -
        // with nothing on screen saying why.
        expect(callBareFaces("direct", false, true)).toBe(false);
        expect(callBareFaces("channel", false, true)).toBe(false);
    });

    it("is tiles while a screen is being watched, which is the strip", () => {
        expect(callBareFaces("direct", true, false)).toBe(false);
        expect(callBareFaces("channel", true, false)).toBe(false);
    });
});
