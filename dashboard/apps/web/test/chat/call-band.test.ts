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
import {
    callBandHeight,
    callBandLimit,
    callBandSize,
    callBareFaces
} from "@/app/(app)/chat/call-band";
import { storedPaneSize, writePaneSize } from "@/app/(app)/chat/pane-preferences";

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

describe("the same limit in pixels, for the divider", () => {
    const BOUNDS = { min: 140, max: 720 };

    it("is the share of the column the class holds the panel to", () => {
        // The defect this pins down: the divider was held to 720 while the class
        // stopped a direct call at two fifths of a 900px column, so everything
        // above 360 was a drag that moved nothing on the way out and nothing on
        // the way back, and said a height on screen that was not this one.
        expect(callBandLimit("direct", false, 900, BOUNDS)).toBe(
            Math.round(900 * (cap(callBandHeight("direct", false)) / 100))
        );
        expect(callBandLimit("channel", false, 900, BOUNDS)).toBe(
            Math.round(900 * (cap(callBandHeight("channel", false)) / 100))
        );
    });

    it("follows the screen somebody put up, exactly as the height does", () => {
        expect(callBandLimit("direct", true, 900, BOUNDS)).toBe(
            Math.round(900 * (cap(callBandHeight("direct", true)) / 100))
        );
        expect(callBandLimit("direct", true, 900, BOUNDS)).toBeGreaterThan(
            callBandLimit("direct", false, 900, BOUNDS)
        );
    });

    it("never hands back less than a call can be used at", () => {
        // A column too short for the smallest usable call is a reason to stop the
        // drag, not to hand the handle a ceiling under its own floor.
        expect(callBandLimit("direct", false, 200, BOUNDS)).toBe(BOUNDS.min);
    });

    it("holds a very tall column to the blunt limit", () => {
        expect(callBandLimit("channel", false, 4000, BOUNDS)).toBe(BOUNDS.max);
    });

    it("leaves the blunt limit where there is nothing to work from", () => {
        // Before the first measurement, and in a room, which has no share.
        expect(callBandLimit("direct", false, 0, BOUNDS)).toBe(BOUNDS.max);
        expect(callBandLimit("direct", false, Number.NaN, BOUNDS)).toBe(BOUNDS.max);
        expect(callBandLimit("room", false, 900, BOUNDS)).toBe(BOUNDS.max);
    });
});

describe("the height the call's divider is at", () => {
    // The same numbers the conversation uses for its call.
    const BAND = { min: 140, max: 720, fallback: 260 };

    it("is what somebody dragged it to, inside the limit", () => {
        expect(callBandSize(400, 300, 600, BAND)).toBe(400);
    });

    it("is the drawn height until somebody has dragged it", () => {
        expect(callBandSize(null, 300, 600, BAND)).toBe(300);
        expect(callBandSize(null, null, 600, BAND)).toBe(BAND.fallback);
    });

    it("never goes past the limit of the window it is in", () => {
        // A height kept from a taller window.
        expect(callBandSize(700, 300, 450, BAND)).toBe(450);
    });

    it("never goes under the floor, even in a column too short for it", () => {
        expect(callBandSize(40, 300, 600, BAND)).toBe(BAND.min);
        expect(callBandSize(400, 300, 90, BAND)).toBe(BAND.min);
        expect(callBandSize(Number.NaN, null, 600, BAND)).toBe(BAND.fallback);
    });

    it("comes back from this browser at the height it was left at, clamped", () => {
        const store = new Map<string, string>();
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: {
                localStorage: {
                    getItem: (key: string) => store.get(key) ?? null,
                    setItem: (key: string, value: string) => void store.set(key, value),
                    removeItem: (key: string) => void store.delete(key)
                }
            }
        });
        try {
            expect(storedPaneSize("call.direct", BAND)).toBeNull();
            writePaneSize("call.direct", 380);
            const kept = storedPaneSize("call.direct", BAND);
            expect(kept).toBe(380);
            expect(callBandSize(kept, 200, callBandLimit("direct", true, 1000, BAND), BAND)).toBe(
                380
            );
            // Kept apart from a channel's call, which is a different question.
            expect(storedPaneSize("call.channel", BAND)).toBeNull();
            writePaneSize("call.direct", 5000);
            expect(storedPaneSize("call.direct", BAND)).toBe(BAND.max);
        } finally {
            Reflect.deleteProperty(globalThis, "window");
        }
    });
});
