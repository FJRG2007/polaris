/**
 * What the slides editor writes, and what its undo takes back.
 *
 * Pinned because both failed in front of somebody: a box dragged on this screen
 * did not move on this screen (the redraw counter never changed for a tab's
 * own writes), and one Ctrl+Z after a few quick edits took the whole slide with
 * it (changes close together were folded into one step).
 */

import * as Y from "yjs";
import * as deck from "@/lib/office/deck";
import { describe, expect, it } from "vitest";
import * as edits from "@/app/(app)/office/p/[id]/deck-edits";

function frameOf(doc: Y.Doc, slideId: string, boxId: string): deck.BoxFrame | undefined {
    const box = edits.boxesOf(doc).get(deck.boxKey(slideId, boxId));
    return box && { x: box.x, y: box.y, w: box.w, h: box.h };
}

describe("undo in the slides editor", () => {
    it("takes back one change at a time, however quickly they came", () => {
        const doc = new Y.Doc();
        const history = edits.deckUndoManager(doc);
        const slide = edits.addSlide(doc, 0);
        const before = frameOf(doc, slide, "title");
        edits.setFrame(doc, slide, "title", { x: 0.3, y: 0.3, w: 0.4, h: 0.2 });
        edits.updateBox(doc, slide, "title", { text: "Plan" });

        history.undo();
        expect(edits.boxesOf(doc).get(deck.boxKey(slide, "title"))?.text).toBe("");
        expect(frameOf(doc, slide, "title")).toEqual({ x: 0.3, y: 0.3, w: 0.4, h: 0.2 });

        history.undo();
        expect(frameOf(doc, slide, "title")).toEqual(before);
        expect(edits.slidesOf(doc).length).toBe(1);

        history.redo();
        expect(frameOf(doc, slide, "title")).toEqual({ x: 0.3, y: 0.3, w: 0.4, h: 0.2 });
    });

    it("never takes back somebody else's change", () => {
        const mine = new Y.Doc();
        const theirs = new Y.Doc();
        const history = edits.deckUndoManager(mine);
        const slide = edits.addSlide(mine, 0);
        Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));

        edits.updateBox(theirs, slide, "title", { text: "Theirs" });
        Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs), "remote");

        history.undo();
        // Undoing my one change - the slide - removes it; their words were
        // never mine to take back, and nothing of mine is left to undo.
        expect(edits.slidesOf(mine).length).toBe(0);
        expect(history.undoStack.length).toBe(0);
    });

    it("writes nothing for a change that changes nothing", () => {
        const doc = new Y.Doc();
        const history = edits.deckUndoManager(doc);
        const slide = edits.addSlide(doc, 0);
        const frame = frameOf(doc, slide, "title");
        if (!frame) throw new Error("no title");
        let updates = 0;
        doc.on("update", () => (updates += 1));
        edits.setFrame(doc, slide, "title", frame);
        edits.updateBox(doc, slide, "title", { text: "" });
        expect(updates).toBe(0);
        expect(history.undoStack.length).toBe(1);
    });
});

