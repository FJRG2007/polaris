/**
 * Dragging a channel or a heading into a new position.
 *
 * One function, and the case worth having it for is moving something DOWN within
 * the list it is already in: the index of the row it was dropped on shifts once
 * the dragged one is taken out, so the naive version puts it one place short
 * every time. That is the bug this exists to not have.
 */

import { describe, expect, it } from "vitest";
import { reordered } from "../../src/app/(app)/chat/use-rail-drag";

const list = ["a", "b", "c", "d"];

describe("moving upwards", () => {
    it("goes above the row it was dropped on", () => {
        expect(reordered(list, "d", { at: "row", id: "b", after: false })).toEqual([
            "a",
            "d",
            "b",
            "c"
        ]);
    });

    it("goes below it when dropped on the lower half", () => {
        expect(reordered(list, "d", { at: "row", id: "b", after: true })).toEqual([
            "a",
            "b",
            "d",
            "c"
        ]);
    });
});

describe("moving downwards", () => {
    it("lands where it was dropped, not one short of it", () => {
        // The index of "c" is 2 in the original list and 1 once "a" is taken
        // out. Splicing at the original index would put "a" after "d".
        expect(reordered(list, "a", { at: "row", id: "c", after: false })).toEqual([
            "b",
            "a",
            "c",
            "d"
        ]);
        expect(reordered(list, "a", { at: "row", id: "c", after: true })).toEqual([
            "b",
            "c",
            "a",
            "d"
        ]);
    });
});

describe("dropping past the last row", () => {
    it("goes to the end", () => {
        expect(reordered(list, "a", { at: "end", categoryId: null })).toEqual(["b", "c", "d", "a"]);
    });

    it("adds one that was not in this list, which is a move between headings", () => {
        expect(reordered(list, "z", { at: "end", categoryId: null })).toEqual([
            "a",
            "b",
            "c",
            "d",
            "z"
        ]);
    });
});

describe("a row that is not in the list", () => {
    it("is dropped at the end rather than lost", () => {
        // Can happen when a heading's contents changed under a drag that was
        // already in flight. Appending is the answer that keeps the channel.
        expect(reordered(list, "a", { at: "row", id: "gone", after: false })).toEqual([
            "b",
            "c",
            "d",
            "a"
        ]);
    });
});

describe("dropping something on itself", () => {
    it("changes nothing", () => {
        expect(reordered(list, "b", { at: "row", id: "b", after: false })).toEqual(list);
    });
});
