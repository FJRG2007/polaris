/**
 * What a slide's boxes look like and where they sit in the stack.
 *
 * Pinned around the things that go wrong without anybody noticing at first: a
 * box written by an older editor drawn differently after an update, a colour
 * from a hostile writer reaching a style, a line that changes direction when
 * one of its ends is pulled past the other, and a box brought to the front that
 * is not drawn on top.
 */

import * as deck from "@/lib/office/deck";
import { describe, expect, it } from "vitest";

describe("a box written before formatting existed", () => {
    it("reads with the defaults it was drawn with", () => {
        const old = {
            id: "a",
            kind: "text",
            x: 0.1,
            y: 0.2,
            w: 0.5,
            h: 0.1,
            text: "Hello",
            size: 0.06,
            color: "",
            fill: "",
            align: "left",
            src: "",
            version: 3
        };
        const box = deck.readBox(old);
        expect(box).toMatchObject({
            bold: false,
            italic: false,
            underline: false,
            valign: "top",
            list: "none",
            z: 0,
            version: 3,
            text: "Hello"
        });
    });

    it("keeps an old shape the violet rounded rectangle it always was", () => {
        const box = deck.readBox({ id: "s", kind: "shape", x: 0, y: 0, w: 0.3, h: 0.2, fill: "" });
        expect(box.shape).toBe("rounded");
        expect(box.fill).toBe(deck.SHAPE_FILL);
    });

    it("never lets anything but a colour reach a style", () => {
        const box = deck.readBox({
            id: "x",
            kind: "shape",
            shape: "rect",
            fill: "red; background: url(https://example.test/pixel)",
            color: "url(x)",
            stroke: "#12345g"
        });
        expect(box.fill).toBe(deck.SHAPE_FILL);
        expect(box.color).toBe("");
        expect(box.stroke).toBe("");
        expect(deck.readBox({ kind: "shape", shape: "rect", fill: "transparent" }).fill).toBe(
            "transparent"
        );
    });

    it("reads garbage as a harmless empty text box", () => {
        const box = deck.readBox("nonsense");
        expect(box.kind).toBe("text");
        expect(box.text).toBe("");
    });
});

describe("font sizes", () => {
    it("are points on a 540-point slide, and step by one within bounds", () => {
        expect(deck.pointsOf(deck.fractionOfPoints(32))).toBe(32);
        expect(deck.pointsOf(deck.stepPoints(deck.fractionOfPoints(32), 1))).toBe(33);
        expect(deck.pointsOf(deck.stepPoints(deck.fractionOfPoints(1), -1))).toBe(1);
        expect(deck.pointsOf(deck.stepPoints(deck.fractionOfPoints(400), 1))).toBe(400);
    });
});

describe("new shapes", () => {
    it("are square as seen, centred, and filled", () => {
        const box = deck.newBox("shape", "s", "ellipse");
        expect(box.w * deck.SLIDE_RATIO).toBeCloseTo(box.h);
        expect(box.x + box.w / 2).toBeCloseTo(0.5);
        expect(box.fill).toBe(deck.SHAPE_FILL);
        expect(deck.holdsText(box)).toBe(true);
    });

    it("make a line flat, outlined and wordless", () => {
        const line = deck.newBox("shape", "l", "line");
        expect(line.h).toBe(0);
        expect(line.stroke).not.toBe("");
        expect(deck.isLine(line)).toBe(true);
        expect(deck.holdsText(line)).toBe(false);
        // Kept flat when it is moved or copied.
        expect(deck.copyOf(line, "l2").h).toBe(0);
        expect(deck.nudgeFrame(line, 1, 0, false, deck.smallestFor(line)).h).toBe(0);
    });
});

describe("a line's ends", () => {
    it("come back in the order they were drawn, whichever way it points", () => {
        const cases = [
            [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.4 }],
            [{ x: 0.5, y: 0.4 }, { x: 0.1, y: 0.1 }],
            [{ x: 0.1, y: 0.6 }, { x: 0.7, y: 0.2 }],
            [{ x: 0.7, y: 0.2 }, { x: 0.1, y: 0.6 }],
            [{ x: 0.3, y: 0.2 }, { x: 0.3, y: 0.8 }],
            [{ x: 0.3, y: 0.8 }, { x: 0.3, y: 0.2 }],
            [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
            [{ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 }]
        ] as const;
        for (const [start, end] of cases) {
            const [a, b] = deck.lineEnds(deck.lineThrough(start, end));
            expect(a.x).toBeCloseTo(start.x);
            expect(a.y).toBeCloseTo(start.y);
            expect(b.x).toBeCloseTo(end.x);
            expect(b.y).toBeCloseTo(end.y);
        }
    });

    it("stay on the slide", () => {
        const frame = deck.lineThrough({ x: -1, y: 0.5 }, { x: 2, y: 0.5 });
        expect(frame.x).toBe(0);
        expect(frame.w).toBe(1);
    });

    it("snap to level, upright and diagonal as seen with Shift", () => {
        const level = deck.snapAngle({ x: 0.2, y: 0.5 }, { x: 0.6, y: 0.51 });
        expect(level.y).toBeCloseTo(0.5);
        // Forty-five degrees on a sixteen-by-nine slide: as far down as across,
        // in what the eye sees.
        const diagonal = deck.snapAngle({ x: 0, y: 0 }, { x: 0.2, y: 0.34 });
        expect((diagonal.x - 0) * deck.SLIDE_RATIO).toBeCloseTo(diagonal.y);
    });
});

