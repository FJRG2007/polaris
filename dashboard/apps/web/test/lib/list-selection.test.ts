/**
 * Picking rows out of a list.
 *
 * These three gestures are muscle memory from the desktop, which means nobody
 * reads a hint and everybody notices when they are wrong - a shift that extends
 * from the wrong row leaves a trail of selected rows behind the pointer, and the
 * person doing it deletes something they never chose.
 */

import { describe, expect, it } from "vitest";
import { afterClick, afterMove, focusAfterMove, rangeBetween, toggled } from "@/lib/list-selection";

const KEYS = ["a", "b", "c", "d", "e"];

describe("a click", () => {
    it("selects just that row on its own", () => {
        const state = afterClick(new Set(["a", "b"]), KEYS, 3, 0, {});
        expect([...state.selected]).toEqual(["d"]);
        expect(state.anchor).toBe(3);
    });

    it("adds and removes with ctrl, and moves the anchor to what was touched", () => {
        const added = afterClick(new Set(["a"]), KEYS, 2, 0, { ctrlKey: true });
        expect([...added.selected].sort()).toEqual(["a", "c"]);
        expect(added.anchor).toBe(2);
        expect([...afterClick(added.selected, KEYS, 2, 2, { metaKey: true }).selected]).toEqual(["a"]);
    });

    it("takes everything between the anchor and the row with shift", () => {
        const state = afterClick(new Set(["b"]), KEYS, 3, 1, { shiftKey: true });
        expect([...state.selected]).toEqual(["b", "c", "d"]);
    });

    it("extends the same range rather than leaving the last one behind", () => {
        const first = afterClick(new Set(["b"]), KEYS, 4, 1, { shiftKey: true });
        const shrunk = afterClick(first.selected, KEYS, 2, first.anchor, { shiftKey: true });
        expect([...shrunk.selected]).toEqual(["b", "c"]);
        expect(shrunk.anchor).toBe(1);
    });

    it("reaches backwards as readily as forwards", () => {
        expect([...afterClick(new Set(), KEYS, 0, 3, { shiftKey: true }).selected]).toEqual(["a", "b", "c", "d"]);
    });

    it("leaves the selection alone when the row is not there", () => {
        expect([...afterClick(new Set(["a"]), KEYS, 9, 0, {}).selected]).toEqual(["a"]);
    });
});

describe("an arrow key", () => {
    it("carries the selection one row at a time", () => {
        const state = afterMove(new Set(["a"]), KEYS, 0, 0, 1, false);
        expect([...state.selected]).toEqual(["b"]);
        expect(state.cursor).toBe(1);
    });

    it("grows a block while shift is held", () => {
        const one = afterMove(new Set(["b"]), KEYS, 1, 1, 1, true);
        const two = afterMove(one.selected, KEYS, one.cursor, one.anchor, 1, true);
        expect([...two.selected]).toEqual(["b", "c", "d"]);
        expect(two.anchor).toBe(1);
    });

    it("stops at both ends instead of wrapping", () => {
        expect(afterMove(new Set(), KEYS, 4, 4, 1, false).cursor).toBe(4);
        expect(afterMove(new Set(), KEYS, 0, 0, -1, false).cursor).toBe(0);
    });

    it("starts at the near end when nothing has been touched yet", () => {
        expect(afterMove(new Set(), KEYS, null, null, 1, false).cursor).toBe(0);
        expect(afterMove(new Set(), KEYS, null, null, -1, false).cursor).toBe(4);
    });

    it("does nothing to an empty list", () => {
        expect([...afterMove(new Set(), [], null, null, 1, false).selected]).toEqual([]);
    });
});

describe("a list that holds one row", () => {
    it("starts at the near end whichever way the first press went", () => {
        expect(focusAfterMove(KEYS, null, 1)).toBe("a");
        expect(focusAfterMove(KEYS, null, -1)).toBe("e");
    });

    it("walks one at a time and stops at both ends", () => {
        expect(focusAfterMove(KEYS, "b", 1)).toBe("c");
        expect(focusAfterMove(KEYS, "e", 1)).toBe("e");
        expect(focusAfterMove(KEYS, "a", -1)).toBe("a");
    });

    it("treats a row that is no longer there as nothing focused", () => {
        expect(focusAfterMove(KEYS, "gone", 1)).toBe("a");
    });

    it("has nowhere to go in an empty list", () => {
        expect(focusAfterMove([], null, 1)).toBeNull();
    });
});

describe("the pieces", () => {
    it("counts a range from either direction and clamps it to the list", () => {
        expect([...rangeBetween(KEYS, 3, 1)]).toEqual(["b", "c", "d"]);
        expect([...rangeBetween(KEYS, -4, 1)]).toEqual(["a", "b"]);
        expect([...rangeBetween(KEYS, 3, 99)]).toEqual(["d", "e"]);
    });

    it("toggles without touching the set it was given", () => {
        const before = new Set(["a"]);
        expect([...toggled(before, "b")].sort()).toEqual(["a", "b"]);
        expect([...before]).toEqual(["a"]);
    });
});