describe("the slide list", () => {
    function deckOf(count: number): { doc: Y.Doc; ids: string[] } {
        const doc = new Y.Doc();
        const ids = Array.from({ length: count }, (_, at) => edits.addSlide(doc, at));
        return { doc, ids };
    }
    const order = (doc: Y.Doc) =>
        edits
            .slidesOf(doc)
            .toArray()
            .map((one) => one.id);

    it("moves a slide to where it is dropped, keeping its boxes", () => {
        const { doc, ids } = deckOf(4);
        edits.moveSlide(doc, 0, 2);
        expect(order(doc)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
        edits.moveSlide(doc, 3, 0);
        expect(order(doc)).toEqual([ids[3], ids[1], ids[2], ids[0]]);
        expect(edits.boxesOf(doc).get(deck.boxKey(ids[0] ?? "", "title"))).toBeDefined();
    });

    it("does nothing for a move that goes nowhere or off the end", () => {
        const { doc, ids } = deckOf(2);
        let updates = 0;
        doc.on("update", () => (updates += 1));
        edits.moveSlide(doc, 1, 1);
        edits.moveSlide(doc, 5, 0);
        expect(updates).toBe(0);
        edits.moveSlide(doc, 0, 9);
        expect(order(doc)).toEqual([ids[1], ids[0]]);
    });

    it("removes a slide with its boxes, and one undo brings both back", () => {
        const { doc, ids } = deckOf(2);
        const history = edits.deckUndoManager(doc);
        const gone = ids[0] ?? "";
        edits.removeSlide(doc, gone);
        expect(order(doc)).toEqual([ids[1]]);
        expect(edits.boxesOf(doc).get(deck.boxKey(gone, "title"))).toBeUndefined();
        expect(edits.boxesOf(doc).get(deck.boxKey(ids[1] ?? "", "title"))).toBeDefined();
        history.undo();
        expect(order(doc)).toEqual(ids);
        expect(edits.boxesOf(doc).get(deck.boxKey(gone, "title"))).toBeDefined();
    });
});

describe("formatting, the stack, notes and pictures", () => {
    function oneSlide(): { doc: Y.Doc; slide: string } {
        const doc = new Y.Doc();
        return { doc, slide: edits.addSlide(doc, 0) };
    }
    const read = (doc: Y.Doc, slide: string, id: string) =>
        deck.readBox(edits.boxesOf(doc).get(deck.boxKey(slide, id)));

    it("puts every new box on top of the ones already there", () => {
        const { doc, slide } = oneSlide();
        const first = edits.addBox(doc, slide, "shape", "ellipse");
        const second = edits.addBox(doc, slide, "text");
        expect(read(doc, slide, second).z).toBeGreaterThan(read(doc, slide, first).z);
        expect(read(doc, slide, first).shape).toBe("ellipse");
    });

    it("brings a box to the front as one step back", () => {
        const { doc, slide } = oneSlide();
        const a = edits.addBox(doc, slide, "text");
        const b = edits.addBox(doc, slide, "text");
        const history = edits.deckUndoManager(doc);
        edits.arrangeBox(doc, slide, a, "front");
        const order = () =>
            deck.boxesOn(slide, new Map(edits.boxesOf(doc).entries())).map((box) => box.id);
        expect(order().at(-1)).toBe(a);
        history.undo();
        expect(order().at(-1)).toBe(b);
    });

    it("writes nothing for formatting a box already has", () => {
        const { doc, slide } = oneSlide();
        let updates = 0;
        doc.on("update", () => (updates += 1));
        // The title box an older editor wrote has no bold field at all.
        edits.updateBox(doc, slide, "title", { bold: false, list: "none" });
        expect(updates).toBe(0);
        edits.updateBox(doc, slide, "title", { bold: true });
        expect(updates).toBe(1);
        expect(read(doc, slide, "title").bold).toBe(true);
    });

    it("works out a change for each box it reaches, as one step", () => {
        const { doc, slide } = oneSlide();
        const plain = edits.addBox(doc, slide, "shape", "rect");
        const red = edits.addBox(doc, slide, "shape", "rect");
        edits.updateBox(doc, slide, red, { stroke: "#ff0000" });
        const history = edits.deckUndoManager(doc);
        edits.updateBoxes(doc, slide, [plain, red], (box) => ({
            strokeWidth: 0.01,
            ...(box.stroke ? {} : { stroke: deck.LINE_STROKE })
        }));
        expect(read(doc, slide, plain).stroke).toBe(deck.LINE_STROKE);
        expect(read(doc, slide, red).stroke).toBe("#ff0000");
        expect(read(doc, slide, red).strokeWidth).toBe(0.01);
        history.undo();
        expect(read(doc, slide, plain).stroke).toBe("");
        expect(read(doc, slide, red).strokeWidth).not.toBe(0.01);
    });

    it("keeps notes apart from the slide, and takes them with a copy", () => {
        const { doc, slide } = oneSlide();
        const [one] = edits.slidesOf(doc).toArray();
        edits.setNotes(doc, one!, "Say hello");
        expect(edits.notesOf(doc).get(slide)).toBe("Say hello");
        const copy = edits.duplicateSlide(doc, slide, 0);
        expect(edits.notesOf(doc).get(copy)).toBe("Say hello");
        edits.removeSlide(doc, slide);
        expect(edits.notesOf(doc).get(slide)).toBeUndefined();
    });

    it("keeps a picture once and lets the box name it", () => {
        const { doc, slide } = oneSlide();
        const id = edits.addImage(doc, slide, "data:image/webp;base64,AAAA", {
            x: 0.2,
            y: 0.2,
            w: 0.3,
            h: 0.3
        });
        const box = read(doc, slide, id);
        expect(box.src.startsWith(deck.IMAGE_PREFIX)).toBe(true);
        expect(edits.imageSource(doc, box.src)).toBe("data:image/webp;base64,AAAA");
        // Moving it sends a few numbers, not the picture again.
        let size = 0;
        doc.on("update", (update: Uint8Array) => (size = update.length));
        edits.setFrame(doc, slide, id, { x: 0.4, y: 0.4, w: 0.3, h: 0.3 });
        expect(size).toBeLessThan(400);
    });

    it("moves a pasted picture into the store, in one step", () => {
        const { doc, slide } = oneSlide();
        const history = edits.deckUndoManager(doc);
        const pasted = { ...deck.newBox("image", "p"), src: "data:image/png;base64,BBBB" };
        edits.pasteBoxes(doc, slide, [pasted]);
        const box = read(doc, slide, "p");
        expect(box.src.startsWith(deck.IMAGE_PREFIX)).toBe(true);
        expect(edits.imageSource(doc, box.src)).toBe("data:image/png;base64,BBBB");
        history.undo();
        expect(edits.boxesOf(doc).get(deck.boxKey(slide, "p"))).toBeUndefined();
        expect(edits.imagesOf(doc).size).toBe(0);
    });

    it("lets a picture go with the last box that shows it, and undo brings it back", () => {
        const { doc, slide } = oneSlide();
        const frame = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
        const id = edits.addImage(doc, slide, "data:image/webp;base64,AAAA", frame);
        const copy = edits.duplicateSlide(doc, slide, 0);
        const history = edits.deckUndoManager(doc);
        edits.removeBoxes(doc, slide, [id]);
        expect(edits.imagesOf(doc).size).toBe(1);
        edits.removeSlide(doc, copy);
        expect(edits.imagesOf(doc).size).toBe(0);
        history.undo();
        expect(edits.imagesOf(doc).size).toBe(1);
        history.undo();
        expect(edits.imageSource(doc, read(doc, slide, id).src)).toBe(
            "data:image/webp;base64,AAAA"
        );
    });

    it("names a picture the deck already keeps when a copy of it is pasted", () => {
        const { doc, slide } = oneSlide();
        const data = "data:image/png;base64,BBBB";
        const id = edits.addImage(doc, slide, data, { x: 0.2, y: 0.2, w: 0.3, h: 0.3 });
        edits.pasteBoxes(doc, slide, [{ ...deck.newBox("image", "p"), src: data }]);
        expect(edits.imagesOf(doc).size).toBe(1);
        expect(read(doc, slide, "p").src).toBe(read(doc, slide, id).src);
    });

    it("keeps a flat line flat when it is moved", () => {
        const { doc, slide } = oneSlide();
        const id = edits.addBox(doc, slide, "shape", "line");
        edits.setFrame(doc, slide, id, {
            x: 0.1,
            y: 0.5,
            w: 0.4,
            h: 0,
            flip: false,
            reversed: true
        });
        const line = read(doc, slide, id);
        expect(line.h).toBe(0);
        expect(line.reversed).toBe(true);
    });
});