describe("the stack", () => {
    const on = [
        { ...deck.newBox("text", "a"), z: 1 },
        { ...deck.newBox("text", "b"), z: 2 },
        { ...deck.newBox("text", "c"), z: 3 }
    ];
    const order = (changes: Map<string, number>) =>
        deck
            .stackOrder(on.map((box) => ({ ...box, z: changes.get(box.id) ?? box.z })))
            .map((box) => box.id);

    it("draws by place, and boxes from before the stack in the order they came", () => {
        const old = [deck.newBox("text", "x"), deck.newBox("text", "y")];
        expect(deck.stackOrder(old).map((box) => box.id)).toEqual(["x", "y"]);
        expect(deck.nextZ(on)).toBe(4);
    });

    it("moves a box to the front, the back, and one step at a time", () => {
        expect(order(deck.arrange(on, "a", "front"))).toEqual(["b", "c", "a"]);
        expect(order(deck.arrange(on, "c", "back"))).toEqual(["c", "a", "b"]);
        expect(order(deck.arrange(on, "a", "forward"))).toEqual(["b", "a", "c"]);
        expect(order(deck.arrange(on, "c", "backward"))).toEqual(["a", "c", "b"]);
    });

    it("writes nothing for a box already where it is asked to go", () => {
        expect(deck.arrange(on, "c", "front").size).toBe(0);
        expect(deck.arrange(on, "a", "backward").size).toBe(0);
        expect(deck.arrange(on, "missing", "front").size).toBe(0);
    });
});

describe("a picture as it is inserted", () => {
    it("keeps its proportions as seen, centred, within the slide", () => {
        const wide = deck.imageFrame(1920, 1080);
        expect(wide.w).toBeCloseTo(0.6);
        expect(wide.h).toBeCloseTo(0.6);
        const tall = deck.imageFrame(1000, 2000);
        expect(tall.h).toBeCloseTo(0.6);
        // Half as wide as it is tall, as seen.
        expect((tall.w * deck.SLIDE_RATIO) / tall.h).toBeCloseTo(0.5);
        expect(tall.x + tall.w / 2).toBeCloseTo(0.5);
    });
});

describe("formatting on the clipboard", () => {
    it("travels with the box", () => {
        const original = {
            ...deck.newBox("shape", "a", "triangle"),
            bold: true,
            list: "bullet" as const,
            stroke: "#000000",
            text: "Hi"
        };
        const [pasted] = deck.readClipboard(deck.writeClipboard([original]), () => "n");
        expect(pasted).toMatchObject({
            shape: "triangle",
            bold: true,
            list: "bullet",
            stroke: "#000000",
            text: "Hi",
            id: "n"
        });
    });

    it("turns a picture kept in the deck into the picture itself", () => {
        const image = { ...deck.newBox("image", "i"), src: `${deck.IMAGE_PREFIX}k1` };
        const written = deck.writeClipboard([image], () => "data:image/png;base64,AAAA");
        expect(JSON.parse(written).boxes[0].src).toBe("data:image/png;base64,AAAA");
    });

    it("refuses a colour that is not one", () => {
        const written = JSON.parse(deck.writeClipboard([deck.newBox("text", "a")])) as {
            boxes: Record<string, unknown>[];
        };
        const hostile = { boxes: [{ ...written.boxes[0], fill: "url(https://x.test)" }] };
        expect(deck.readClipboard(JSON.stringify(hostile), () => "n")).toEqual([]);
    });
});

describe("speaker notes", () => {
    it("come from the notes store, or from the slide in an older deck", () => {
        const slide = { id: "s1", notes: "old" };
        expect(deck.notesOf(slide, new Map())).toBe("old");
        expect(deck.notesOf(slide, new Map([["s1", "new"]]))).toBe("new");
        expect(deck.notesOf(slide, new Map([["s1", ""]]))).toBe("");
    });
});
