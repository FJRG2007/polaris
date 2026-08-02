import { describe, expect, it } from "vitest";
import { columnOf, type CapturedLayout } from "../src/components/bone-skeleton";

/** One capture, from bones laid out as [x%, y, width%, height, radius]. */
function capture(width: number, bones: number[][]): CapturedLayout {
    return { width, height: 400, bones };
}

describe("the width a route skeleton is drawn at", () => {
    it("recovers a centred column in pixels, so it does not stretch on a wide screen", () => {
        // /settings as recorded: a max-w-2xl column in a 982px content area.
        const column = columnOf(capture(982, [[15.78, 0, 31.2, 28, 8], [15.78, 76, 68.44, 403, 12]]));
        expect(column?.width).toBe(672);
    });

    it("re-bases the bones onto that column, so the leftmost one starts at its edge", () => {
        const column = columnOf(capture(982, [[15.78, 0, 31.2, 28, 8], [15.78, 76, 68.44, 403, 12]]));
        const left = ((15.78 - column!.left) / column!.span) * 100;
        const width = (68.44 / column!.span) * 100;
        expect(left).toBeCloseTo(0, 5);
        expect(width).toBeCloseTo(100, 5);
    });

    it("leaves a screen that fills its content area on percentages", () => {
        expect(columnOf(capture(992, [[0, 0, 100, 28, 8], [0, 76, 100, 300, 12]]))).toBeNull();
    });

    it("leaves a screen that is only narrow because of its content on percentages", () => {
        // A grid with one card in it: half the width, and against the left edge
        // rather than centred, so it follows the width it is given like the card does.
        expect(columnOf(capture(992, [[0, 0, 51, 28, 8]]))).toBeNull();
    });

    it("treats a column captured on a viewport it already filled as full width", () => {
        // The same page at 375: the column is wider than the phone, so nothing to recover.
        expect(columnOf(capture(341, [[0, 0, 100, 28, 8], [0, 76, 100, 300, 12]]))).toBeNull();
    });

    it("has nothing to recover from an empty capture", () => {
        expect(columnOf(capture(992, []))).toBeNull();
    });
});
