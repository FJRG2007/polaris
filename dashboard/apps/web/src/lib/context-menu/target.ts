"use client";

/**
 * Every right-click in Polaris, and which of Polaris's menus answers it.
 *
 * The browser's own menu (and the desktop app's) never opens on a Polaris page.
 * A screen with a menu of its own - a chat message, a row, a file, the rich text
 * editor - calls `preventDefault` on the click, and the one listener here reads
 * that and stays out of the way. Everything else is prevented here and handed
 * to the layers registered with `addContextLayer`, highest priority first: the
 * selection menu in the app's shell, then the root fallback
 * (`components/context-menu-fallback.tsx`) that works on every page.
 *
 * What the click was on decides the menu (`contextTargetAt`): an open menu
 * (nothing), selected text, a link, an editable field, a picture, or empty
 * space (nothing). A picture inside `[data-no-save]` - a protected message -
 * offers nothing that copies or saves it.
 *
 * One exception: a long press in a field on a touch screen is left alone, since
 * there the browser's selection handles and paste bar are the platform's own
 * text editing, not a menu, and nothing else gives a touch user a caret.
 */

import { fromKeyboard, linkAt, selectionAt, type EditableField, type LinkAt, type SelectionAt } from "@/lib/selection-menu";

/** Where an editable field starts: the browser's own and the rich editors'. */
const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";
/** Input types whose value is text a person edits. */
const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
/** A menu already on screen. */
const OPEN_MENU = "[data-radix-menu-content], [role=menu]";
/** Where a picture may not be copied, saved or opened. */
const NO_SAVE = "[data-no-save]";

/** The word under the caret in a field, for the spelling checker. */
export interface WordAt {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    /** In a rich field, the text node the offsets count in. */
    readonly node?: Node;
}

/** A picture a right-click landed on. */
export interface ImageAt {
    /** Absolute address of what is drawn: the image, or a video's poster. */
    readonly src: string;
    /** An address on the web, so it can be opened and its address copied. */
    readonly web: boolean;
}

export type ContextTarget =
    | { readonly kind: "menu" }
    | { readonly kind: "selection"; readonly found: SelectionAt }
    | { readonly kind: "link"; readonly link: LinkAt }
    | {
          readonly kind: "field";
          readonly field: EditableField;
          /** Selected text in the field, "" for none (always "" in a password). */
          readonly selected: string;
          readonly word: WordAt | null;
          readonly password: boolean;
      }
    | { readonly kind: "media"; readonly image: ImageAt | null; readonly link: LinkAt | null }
    | { readonly kind: "empty" };

/** What the classification asks of the spelling checker, when there is one. */
export type SpellingCheck = (word: string) => boolean;

