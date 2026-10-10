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
import * as tables from "@/lib/office/slide-table";
import type { SlideChart } from "@/lib/office/slide-chart";
import * as motion from "@/lib/office/slide-motion";
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

/** Each slide's speaker notes, keyed by its id - see `deck.notesOf`. */
export function notesOf(doc: Y.Doc): Y.Map<string> {
    return doc.getMap<string>(OFFICE_FIELDS.slides.notes);
}

/** Every picture in the deck, kept once, keyed by the id its boxes name. */
export function imagesOf(doc: Y.Doc): Y.Map<string> {
    return doc.getMap<string>(OFFICE_FIELDS.slides.images);
}

/** The deck's theme, a field at a time - see `deck.readTheme`. */
export function themeOf(doc: Y.Doc): Y.Map<string> {
    return doc.getMap<string>(OFFICE_FIELDS.slides.theme);
}

/** Each slide's own background, keyed by its id. */
export function backgroundsOf(doc: Y.Doc): Y.Map<string> {
    return doc.getMap<string>(OFFICE_FIELDS.slides.backgrounds);
}

/** Each slide's transition, keyed by its id - see `motion.readTransition`. */
export function transitionsOf(doc: Y.Doc): Y.Map<unknown> {
    return doc.getMap<unknown>(OFFICE_FIELDS.slides.transitions);
}

/** Each slide's animations, one ordered list keyed by its id - see
 *  `motion.readAnimations`. */
export function animationsOf(doc: Y.Doc): Y.Map<unknown> {
    return doc.getMap<unknown>(OFFICE_FIELDS.slides.animations);
}

/** What an image box shows: the picture itself, out of the deck's store when it
 *  is kept there. */
export function imageSource(doc: Y.Doc, src: string): string {
    if (!src.startsWith(deck.IMAGE_PREFIX)) return src;
    return imagesOf(doc).get(src.slice(deck.IMAGE_PREFIX.length)) ?? "";
}

/** Every picture no box shows any more, out of the store - in the same
 *  transaction as the removal, so one undo brings the box and its picture back. */
function dropUnusedImages(doc: Y.Doc): void {
    const images = imagesOf(doc);
    if (images.size === 0) return;
    const used = new Set<string>();
    for (const box of boxesOf(doc).values()) {
        const { src } = deck.readBox(box);
        if (src.startsWith(deck.IMAGE_PREFIX)) used.add(src.slice(deck.IMAGE_PREFIX.length));
    }
    for (const key of [...images.keys()]) if (!used.has(key)) images.delete(key);
}

/** The key a picture is already kept under, so a copy pasted into the same
 *  deck names it rather than storing it again. */
function keptImage(doc: Y.Doc, data: string): string | undefined {
    for (const [key, stored] of imagesOf(doc).entries()) if (stored === data) return key;
    return undefined;
}

function change(doc: Y.Doc, edit: () => void): void {
    doc.transact(edit, LOCAL);
}

/** A new slide at `at`, laid out as `layout` - or, with none given, with the
 *  one title every slide had before there were layouts. */
export function addSlide(doc: Y.Doc, at: number, layout?: deck.Layout): string {
    const id = crypto.randomUUID();
    change(doc, () => {
        slidesOf(doc).insert(at, [{ id, notes: "" }]);
        // Never a blank rectangle, unless one was asked for: a slide with
        // nothing on it and no obvious way in is where a deck stops being made.
        const boxes = layout ? deck.layoutBoxes(layout) : [deck.titleBox("title")];
        for (const box of boxes) boxesOf(doc).set(deck.boxKey(id, box.id), box);
    });
    return id;
}

/** A layout put on a slide that already has boxes - see `deck.applyLayout`. */
export function applyLayout(doc: Y.Doc, slideId: string, layout: deck.Layout): void {
    const { set, remove } = deck.applyLayout(onSlide(doc, slideId), layout, () =>
        crypto.randomUUID()
    );
    if (set.length === 0 && remove.length === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        for (const box of set) map.set(deck.boxKey(slideId, box.id), box);
        for (const id of remove) map.delete(deck.boxKey(slideId, id));
    });
}

