"use client";

/**
 * Every change the slides editor makes to the shared deck, and the history that
 * takes them back.
 *
 * Each change is one transaction tagged `LOCAL`, which is what the history
 * listens to: a change that arrived from somebody else is never something this
 * tab's Ctrl+Z takes back - the same rule Google Slides and Figma follow, and
 * the one Yjs' `UndoManager` is built for (tracked origins). A drag is one
 * transaction on release rather than one per pointer move, so it is one step
 * back, and the other screens see the box land rather than every frame of the
 * trip.
 */

import * as Y from "yjs";
import * as deck from "@/lib/office/deck";
import { OFFICE_FIELDS } from "@/lib/office/content";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** What this tab's own changes are tagged with. */
export const LOCAL = Symbol.for("polaris.office.slides.local");

export function slidesOf(doc: Y.Doc): Y.Array<deck.Slide> {
    return doc.getArray<deck.Slide>(OFFICE_FIELDS.slides.slides);
}

export function boxesOf(doc: Y.Doc): Y.Map<deck.Box> {
    return doc.getMap<deck.Box>(OFFICE_FIELDS.slides.boxes);
}

function change(doc: Y.Doc, edit: () => void): void {
    doc.transact(edit, LOCAL);
}

export function addSlide(doc: Y.Doc, at: number): string {
    const id = crypto.randomUUID();
    change(doc, () => {
        slidesOf(doc).insert(at, [{ id, notes: "" }]);
        // Never a blank rectangle: a slide with nothing on it and no obvious
        // way in is where a deck stops being made.
        boxesOf(doc).set(deck.boxKey(id, "title"), deck.titleBox("title"));
    });
    return id;
}

export function duplicateSlide(doc: Y.Doc, slideId: string, index: number): string {
    const id = crypto.randomUUID();
    change(doc, () => {
        const boxes = boxesOf(doc);
        slidesOf(doc).insert(index + 1, [{ id, notes: "" }]);
        for (const box of deck.boxesOn(slideId, new Map(boxes.entries()))) {
            const copy = crypto.randomUUID();
            boxes.set(deck.boxKey(id, copy), { ...box, id: copy, version: 1 });
        }
    });
    return id;
}

/** A slide and everything on it, gone - one step, so one undo brings both back. */
export function removeSlide(doc: Y.Doc, slideId: string): void {
    const slides = slidesOf(doc);
    const index = slides.toArray().findIndex((one) => one.id === slideId);
    if (index < 0) return;
    change(doc, () => {
        slides.delete(index, 1);
        const boxes = boxesOf(doc);
        for (const key of [...boxes.keys()]) {
            if (deck.readBoxKey(key)?.slideId === slideId) boxes.delete(key);
        }
    });
}

/**
 * A slide moved to sit at `to` in the deck as it will be afterwards.
 *
 * A Yjs array has no move, so it is taken out and put back in one transaction;
 * the slide keeps its id, and its boxes - keyed by that id - never notice.
 */
export function moveSlide(doc: Y.Doc, from: number, to: number): void {
    const slides = slidesOf(doc);
    const target = Math.max(0, Math.min(slides.length - 1, to));
    if (from === target || from < 0 || from >= slides.length) return;
    const slide = slides.get(from);
    change(doc, () => {
        slides.delete(from, 1);
        slides.insert(target, [slide]);
    });
}

/** A new box on a slide; its id, so the screen can choose it. */
export function addBox(doc: Y.Doc, slideId: string, kind: deck.BoxKind): string {
    const id = crypto.randomUUID();
    change(doc, () => boxesOf(doc).set(deck.boxKey(slideId, id), deck.newBox(kind, id)));
    return id;
}

/** Boxes placed on a slide as they are - pasted or duplicated. */
export function placeBoxes(doc: Y.Doc, slideId: string, boxes: readonly deck.Box[]): void {
    if (boxes.length === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        for (const box of boxes) map.set(deck.boxKey(slideId, box.id), box);
    });
}

