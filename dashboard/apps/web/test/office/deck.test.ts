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
        expect(
            deck.deckText(
                [
                    { id: "s1", notes: "" },
                    { id: "s2", notes: "" }
                ],
                boxes
            )
        ).toEqual(["The plan\nThree parts", "The first"]);
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

describe("pulling a grip", () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

    it("keeps the opposite side where it was", () => {
        const grown = deck.resizeFrame(start, "se", 0.1, 0.05);
        expect(grown.x).toBeCloseTo(0.2);
        expect(grown.y).toBeCloseTo(0.2);
        expect(grown.w).toBeCloseTo(0.5);
        expect(grown.h).toBeCloseTo(0.45);

        const fromLeft = deck.resizeFrame(start, "w", -0.1, 0.3);
        expect(fromLeft.x).toBeCloseTo(0.1);
        expect(fromLeft.w).toBeCloseTo(0.5);
        // A side grip changes one dimension, whatever the pointer did across.
        expect(fromLeft.h).toBeCloseTo(0.4);
        expect(fromLeft.y).toBeCloseTo(0.2);
    });

    it("stops a moving side at the edge rather than sliding the box", () => {
        // Clamping afterwards would push the whole box left, which reads as the
        // box running away from the pointer.
        const pulled = deck.resizeFrame(start, "e", 5, 0);
        expect(pulled.x).toBeCloseTo(0.2);
        expect(pulled.w).toBeCloseTo(0.8);
    });

    it("never shrinks a box past something that can be grabbed again", () => {
        const crushed = deck.resizeFrame(start, "nw", 2, 2);
        expect(crushed.w).toBeCloseTo(deck.SMALLEST);
        expect(crushed.h).toBeCloseTo(deck.SMALLEST);
        // Its far corner stays put.
        expect(crushed.x + crushed.w).toBeCloseTo(0.6);
        expect(crushed.y + crushed.h).toBeCloseTo(0.6);
    });

    it("keeps the proportions with Shift, by the larger pull", () => {
        const kept = deck.resizeFrame({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, "se", 0.2, 0.01, {
            keepRatio: true
        });
        expect(kept.w / kept.h).toBeCloseTo(2);
        expect(kept.w).toBeCloseTo(0.4);
    });

    it("keeps the proportions within the slide, too", () => {
        const kept = deck.resizeFrame({ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, "se", 1, 1, {
            keepRatio: true
        });
        expect(kept.w / kept.h).toBeCloseTo(2);
        expect(kept.x + kept.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(kept.y + kept.h).toBeLessThanOrEqual(1 + 1e-9);
    });

    it("grows both ways from the middle with Alt", () => {
        const both = deck.resizeFrame(start, "e", 0.05, 0, { fromCenter: true });
        expect(both.w).toBeCloseTo(0.5);
        expect(both.x + both.w / 2).toBeCloseTo(0.4);
    });
});

describe("nudging with the arrows", () => {
    it("moves the same distance on screen across and down", () => {
        const right = deck.nudgeFrame({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 1, 0, false);
        const down = deck.nudgeFrame({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 0, 1, false);
        // A fraction of a 16:9 slide's height is a shorter distance than the
        // same fraction of its width.
        expect((right.x - 0.5) * deck.SLIDE_RATIO).toBeCloseTo(down.y - 0.5);
    });

    it("goes ten times as far with Shift, and stops at the edge", () => {
        const far = deck.nudgeFrame({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, -1, 0, true);
        expect(0.5 - far.x).toBeCloseTo(deck.NUDGE * 10);
        expect(deck.nudgeFrame({ x: 0, y: 0, w: 0.1, h: 0.1 }, -1, -1, true)).toMatchObject({
            x: 0,
            y: 0
        });
    });
});

describe("copying boxes", () => {
    it("puts a copy visibly beside its original, as a new box", () => {
        const original = box({ id: "a", version: 7, x: 0.2, y: 0.2, w: 0.3, h: 0.2 });
        const copy = deck.copyOf(original, "b");
        expect(copy.id).toBe("b");
        expect(copy.version).toBe(1);
        expect(copy.x).toBeGreaterThan(original.x);
        expect(copy.y).toBeGreaterThan(original.y);
    });

    it("reads back what it wrote, with new ids", () => {
        const original = box({ id: "a", text: "Hello", version: 4 });
        let next = 0;
        const pasted = deck.readClipboard(deck.writeClipboard([original]), () => `n${++next}`);
        expect(pasted).toEqual([{ ...original, id: "n1", version: 1 }]);
    });

    it("refuses anything off the clipboard that is not exactly boxes", () => {
        const id = () => "x";
        expect(deck.readClipboard("not json", id)).toEqual([]);
        expect(deck.readClipboard(JSON.stringify({ boxes: [] }), id)).toEqual([]);
        expect(deck.readClipboard(JSON.stringify({ boxes: [{ kind: "text" }] }), id)).toEqual([]);
        const written = JSON.parse(deck.writeClipboard([box()])) as {
            boxes: Record<string, unknown>[];
        };
        const hostile = {
            boxes: [{ ...written.boxes[0], kind: "image", src: "javascript:alert(1)" }]
        };
        expect(deck.readClipboard(JSON.stringify(hostile), id)).toEqual([]);
        const offSlide = { boxes: [{ ...written.boxes[0], x: 4 }] };
        expect(deck.readClipboard(JSON.stringify(offSlide), id)).toEqual([]);
    });
});

describe("every slide's boxes at once", () => {
    it("groups them by slide in the order they were added", () => {
        const grouped = deck.groupBySlide(
            new Map([
                [deck.boxKey("s1", "a"), box({ id: "a" })],
                [deck.boxKey("s2", "c"), box({ id: "c" })],
                [deck.boxKey("s1", "b"), box({ id: "b" })],
                ["stray", box({ id: "z" })]
            ])
        );
        expect(grouped.get("s1")?.map((one) => one.id)).toEqual(["a", "b"]);
        expect(grouped.get("s2")?.map((one) => one.id)).toEqual(["c"]);
        expect(grouped.size).toBe(2);
    });
});
