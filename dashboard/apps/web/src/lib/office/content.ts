/**
 * What a document is stored as, and how to read a line of it back.
 *
 * The content of every Office document is a **Yjs update** - the merged state of
 * a CRDT rather than a document format. That is the decision the whole app rests
 * on and it is worth stating once: it is what will let several people type at the
 * same time, and what lets a laptop that closed on a train reconnect and keep
 * what was typed on it. Storing ProseMirror JSON or Markdown instead would work
 * exactly until the second person opened the same document.
 *
 * A CRDT is not readable, though, and a list of documents has to say something
 * about each one. So the excerpt is written beside it - the first few hundred
 * characters as plain text - and that is what search and the list read. It is a
 * description of the document rather than a copy: nothing ever reads it back
 * into an editor.
 *
 * Server-safe. Yjs runs the same in both places, which is the point of it, and
 * this module is imported by the save path and by the exporters.
 */

import * as Y from "yjs";

/** The Yjs field the editor binds to. One name, in one place: the editor and
 *  every exporter have to agree, and a typo would silently open an empty
 *  document beside a full one. */
export const OFFICE_FIELD = "content";

/**
 * What each kind of document keeps, and under which name.
 *
 * Here rather than as a constant per editor, because the exporters have to read
 * exactly what the editors write and a name that agrees by coincidence is a name
 * that stops agreeing. A typo on either side is an empty export beside a full
 * document, with nothing to say it went wrong.
 */
export const OFFICE_FIELDS = {
    /** A rich-text document, bound to ProseMirror. */
    doc: { body: OFFICE_FIELD },
    /** A workbook: the cells, and the shape of the sheets around them. */
    sheet: { cells: "cells", shape: "shape" },
    /** A deck: the slides in order, and every box keyed by slide and box. */
    slides: { slides: "slides", boxes: "boxes" },
    /** A drawing: the elements, and the canvas state around them. */
    diagram: { shapes: "shapes", scene: "scene" },
    /** A comparison: what is being compared, against what, and every answer. */
    comparison: { subjects: "subjects", criteria: "criteria", cells: "cells" }
} as const;

/** A document, opened from what was stored. An empty one for a document nobody
 *  has typed in yet, which is an ordinary state rather than a broken one. */
export function openDocument(stored: Uint8Array | null): Y.Doc {
    const doc = new Y.Doc();
    if (stored && stored.length > 0) Y.applyUpdate(doc, stored);
    return doc;
}

/** Everything in a document, as one update to store. */
export function documentState(doc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(doc);
}

/** How much of a document the list and the search hold. Long enough to
 *  recognise it by, short enough that a hundred rows are not a page of prose. */
export const MAX_EXCERPT = 600;

/**
 * The readable line beside the document.
 *
 * Walks whatever the field holds and takes its text. Written to be indifferent
 * to which editor produced it - a spreadsheet's cells, a deck's slides and a
 * document's paragraphs all end up as words somebody might search for - so it
 * reads the shared types generically rather than knowing any one shape.
 */
export function excerptOf(doc: Y.Doc): string {
    const words: string[] = [];
    for (const [, shared] of doc.share) {
        collect(shared, words);
        if (words.join(" ").length >= MAX_EXCERPT) break;
    }
    return words
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_EXCERPT);
}

/** The text under one shared type, however deeply it nests. */
function collect(value: unknown, into: string[]): void {
    if (into.join(" ").length >= MAX_EXCERPT) return;
    if (value instanceof Y.XmlText || value instanceof Y.Text) {
        const text = value.toString().trim();
        if (text) into.push(text);
        return;
    }
    if (value instanceof Y.XmlElement || value instanceof Y.XmlFragment) {
        for (const child of value.toArray()) collect(child, into);
        return;
    }
    if (value instanceof Y.Array) {
        for (const child of value.toArray()) collect(child, into);
        return;
    }
    if (value instanceof Y.Map) {
        for (const child of value.values()) collect(child, into);
        return;
    }
    if (typeof value === "string") {
        const text = value.trim();
        if (text) into.push(text);
    }
}
