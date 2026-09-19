/**
 * How a call in a direct message is laid out around a stream.
 *
 * Pinned because it was drawn the other way once: a watched stream sat in a
 * column beside the people, in a band too short to give either of them a usable
 * size. In the band the stream is alone; expanded, the people are a row under
 * it; and asking for the stream by name takes the call whole either way.
 */

import { describe, expect, it } from "vitest";
import { callBandHeight, directLayout } from "@/app/(app)/chat/call-band";

describe("a stream in a direct message's call", () => {
    it("leaves the people where they are while nothing is watched", () => {
        expect(directLayout(false, false, false)).toBe("people");
        expect(directLayout(false, true, false)).toBe("people");
    });

    it("is shown alone in the band", () => {
        expect(directLayout(true, false, false)).toBe("stream");
        expect(directLayout(true, false, true)).toBe("stream");
    });

    it("has the people in a row under it once the call is expanded", () => {
        expect(directLayout(true, true, false)).toBe("stream-over-people");
    });

    it("takes the expanded call whole when asked for by name", () => {
        expect(directLayout(true, true, true)).toBe("stream");
    });
});

describe("an expanded call", () => {
    it("takes the whole column in a direct message, staged or not", () => {
        expect(callBandHeight("direct", false, true)).toBe("flex-1");
        expect(callBandHeight("direct", true, true)).toBe("flex-1");
    });

    it("changes nothing anywhere else", () => {
        expect(callBandHeight("channel", false, true)).toBe(callBandHeight("channel", false));
        expect(callBandHeight("room", false, true)).toBe("flex-1");
    });
});
