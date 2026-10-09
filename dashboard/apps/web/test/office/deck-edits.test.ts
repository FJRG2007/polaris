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
