/**
 * Where a call rings, on the card that says who is calling.
 *
 * "Ana is calling" is all a one-to-one needs. From a group it is half the
 * question: answering puts you in front of everybody in it.
 */

import { describe, expect, it } from "vitest";

const { whereLine } = await import("@/lib/chat/call-place");

describe("the line under who is calling", () => {
    it("says nothing more for a one-to-one", () => {
        expect(whereLine(undefined)).toBeNull();
    });

    it("names the group when it has a name", () => {
        expect(whereLine({ name: "Marketplace", size: 4 })).toBe("in Marketplace");
    });

    it("says how many are in it when nobody named it", () => {
        expect(whereLine({ name: null, size: 4 })).toBe("in a group of 4");
        expect(whereLine({ name: null, size: 0 })).toBe("in a group");
    });
});
