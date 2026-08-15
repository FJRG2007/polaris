/**
 * Where the keyboard cursor lands.
 *
 * Small, and worth having anyway: this is the function with the off-by-one in
 * it, and the failures are the quiet kind - a cursor that skips the first row,
 * or that wraps from the bottom to the top and loses somebody's place in a list
 * of forty.
 */

import { describe, expect, it } from "vitest";
import { nextCursor } from "@/app/(app)/tasks/views/row-cursor";

const rows = ["a", "b", "c"];

describe("moving the cursor", () => {
    it("starts at the first row going down, and at the last going up", () => {
        expect(nextCursor(rows, null, 1)).toBe("a");
        expect(nextCursor(rows, null, -1)).toBe("c");
    });

    it("moves one row at a time", () => {
        expect(nextCursor(rows, "a", 1)).toBe("b");
        expect(nextCursor(rows, "b", -1)).toBe("a");
    });

    it("stops at either end rather than wrapping", () => {
        expect(nextCursor(rows, "c", 1)).toBe("c");
        expect(nextCursor(rows, "a", -1)).toBe("a");
    });

    it("has nowhere to go in an empty list", () => {
        expect(nextCursor([], null, 1)).toBeNull();
        expect(nextCursor([], "a", 1)).toBeNull();
    });

    it("treats a row that is no longer on screen as nowhere", () => {
        // What a filter change looks like: the cursor was on a row the view
        // stopped drawing, and the next press has to land somewhere real.
        expect(nextCursor(rows, "gone", 1)).toBe("a");
        expect(nextCursor(rows, "gone", -1)).toBe("c");
    });
});
