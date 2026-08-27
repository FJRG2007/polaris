/**
 * Where a row dropped on another row actually lands.
 *
 * The gesture people make is "put this one here", and until now every list in
 * Tasks answered it with "put this one above whatever you let go of" - so
 * dragging a task down onto the one below it moved nothing, and dragging it to
 * the bottom of a column left it second from last. The half of the row the
 * pointer is in is what decides.
 */

import { describe, expect, it } from "vitest";
import { arrangeAround } from "@polaris/core";
import { dropEdge, neighbours } from "@/app/(app)/tasks/drop-edge";

const ROWS = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

/** The sequence a drop leaves behind, which is what somebody sees. */
function landing(dragged: string, target: string, edge: "before" | "after"): string[] {
    return arrangeAround(
        ROWS.map((row) => row.id),
        dragged,
        neighbours(ROWS, target, dragged, edge)
    );
}

function box(top: number, height: number): Element {
    return {
        getBoundingClientRect: () => ({ top, height, bottom: top + height }) as DOMRect
    } as Element;
}

describe("which side of a row a drop landed on", () => {
    it("reads the top half as above it and the bottom half as below it", () => {
        const row = box(100, 40);
        expect(dropEdge(101, row)).toBe("before");
        expect(dropEdge(119, row)).toBe("before");
        expect(dropEdge(120, row)).toBe("after");
        expect(dropEdge(139, row)).toBe("after");
    });
});

describe("where a row dropped on another one lands", () => {
    it("puts it under the row it was released over, dragging downwards", () => {
        expect(landing("a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    });

    it("puts it over the row it was released over, dragging upwards", () => {
        expect(landing("d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    });

    it("reaches the end of the list, which the old always-above drop could not", () => {
        expect(landing("a", "d", "after")).toEqual(["b", "c", "d", "a"]);
    });

    it("reaches the top of the list", () => {
        expect(landing("c", "a", "before")).toEqual(["c", "a", "b", "d"]);
    });

    it("moves a row down by exactly one place", () => {
        // The case that used to be a no-op: b's own place is what "above c"
        // means once b has been taken out of the sequence.
        expect(landing("b", "c", "before")).toEqual(["a", "b", "c", "d"]);
        expect(landing("b", "c", "after")).toEqual(["a", "c", "b", "d"]);
    });

    it("never names the dragged row as its own neighbour", () => {
        expect(neighbours(ROWS, "b", "a", "before")).toEqual({ beforeId: null, afterId: "b" });
        expect(neighbours(ROWS, "b", "c", "after")).toEqual({ beforeId: "b", afterId: "d" });
    });

    it("says nothing when the row it landed on is not in the list", () => {
        expect(neighbours(ROWS, "gone", "a", "after")).toEqual({ beforeId: null, afterId: null });
    });
});