export function duplicateSlide(doc: Y.Doc, slideId: string, index: number): string {
    const id = crypto.randomUUID();
    change(doc, () => {
        const boxes = boxesOf(doc);
        const slides = slidesOf(doc);
        const original = slides.get(index);
        slides.insert(index + 1, [{ id, notes: "" }]);
        const copies = new Map<string, string>();
        for (const box of deck.boxesOn(slideId, new Map(boxes.entries()))) {
            const copy = crypto.randomUUID();
            copies.set(box.id, copy);
            boxes.set(deck.boxKey(id, copy), { ...box, id: copy, version: 1 });
        }
        // The notes go with it, as in every deck editor: a copied slide is
        // usually the same point made again.
        const notes = original ? deck.notesOf(original, new Map(notesOf(doc).entries())) : "";
        if (notes) notesOf(doc).set(id, notes);
        const background = deck.readBackground(backgroundsOf(doc).get(slideId));
        if (background) backgroundsOf(doc).set(id, background);
        // And so do its transition and its animations, pointed at the copies.
        const transition = motion.readTransition(transitionsOf(doc).get(slideId));
        if (transition.kind !== "none") transitionsOf(doc).set(id, transition);
        const animations = motion.readAnimations(animationsOf(doc).get(slideId));
        if (animations.length > 0) {
            animationsOf(doc).set(
                id,
                motion.remapAnimations(animations, copies, () => crypto.randomUUID())
            );
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
        notesOf(doc).delete(slideId);
        backgroundsOf(doc).delete(slideId);
        transitionsOf(doc).delete(slideId);
        animationsOf(doc).delete(slideId);
        dropUnusedImages(doc);
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

function onSlide(doc: Y.Doc, slideId: string): deck.Box[] {
    return deck.boxesOn(slideId, new Map(boxesOf(doc).entries()));
}

/** A new box on a slide, on top of everything on it; its id, so the screen can
 *  choose it. */
export function addBox(
    doc: Y.Doc,
    slideId: string,
    kind: deck.BoxKind,
    shape?: deck.ShapeKind
): string {
    const made = deck.newBox(kind, crypto.randomUUID(), shape);
    // In the theme's colours, as Google Slides fills a new shape with the
    // theme's accent: violet on a white deck, the theme's own on any other.
    const theme = deck.readTheme(new Map(themeOf(doc).entries()));
    const box =
        made.kind !== "shape"
            ? made
            : deck.isLine(made)
              ? {
                    ...made,
                    stroke: theme.text === deck.DEFAULT_THEME.text ? made.stroke : theme.text
                }
              : { ...made, fill: theme.accent };
    placeBoxes(doc, slideId, [box]);
    return box.id;
}

/** A new table on a slide, `rows` by `cols`, its header in the theme's accent;
 *  its id. */
export function addTable(doc: Y.Doc, slideId: string, rows: number, cols: number): string {
    const theme = deck.readTheme(new Map(themeOf(doc).entries()));
    const box = deck.newTableBox(crypto.randomUUID(), rows, cols, theme.accent);
    placeBoxes(doc, slideId, [box]);
    return box.id;
}

/** A new chart on a slide; its id. */
export function addChart(doc: Y.Doc, slideId: string, chart: SlideChart): string {
    const box = deck.newChartBox(crypto.randomUUID(), chart);
    placeBoxes(doc, slideId, [box]);
    return box.id;
}

/**
 * A table changed by `edit`, worked out from the table as it is in the deck
 * right now rather than as this screen last drew it - so a cell somebody else
 * typed a moment ago is kept. Nothing is written when `edit` changes nothing.
 */
export function updateTable(
    doc: Y.Doc,
    slideId: string,
    boxId: string,
    edit: (table: tables.SlideTable) => tables.SlideTable
): void {
    const stored = boxesOf(doc).get(deck.boxKey(slideId, boxId));
    if (!stored) return;
    const { table } = deck.readBox(stored);
    if (!table) return;
    const next = edit(table);
    if (next === table) return;
    updateBox(doc, slideId, boxId, { table: next });
}

/** One cell's words. */
export function setCell(
    doc: Y.Doc,
    slideId: string,
    boxId: string,
    at: tables.CellAt,
    text: string
): void {
    updateTable(doc, slideId, boxId, (table) => tables.setCell(table, at, text));
}

/** A chart's numbers, kind and switches, as one step - unless they are the
 *  ones it already has, which is no step at all. */
export function setChart(doc: Y.Doc, slideId: string, boxId: string, chart: SlideChart): void {
    const stored = boxesOf(doc).get(deck.boxKey(slideId, boxId));
    if (!stored) return;
    if (JSON.stringify(deck.readBox(stored).chart) === JSON.stringify(chart)) return;
    updateBox(doc, slideId, boxId, { chart });
}

/** Boxes placed on a slide as they are - pasted or duplicated - on top of what
 *  is already there, in the order given. */
export function placeBoxes(doc: Y.Doc, slideId: string, boxes: readonly deck.Box[]): void {
    if (boxes.length === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        let z = deck.nextZ(onSlide(doc, slideId));
        for (const box of boxes) {
            map.set(deck.boxKey(slideId, box.id), { ...box, z });
            z += 1;
        }
    });
}

/**
 * A picture kept in the deck's store and shown on a slide as one box.
 *
 * The picture is written once; the box names it. So moving or resizing it is a
 * change of a few numbers, rather than the whole picture sent to everybody
 * again on every drag.
 */
export function addImage(doc: Y.Doc, slideId: string, data: string, frame: deck.BoxFrame): string {
    const key = crypto.randomUUID();
    const box: deck.Box = {
        ...deck.newBox("image", crypto.randomUUID()),
        ...frame,
        src: `${deck.IMAGE_PREFIX}${key}`
    };
    change(doc, () => {
        imagesOf(doc).set(key, data);
        placeBoxes(doc, slideId, [box]);
    });
    return box.id;
}

/** Boxes placed as pasted, with every picture that came inline moved into the
 *  deck's store - one step, so one undo takes the whole paste back. */
export function pasteBoxes(doc: Y.Doc, slideId: string, boxes: readonly deck.Box[]): void {
    if (boxes.length === 0) return;
    change(doc, () => {
        const kept = boxes.map((box) => {
            if (box.kind !== "image" || !box.src.startsWith("data:image/")) return box;
            const key = keptImage(doc, box.src) ?? crypto.randomUUID();
            if (!imagesOf(doc).has(key)) imagesOf(doc).set(key, box.src);
            return { ...box, src: `${deck.IMAGE_PREFIX}${key}` };
        });
        placeBoxes(doc, slideId, kept);
    });
}

/** Boxes moved through the stack - one step, however many boxes they pass. */
export function arrangeBox(
    doc: Y.Doc,
    slideId: string,
    boxIds: string | readonly string[],
    how: deck.Arrange
): void {
    const changes = deck.arrange(onSlide(doc, slideId), boxIds, how);
    if (changes.size === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        for (const [id, z] of changes) {
            const key = deck.boxKey(slideId, id);
            const box = map.get(key);
            if (box) map.set(key, { ...box, z, version: deck.readBox(box).version + 1 });
        }
    });
}

/** Several boxes changed at once - lined up, spaced out, resized together -
 *  as one step, each kept on the slide. */
export function setFrames(
    doc: Y.Doc,
    slideId: string,
    frames: ReadonlyMap<string, deck.BoxFrame & { flip?: boolean; reversed?: boolean }>
): void {
    if (frames.size === 0) return;
    change(doc, () => {
        for (const [id, frame] of frames) setFrame(doc, slideId, id, frame);
    });
}

/** The same change to several boxes, as one step - each given only the fields
 *  that mean something on it (`fits`). A change that depends on the box is
 *  worked out for each one. */
export function updateBoxes(
    doc: Y.Doc,
    slideId: string,
    boxIds: readonly string[],
    patch:
        | Partial<Omit<deck.Box, "id" | "version" | "kind">>
        | ((box: deck.Box) => Partial<Omit<deck.Box, "id" | "version" | "kind">>),
    fits: (box: deck.Box, field: keyof deck.Box) => boolean = () => true
): void {
    const map = boxesOf(doc);
    change(doc, () => {
        for (const id of boxIds) {
            const stored = map.get(deck.boxKey(slideId, id));
            if (!stored) continue;
            const box = deck.readBox(stored);
            const own = typeof patch === "function" ? patch(box) : patch;
            const kept = Object.fromEntries(
                Object.entries(own).filter(([field]) => fits(box, field as keyof deck.Box))
            ) as typeof own;
            if (Object.keys(kept).length > 0) updateBox(doc, slideId, id, kept);
        }
    });
}

/** Boxes made one group - chosen, moved and arranged together from now on -
 *  and the group's id. A box already in a group joins the new one, so groups
 *  grouped again are one group. */
export function groupBoxes(doc: Y.Doc, slideId: string, boxIds: readonly string[]): string {
    const group = crypto.randomUUID();
    updateBoxes(doc, slideId, boxIds, { group });
    return group;
}

/** Groups taken apart. An animation of a whole group becomes the same
 *  animation of each box that was in it, so the slide still plays as it did -
 *  in the same step, as one change. */
export function ungroupBoxes(doc: Y.Doc, slideId: string, boxIds: readonly string[]): void {
    const boxes = onSlide(doc, slideId);
    const groups = new Set(
        boxes.filter((box) => boxIds.includes(box.id) && box.group).map((box) => box.group)
    );
    change(doc, () => {
        updateBoxes(doc, slideId, boxIds, { group: "" });
        let animations = motion.readAnimations(animationsOf(doc).get(slideId));
        if (animations.length === 0) return;
        for (const group of groups) {
            const members = boxes.filter((box) => box.group === group).map((box) => box.id);
            animations = motion.ungroupAnimations(animations, group, members, () =>
                crypto.randomUUID()
            );
        }
        animationsOf(doc).set(slideId, animations);
    });
}

/** A transition put on slides - one, or all of them at once. */
export function setTransition(
    doc: Y.Doc,
    slideIds: readonly string[],
    transition: motion.SlideTransition
): void {
    change(doc, () => {
        const map = transitionsOf(doc);
        for (const id of slideIds) {
            if (transition.kind === "none") map.delete(id);
            else map.set(id, { kind: transition.kind, speed: transition.speed });
        }
    });
}

/** A slide's animations, written whole - see `slide-motion.ts` for why. */
export function setAnimations(
    doc: Y.Doc,
    slideId: string,
    list: readonly motion.SlideAnimation[]
): void {
    const now = motion.readAnimations(animationsOf(doc).get(slideId));
    if (JSON.stringify(now) === JSON.stringify(list)) return;
    change(doc, () => {
        if (list.length === 0) animationsOf(doc).delete(slideId);
        else
            animationsOf(doc).set(
                slideId,
                list.slice(0, motion.ANIMATIONS_MAX).map((one) => ({ ...one }))
            );
    });
}

/** The deck's theme set to one of those offered, or one field of it changed. */
export function setTheme(doc: Y.Doc, theme: Partial<deck.DeckTheme>): void {
    const map = themeOf(doc);
    const current = deck.readTheme(new Map(map.entries()));
    const fields = deck.THEME_FIELDS.filter(
        (field) => theme[field] !== undefined && theme[field] !== current[field]
    );
    // Written whole the first time, so a deck that has a theme names every
    // part of it rather than leaning on today's defaults.
    const missing = deck.THEME_FIELDS.filter((field) => !map.has(field));
    if (fields.length === 0 && missing.length === 0) return;
    change(doc, () => {
        for (const field of missing) map.set(field, current[field]);
        for (const field of fields) map.set(field, theme[field]!);
    });
}

/** The background of some slides set to a colour, or back to the theme's
 *  with `null`. */
export function setBackground(doc: Y.Doc, slideIds: readonly string[], color: string | null): void {
    const map = backgroundsOf(doc);
    const kept = color === null ? null : deck.readBackground(color);
    if (color !== null && !kept) return;
    const changing = slideIds.filter((id) => (map.get(id) ?? null) !== kept);
    if (changing.length === 0) return;
    change(doc, () => {
        for (const id of changing) {
            if (kept) map.set(id, kept);
            else map.delete(id);
        }
    });
}

/** A colour made the theme's background, and every slide's own background
 *  let go - so every slide has it, and a slide added later too. One step. */
export function backgroundEverywhere(doc: Y.Doc, color: string): void {
    const kept = deck.readBackground(color);
    if (!kept) return;
    change(doc, () => {
        setTheme(doc, { background: kept });
        const map = backgroundsOf(doc);
        for (const id of [...map.keys()]) map.delete(id);
    });
}

/** A slide's speaker notes, unless they already say that. */
export function setNotes(doc: Y.Doc, slide: deck.Slide, text: string): void {
    const notes = notesOf(doc);
    const next = text.slice(0, deck.NOTES_MAX);
    if (deck.notesOf(slide, new Map(notes.entries())) === next) return;
    change(doc, () => notes.set(slide.id, next));
}

export function removeBoxes(doc: Y.Doc, slideId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    change(doc, () => {
        const map = boxesOf(doc);
        for (const id of ids) map.delete(deck.boxKey(slideId, id));
        dropUnusedImages(doc);
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
    const stored = map.get(key);
    if (!stored) return;
    // Compared with the box as it is drawn, so a field an older editor never
    // wrote reads as its default rather than as a change.
    const box = deck.readBox(stored);
    const same = (Object.keys(patch) as (keyof typeof patch)[]).every(
        (field) => patch[field] === box[field]
    );
    if (same) return;
    change(doc, () => map.set(key, { ...stored, ...patch, version: box.version + 1 }));
}

/** A box moved or resized, kept on the slide. A line also says which way it
 *  runs, since its frame alone does not. */
export function setFrame(
    doc: Y.Doc,
    slideId: string,
    boxId: string,
    frame: deck.BoxFrame & { flip?: boolean; reversed?: boolean }
): void {
    const stored = boxesOf(doc).get(deck.boxKey(slideId, boxId));
    if (!stored) return;
    const kept = deck.clampFrame(frame, deck.smallestFor(deck.readBox(stored)));
    const turned = {
        ...(frame.flip === undefined ? {} : { flip: frame.flip }),
        ...(frame.reversed === undefined ? {} : { reversed: frame.reversed })
    };
    updateBox(doc, slideId, boxId, { ...kept, ...turned });
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
    const scope = [
        slidesOf(doc),
        boxesOf(doc),
        notesOf(doc),
        imagesOf(doc),
        themeOf(doc),
        backgroundsOf(doc),
        transitionsOf(doc),
        animationsOf(doc)
    ];
    return new Y.UndoManager(scope, {
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
