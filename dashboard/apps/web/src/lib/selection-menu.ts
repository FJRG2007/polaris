"use client";

/**
 * When a right-click is about selected text, and which text.
 *
 * The rules the selection menu (`components/selection-menu.tsx`) follows, kept
 * apart from it so they can be asserted on without drawing anything:
 *
 * - Only a selection that is not empty, and only when the click landed on it.
 *   A right-click somewhere else, with an old selection left on the page, is
 *   not a question about that text.
 * - Inside a field (an input, a textarea, an editor), only when text in that
 *   field is selected. With nothing selected the browser's own menu stays: it is
 *   the one that offers spelling corrections and the keyboard's own input
 *   methods, which no page can reproduce.
 * - Never where a surface has said it keeps the browser's menu
 *   (`data-native-context-menu`), and never inside an open menu.
 */

/** Where an editable field starts: the browser's own and the rich editors'. */
const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";
/** Surfaces that keep the browser's menu, and menus already on screen. */
const NATIVE = "[data-native-context-menu], [data-radix-menu-content]";

export type EditableField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export interface SelectionAt {
    readonly text: string;
    /** The field the text is in, or null for text on the page. */
    readonly field: EditableField | null;
}

function elementOf(target: EventTarget | null): Element | null {
    if (!target || typeof (target as Node).nodeType !== "number") return null;
    const node = target as Node;
    return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function isTextField(field: Element): field is HTMLInputElement | HTMLTextAreaElement {
    return field.tagName === "INPUT" || field.tagName === "TEXTAREA";
}

/** The text selected inside an input or a textarea, or "" - some input types
 *  (email, number) have no selection and say so by throwing or by null. */
function fieldSelection(field: HTMLInputElement | HTMLTextAreaElement): string {
    try {
        const start = field.selectionStart;
        const end = field.selectionEnd;
        if (start === null || end === null || end <= start) return "";
        // A password is never handed to a menu that can copy it or send it on.
        if (field.tagName === "INPUT" && (field as HTMLInputElement).type === "password") return "";
        return field.value.slice(start, end);
    } catch {
        return "";
    }
}

/**
 * The selection a right-click on `target` is about, or null when the browser's
 * own menu should open instead.
 */
export function selectionAt(target: EventTarget | null, doc: Document): SelectionAt | null {
    const element = elementOf(target);
    if (!element || element.closest(NATIVE)) return null;
    const field = element.closest(EDITABLE) as EditableField | null;
    if (field && isTextField(field)) {
        const text = fieldSelection(field);
        return text.trim() ? { text, field } : null;
    }
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    // The click has to be on the selection, or on something inside it.
    if (!selection.getRangeAt(0).intersectsNode(element)) return null;
    // In a rich editor the selection has to be in that editor.
    if (field && !field.contains(selection.anchorNode)) return null;
    return { text, field };
}

/** Where to draw a menu opened from the keyboard: under the selection. */
export function selectionPoint(
    found: SelectionAt,
    doc: Document
): { readonly x: number; readonly y: number } {
    const rect =
        found.field && isTextField(found.field)
            ? found.field.getBoundingClientRect()
            : doc.getSelection()?.getRangeAt(0).getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 };
}

/**
 * Whether a `contextmenu` event came from the keyboard (Shift+F10 or the
 * ContextMenu key) rather than from a mouse button. A keyboard one is never
 * the Shift escape hatch - Shift is part of Shift+F10.
 */
export function fromKeyboard(event: Pick<MouseEvent, "button" | "clientX" | "clientY">): boolean {
    return event.button !== 2 || (event.clientX === 0 && event.clientY === 0);
}

/**
 * The last right-click, as the menus that open from it read it: the app's own
 * row and file menus add their selection options from this, since the
 * selection is whatever it was at the instant of the click.
 */
let lastClick: { readonly at: number; readonly found: SelectionAt | null } | null = null;

/** How long after the click a menu still counts as opened by it. */
const CLICK_FRESH_MS = 1500;

export function recordContextMenu(found: SelectionAt | null, now: number = Date.now()): void {
    lastClick = { at: now, found };
}

/** The selection the last right-click was about, when it was a moment ago. */
export function lastSelection(now: number = Date.now()): SelectionAt | null {
    if (!lastClick || now - lastClick.at > CLICK_FRESH_MS) return null;
    return lastClick.found;
}