export function removeBoxes(doc: Y.Doc, slideId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        for (const id of ids) map.delete(deck.boxKey(slideId, id));
    });
}

/** A box with some of its fields changed, unless nothing actually changed -
 *  a click that moved nothing is not a step in the history. */
export function updateBox(
    doc: Y.Doc,
    slideId: string,
    boxId: string,
    patch: Partial<Omit<deck.Box, "id" | "version" | "kind">>
): void {
    const map = boxesOf(doc);
    const key = deck.boxKey(slideId, boxId);
    const box = map.get(key);
    if (!box) return;
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every(
        (field) => patch[field] === box[field]
    );
    if (same) return;
    change(doc, () => map.set(key, { ...box, ...patch, version: box.version + 1 }));
}

/** A box moved or resized, kept on the slide. */
export function setFrame(doc: Y.Doc, slideId: string, boxId: string, frame: deck.BoxFrame): void {
    updateBox(doc, slideId, boxId, deck.clampFrame(frame));
}

/**
 * A number that changes whenever the document does, so the deck redraws.
 *
 * Counted rather than read off the document: the number of clients that ever
 * wrote to it - what this used to return - does not change when the same tab
 * writes again, so a box dragged here never moved on this screen.
 */
export function useDocumentVersion(doc: Y.Doc): number {
    const store = useMemo(() => {
        let version = 0;
        return {
            subscribe(onChange: () => void): () => void {
                const bump = (): void => {
                    version += 1;
                    onChange();
                };
                doc.on("update", bump);
                return () => doc.off("update", bump);
            },
            read: (): number => version
        };
    }, [doc]);
    return useSyncExternalStore(store.subscribe, store.read, () => 0);
}

/** The history of this tab's own changes to a deck - see `useDeckHistory`. */
export function deckUndoManager(doc: Y.Doc): Y.UndoManager {
    return new Y.UndoManager([slidesOf(doc), boxesOf(doc)], {
        trackedOrigins: new Set([LOCAL]),
        captureTimeout: 0
    });
}

export interface DeckHistory {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    undo(): void;
    redo(): void;
}

/**
 * Undo and redo for this tab's own changes.
 *
 * Every change is its own step. Each one is already a single transaction - a
 * whole drag, a whole edit of a box's words - so merging changes that happen
 * close together (Yjs' default half second) would only fold separate things
 * into one: a slide added and its title moved straight after, undone at once.
 */
export function useDeckHistory(doc: Y.Doc, enabled: boolean): DeckHistory {
    const [manager, setManager] = useState<Y.UndoManager | null>(null);
    const [state, setState] = useState({ canUndo: false, canRedo: false });

    // Made in an effect rather than a memo, so the one torn down is the one
    // that was made - a memo's would be destroyed and then used again.
    useEffect(() => {
        if (!enabled) return;
        const made = deckUndoManager(doc);
        setManager(made);
        return () => {
            made.destroy();
            setManager(null);
            setState({ canUndo: false, canRedo: false });
        };
    }, [doc, enabled]);

    useEffect(() => {
        if (!manager) return;
        const sync = (): void =>
            setState({
                canUndo: manager.undoStack.length > 0,
                canRedo: manager.redoStack.length > 0
            });
        manager.on("stack-item-added", sync);
        manager.on("stack-item-popped", sync);
        manager.on("stack-cleared", sync);
        return () => {
            manager.off("stack-item-added", sync);
            manager.off("stack-item-popped", sync);
            manager.off("stack-cleared", sync);
        };
    }, [manager]);

    const undo = useCallback(() => {
        manager?.stopCapturing();
        manager?.undo();
    }, [manager]);
    const redo = useCallback(() => {
        manager?.stopCapturing();
        manager?.redo();
    }, [manager]);

    return { ...state, undo, redo };
}
