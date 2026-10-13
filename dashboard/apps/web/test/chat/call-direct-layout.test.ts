/**
 * How a call in a direct message is laid out around a stream.
 *
 * A watched stream is a tile among the people, the size of a face, the way
 * every voice client draws a call between a few people - not the whole band,
 * which left nobody on screen but the picture. Asking for it by name gives it
 * the band; expanded, the people are a row under it.
 */

import { describe, expect, it } from "vitest";
import { callBandHeight, directLayout } from "@/app/(app)/chat/call-band";

describe("a stream in a direct message's call", () => {
    it("leaves the people where they are while nothing is watched", () => {
        expect(directLayout(false, false, false)).toBe("people");
        expect(directLayout(false, true, false)).toBe("people");
    });

    it("is a tile among the people while it is watched", () => {
        expect(directLayout(true, false, false)).toBe("people");
        expect(directLayout(true, true, false)).toBe("people");
    });

    it("takes the band alone when asked for by name", () => {
        expect(directLayout(true, false, true)).toBe("stream");
    });

    it("has the people in a row under it once the call is expanded", () => {
        expect(directLayout(true, true, true)).toBe("stream-over-people");
    });
});

describe("an expanded call", () => {
    it("takes the whole column in a direct message, staged or not", () => {
        expect(callBandHeight("direct", false, true)).toBe("flex-1");
        expect(callBandHeight("direct", true, true)).toBe("flex-1");
    });

    it("takes it in a channel as well, which is where it used to stop at the cap", () => {
        // The defect this pins down: a shared screen in a channel's call could be
        // made bigger only as far as the cap, and the next size up was the whole
        // display - so reading somebody's screen meant losing the call, the people
        // in it and the rest of Polaris.
        expect(callBandHeight("channel", false, true)).toBe("flex-1");
        expect(callBandHeight("channel", true, true)).toBe("flex-1");
    });

    it("leaves a voice room as it was, being the column already", () => {
        expect(callBandHeight("room", false, true)).toBe("flex-1");
        expect(callBandHeight("room", true, true)).toBe("flex-1");
    });

    it("changes nothing until somebody asks", () => {
        expect(callBandHeight("channel", false)).not.toBe("flex-1");
        expect(callBandHeight("direct", true)).not.toBe("flex-1");
    });
});
