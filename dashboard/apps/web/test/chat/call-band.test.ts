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
import { callBandHeight } from "@/app/(app)/chat/call-band";

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
