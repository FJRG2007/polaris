/**
 * How a call in a direct message is laid out around a stream.
 *
 * A watched stream fills the call with the people in a row under it, from the
 * moment it starts; asked for by name it has the call alone. Whether the call
 * has been expanded changes how much of the column that is, not the shape.
 */

import { describe, expect, it } from "vitest";
import { callBandHeight, directLayout } from "@/app/(app)/chat/call-band";

describe("a stream in a direct message's call", () => {
    it("leaves the people where they are while nothing is watched", () => {
        expect(directLayout(false, false)).toBe("people");
        expect(directLayout(false, true)).toBe("people");
    });

    it("fills the call with the people under it while it is watched", () => {
        expect(directLayout(true, false)).toBe("stream-over-people");
    });

    it("takes the call alone when asked for by name", () => {
        expect(directLayout(true, true)).toBe("stream");
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
