/**
 * Where a box on a slide lands.
 *
 * Positions are fractions of the slide rather than pixels, which is the whole
 * reason a deck made on a laptop is the same deck on a projector - and it is
 * also the thing that is easy to get wrong once and never notice, because on the
 * screen it was made on every arithmetic looks the same.
 *
 * The failures pinned here are the ones somebody meets in the first minute: a
 * box dragged off the edge and lost, a box resized to nothing and unrecoverable,
 * and two people editing the same box disagreeing about who won.
 */

import * as deck from "@/lib/office/deck";
import { describe, expect, it } from "vitest";

function box(over: Partial<deck.Box> = {}): deck.Box {
    return { ...deck.newBox("text", "b1"), ...over };
}

describe("keeping a box on the slide", () => {
    it("stops it at the edge rather than losing it", () => {
        // Dragging past the edge is something people do constantly, and the
        // useful answer is "it stopped", not "nothing happened".
        expect(deck.clampFrame({ x: -0.4, y: -0.2, w: 0.3, h: 0.2 })).toEqual({
            x: 0,
            y: 0,
            w: 0.3,
            h: 0.2
        });
    });

    it("stops it at the far edge too, by its own width", () => {
        const kept = deck.clampFrame({ x: 2, y: 2, w: 0.25, h: 0.5 });
        expect(kept.x).toBeCloseTo(0.75);
        expect(kept.y).toBeCloseTo(0.5);
    });

    it("never lets a box become too small to grab again", () => {
        const kept = deck.clampFrame({ x: 0.5, y: 0.5, w: 0, h: -1 });
        expect(kept.w).toBe(deck.SMALLEST);
        expect(kept.h).toBe(deck.SMALLEST);
    });

    it("leaves a box that is already on the slide alone", () => {
        const frame = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
        expect(deck.clampFrame(frame)).toEqual(frame);
    });
});

describe("two people editing one box", () => {
    it("keeps the later version", () => {
        expect(deck.laterBox(box({ version: 3 }), box({ version: 1 })).version).toBe(3);
        expect(deck.laterBox(box({ version: 1 }), box({ version: 3 })).version).toBe(3);
    });

    it("breaks a tie the same way whichever side asks", () => {
        const mine = box({ id: "a", version: 2 });
        const theirs = box({ id: "b", version: 2 });
        expect(deck.laterBox(mine, theirs).id).toBe("a");
        expect(deck.laterBox(theirs, mine).id).toBe("a");
    });
});

describe("which boxes are on which slide", () => {
    const boxes = new Map([
        [deck.boxKey("s1", "a"), box({ id: "a" })],
        [deck.boxKey("s1", "b"), box({ id: "b" })],
        [deck.boxKey("s2", "c"), box({ id: "c" })]
    ]);

    it("is the ones keyed to it", () => {
        expect(deck.boxesOn("s1", boxes).map((one) => one.id)).toEqual(["a", "b"]);
        expect(deck.boxesOn("s2", boxes).map((one) => one.id)).toEqual(["c"]);
    });

    it("is nothing for a slide with none", () => {
        expect(deck.boxesOn("s3", boxes)).toEqual([]);
    });

    it("reads a key back, including a slide id that has a colon in it", () => {
        expect(deck.readBoxKey(deck.boxKey("s:1", "b"))).toEqual({ slideId: "s:1", boxId: "b" });
        expect(deck.readBoxKey("nonsense")).toBeNull();
    });
});

describe("what a deck says", () => {
    it("is every slide's words, in order", () => {
        const boxes = new Map([
            [deck.boxKey("s1", "a"), box({ id: "a", text: "The plan" })],
            [deck.boxKey("s1", "b"), box({ id: "b", text: "Three parts" })],
            [deck.boxKey("s2", "c"), box({ id: "c", text: "The first" })]
        ]);
        expect(deck.deckText([{ id: "s1", notes: "" }, { id: "s2", notes: "" }], boxes)).toEqual([
            "The plan\nThree parts",
            "The first"
        ]);
    });

    it("says nothing for a slide nobody has written on", () => {
        expect(deck.deckText([{ id: "s1", notes: "" }], new Map())).toEqual([""]);
    });
});

describe("a new slide", () => {
    it("comes with somewhere to type, rather than as a blank rectangle", () => {
        // A slide with nothing on it and no obvious way in is where a deck stops
        // being made.
        const title = deck.titleBox("title");
        expect(title.kind).toBe("text");
        expect(title.align).toBe("center");
        expect(deck.clampFrame(title)).toEqual({
            x: title.x,
            y: title.y,
            w: title.w,
            h: title.h
        });
    });
});