function elementOf(target: EventTarget | null): Element | null {
    if (!target || typeof (target as Node).nodeType !== "number") return null;
    const node = target as Node;
    return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function isTextField(field: Element): field is HTMLInputElement | HTMLTextAreaElement {
    return field.tagName === "INPUT" || field.tagName === "TEXTAREA";
}

/** A letter of a word, accents and apostrophes included. */
const WORD_CHAR = /[\p{L}\p{M}'’]/u;

/** The word around `offset` in `text`, or null when the offset is not in one. */
export function wordAround(text: string, offset: number): WordAt | null {
    if (offset < 0 || offset > text.length) return null;
    let start = offset;
    let end = offset;
    while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
    while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
    const word = text.slice(start, end).replace(/^['’]+|['’]+$/g, "");
    if (!word || !/\p{L}/u.test(word)) return null;
    const lead = text.slice(start, end).indexOf(word);
    return { text: word, start: start + lead, end: start + lead + word.length };
}

/** The word at the caret: a right mouse button puts the caret where it pressed. */
function wordAtCaret(field: EditableField, doc: Document): WordAt | null {
    if (isTextField(field)) {
        try {
            const at = field.selectionStart;
            if (at === null || field.selectionEnd !== at) return null;
            return wordAround(field.value, at);
        } catch {
            return null;
        }
    }
    const selection = doc.getSelection();
    const node = selection?.anchorNode;
    if (!selection || !selection.isCollapsed || !node || node.nodeType !== 3 || !field.contains(node)) return null;
    const word = wordAround(node.textContent ?? "", selection.anchorOffset);
    return word ? { ...word, node } : null;
}

function editableField(element: Element): EditableField | null {
    const field = element.closest(EDITABLE) as EditableField | null;
    if (!field) return null;
    if (field.tagName === "INPUT" && !TEXT_INPUTS.has((field as HTMLInputElement).type)) return null;
    return field;
}

function imageAt(element: Element, doc: Document): ImageAt | null | undefined {
    const media = element.closest("img, video");
    if (!media) return undefined;
    if (media.closest(NO_SAVE)) return null;
    const raw =
        media.tagName === "IMG"
            ? (media as HTMLImageElement).currentSrc || media.getAttribute("src")
            : media.getAttribute("poster");
    if (!raw) return null;
    try {
        const url = new URL(raw, doc.baseURI);
        if (!["http:", "https:", "data:", "blob:"].includes(url.protocol)) return null;
        return { src: url.href, web: url.protocol === "http:" || url.protocol === "https:" };
    } catch {
        return null;
    }
}

/**
 * What a right-click on `target` is about. `misspelled` is the spelling checker
 * when there is one (the desktop app): a single misspelled word selected in a
 * field is then a question about its spelling, not about selected text.
 */
export function contextTargetAt(
    target: EventTarget | null,
    doc: Document,
    misspelled: SpellingCheck | null = null
): ContextTarget {
    const element = elementOf(target);
    if (!element) return { kind: "empty" };
    if (element.closest(OPEN_MENU)) return { kind: "menu" };
    const found = selectionAt(target, doc);
    const field = editableField(element);
    if (found) {
        const word = found.field ? wordAround(found.text, 0) : null;
        const oneWord = word !== null && word.text === found.text.trim();
        if (!(found.field && oneWord && misspelled?.(word.text))) return { kind: "selection", found };
    }
    if (field) {
        const password = field.tagName === "INPUT" && (field as HTMLInputElement).type === "password";
        const selected = password ? "" : (found?.text ?? "");
        return { kind: "field", field, selected, word: password ? null : wordAtCaret(field, doc), password };
    }
    const link = linkAt(target, doc);
    const image = imageAt(element, doc);
    if (image !== undefined) return { kind: "media", image, link };
    if (link) return { kind: "link", link };
    return { kind: "empty" };
}

/** A menu that may answer a right-click: true when it did. */
export type ContextLayer = (event: MouseEvent, target: ContextTarget) => boolean;

const layers: { readonly priority: number; readonly handle: ContextLayer }[] = [];
let spelling: SpellingCheck | null = null;
let lastPointer: string = "mouse";

let notice: ((title: string) => void) | null = null;

/** Where a menu's outcome is said ("Copied", "Pasting was blocked"): the app
 *  shell's toasts, set while it is on screen. */
export function setContextMenuNotice(sink: ((title: string) => void) | null): void {
    notice = sink;
}

/** Says a menu's outcome, where there is somewhere to say it. */
export function contextMenuNotice(title: string): void {
    notice?.(title);
}

/** Where the spelling checker comes from (the desktop app), or null for none. */
export function setSpellingCheck(check: SpellingCheck | null): void {
    spelling = check;
}

function notePointer(event: PointerEvent): void {
    lastPointer = event.pointerType || "mouse";
}

/** The one listener: every right-click no screen answered. */
export function dispatchContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    const target = contextTargetAt(event.target, event.view?.document ?? document, spelling);
    // A long press in a field on a touch screen: the platform's own text editing.
    if (target.kind === "field" && lastPointer !== "mouse" && !fromKeyboard(event)) return;
    event.preventDefault();
    for (const layer of [...layers]) if (layer.handle(event, target)) return;
}

/**
 * Registers a menu that answers right-clicks, at `priority` (higher first).
 * The listener is on the window, in the bubble phase, so a screen's own menu
 * has already prevented the click by the time it runs.
 */
export function addContextLayer(priority: number, handle: ContextLayer): () => void {
    const entry = { priority, handle };
    layers.push(entry);
    layers.sort((a, b) => b.priority - a.priority);
    if (layers.length === 1) {
        window.addEventListener("pointerdown", notePointer, true);
        window.addEventListener("contextmenu", dispatchContextMenu);
    }
    return () => {
        const index = layers.indexOf(entry);
        if (index < 0) return;
        layers.splice(index, 1);
        if (layers.length === 0) {
            window.removeEventListener("pointerdown", notePointer, true);
            window.removeEventListener("contextmenu", dispatchContextMenu);
        }
    };
}
