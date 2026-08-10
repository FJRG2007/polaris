/**
 * Holding the order a screen is in while somebody edits the work on it.
 *
 * The case that matters is the one people hit constantly: a board sorted by
 * priority, and a row whose priority just changed. The engine would move it; the
 * screen must not, because the person doing it is triaging and the next thing
 * they wanted was the row underneath. Everything else here is what has to keep
 * working around that - new work appearing, finished work leaving, and asking
 * for a different arrangement outright.
 */

import { describe, expect, it } from "vitest";
import { mergeOrder } from "../../src/app/(app)/tasks/stable-order";

describe("holding an arrangement", () => {
    it("takes the order it is given when it is holding none", () => {
        expect(mergeOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    it("leaves a row where it is when the sort would have moved it", () => {
        // "c" was raised to urgent, so the engine now sorts it to the top.
        expect(mergeOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["a", "b", "c"]);
    });

    it("drops work that is no longer on the screen", () => {
        expect(mergeOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
    });

    it("puts a new task among the neighbours it sorts next to", () => {
        // "n" sorts between "a" and "b", and lands there rather than at an end.
        expect(mergeOrder(["a", "b", "c"], ["a", "n", "b", "c"])).toEqual(["a", "n", "b", "c"]);
    });

    it("puts a new task at the top when that is where it sorts", () => {
        expect(mergeOrder(["a", "b"], ["n", "a", "b"])).toEqual(["n", "a", "b"]);
    });

    it("keeps held work in its own order when new work arrives around it", () => {
        // The engine wants c first; "a" and "b" are held so they stay as they
        // are, and the newcomer keeps the place the engine gave it.
        expect(mergeOrder(["a", "b"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
        expect(mergeOrder(["a", "b"], ["n", "a", "m", "b"])).toEqual(["n", "a", "m", "b"]);
    });

    it("puts a newcomer after the held work it sorts behind, held order winning", () => {
        // The engine would sort a, n, b; the screen is holding b before a, so
        // "goes after a" is the end of the screen. There is no place between two
        // rows the engine and the screen disagree about, and holding what is on
        // screen is the point of the whole thing.
        expect(mergeOrder(["b", "a"], ["a", "n", "b"])).toEqual(["b", "a", "n"]);
    });

    it("survives everything around a row leaving at once", () => {
        expect(mergeOrder(["a", "b", "c"], ["x", "c"])).toEqual(["x", "c"]);
    });

    it("changes nothing when asked twice, so a re-render is not a reshuffle", () => {
        const once = mergeOrder(["a", "b", "c"], ["c", "a", "b"]);
        expect(mergeOrder(once, ["c", "a", "b"])).toEqual(once);
    });

    it("holds an empty screen without inventing anything", () => {
        expect(mergeOrder(["a", "b"], [])).toEqual([]);
    });
});
