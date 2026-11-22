"use client";

/**
 * What Polaris's right-click menus do: the clipboard, a field's text and a
 * picture. Client-only.
 *
 * The clipboard is the async Clipboard API first. Where the page is refused it
 * (no permission, no focus), the desktop app's clipboard through its bridge;
 * copying a selection that is still on the page falls back to
 * `execCommand("copy")` last, since it needs no permission at all.
 *
 * Typing into a field goes through `execCommand("insertText")` and
 * `execCommand("delete")`, with `setRangeText` behind them: they are the only
 * way to change a field that its own undo history and its framework's change
 * handling both see. Undo and Redo are `execCommand("undo"/"redo")` for the same
 * reason - the browser's undo stack has no other door. Paste is offered to the
 * field first as a `paste` event carrying the clipboard's text, HTML and
 * pictures, so an editor that handles pasting itself (formatting, pictures, its
 * own schema) does what it does for Ctrl+V; a field that does not gets the plain
 * text typed in. Pasted HTML is never inserted by this file.
 */

import * as clipboard from "@polaris/ui/clipboard";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { ClipboardContents, ClipboardRead, ClipboardRefusal } from "@polaris/ui/clipboard";

export type TextField = HTMLInputElement | HTMLTextAreaElement;

export function isTextField(field: Element | null): field is TextField {
    return !!field && (field.tagName === "INPUT" || field.tagName === "TEXTAREA");
}

/** Puts text on the clipboard; false when every way was refused. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Refused here: the desktop app's own clipboard, then the selection.
    }
    const editing = desktopBridge()?.editing;
    if (editing && (await editing.writeClipboard(text).catch(() => false))) return true;
    return command("copy");
}

export type { ClipboardContents, ClipboardRead, ClipboardRefusal } from "@polaris/ui/clipboard";

/**
 * Reads everything a paste would carry (`@polaris/ui/clipboard`), with the
 * desktop app's clipboard last, where the page is refused it altogether.
 */
export function readClipboard(): Promise<ClipboardRead> {
    return clipboard.readClipboard(() => desktopBridge()?.editing?.readClipboard());
}

/** Runs an editing command; false where the browser has none or refused it. */
function command(name: string, value?: string): boolean {
    try {
        return document.execCommand(name, false, value);
    } catch {
        return false;
    }
}

/** Whether the field's text can be changed: not read-only, not disabled. */
export function canEdit(field: Element | null): boolean {
    if (!field) return false;
    if (isTextField(field)) return !field.readOnly && !field.disabled;
    return (
        (field as HTMLElement).isContentEditable ||
        field.matches("[contenteditable]:not([contenteditable='false'])")
    );
}

/** Takes the selection out of the field the way the keyboard would. */
export function deleteSelection(field: Element): void {
    if (command("delete")) return;
    if (isTextField(field)) {
        field.setRangeText("", field.selectionStart ?? 0, field.selectionEnd ?? 0, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

/** Typed into the field at its selection, so its own undo and change handling see it. */
export function insertText(field: Element, text: string): void {
    if (command("insertText", text)) return;
    if (isTextField(field)) {
        field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, "end");
        field.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

/** What a paste did: the field took it, or its text was typed in; or there was
 *  nothing on the clipboard, or only pictures for a field that takes none. */
export type PasteResult = "taken" | "typed" | "empty" | "no-text";

function transferOf(contents: ClipboardContents): DataTransfer | null {
    try {
        const transfer = new DataTransfer();
        if (contents.text) transfer.setData("text/plain", contents.text);
        if (contents.html) transfer.setData("text/html", contents.html);
        for (const file of contents.files) transfer.items.add(file);
        return transfer;
    } catch {
        return null;
    }
}

/** A paste event carrying `transfer`, or null where this browser drops the data
 *  of an event a page builds (the field would then receive an empty paste). */
function pasteEvent(transfer: DataTransfer): ClipboardEvent | null {
    try {
        const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
        return event.clipboardData === transfer ? event : null;
    } catch {
        return null;
    }
}

/**
 * Pastes into the field at its selection the way the paste keys do: the field
 * gets a `paste` event carrying the text, HTML and pictures, so an editor that
 * handles pasting itself (Markdown, a composer staging a screenshot as an
 * attachment, a terminal) does exactly what it does for Ctrl+V. When nothing
 * took it, the text is typed in, as the browser would.
 *
 * "Took it" is a handler cancelling the event, or stopping it on its way up: a
 * terminal sends the text on and stops the event without cancelling it, and
 * typing the text in as well would send it twice. `html` only travels inside
 * the event, for an editor that parses it through its own rules. `typeText`
 * replaces the typing for an editor that reads typed-in text its own way.
 */
export function pasteInto(
    field: Element,
    contents: ClipboardContents,
    typeText: (text: string) => void = (text) => insertText(field, text)
): PasteResult {
    if (!contents.text && !contents.html && contents.files.length === 0) return "empty";
    const transfer = transferOf(contents);
    const event = transfer ? pasteEvent(transfer) : null;
    if (event) {
        let reached = false;
        const arrived = (seen: Event) => {
            if (seen === event) reached = true;
        };
        const view = field.ownerDocument.defaultView ?? window;
        view.addEventListener("paste", arrived);
        let open = true;
        try {
            open = field.dispatchEvent(event);
        } finally {
            view.removeEventListener("paste", arrived);
        }
        if (!open || !reached) return "taken";
    }
    if (!contents.text) return "no-text";
    typeText(contents.text);
    return "typed";
}

/** What pasting from a menu came to: what the field did, or why the clipboard stayed shut. */
export type MenuPasteOutcome = PasteResult | ClipboardRefusal;

export interface MenuPasteOptions {
    /** Text only, as Ctrl+Shift+V: no HTML and no pictures. */
    readonly plain?: boolean;
    /** Puts the caret and selection back where the menu was opened, just before pasting. */
    readonly restore?: () => void;
    /** How the text goes in when the field leaves the paste to the browser (see `pasteInto`). */
    readonly typeText?: (text: string) => void;
}

/**
 * A menu's Paste: reads the clipboard inside the press (what lets the browser
 * allow it), puts the caret back where the menu was opened, and pastes through
 * `pasteInto`. The one implementation every Paste row uses.
 */
export async function pasteFromClipboard(field: Element, options: MenuPasteOptions = {}): Promise<MenuPasteOutcome> {
    const read = await readClipboard();
    if (!read.ok) return read.reason;
    const contents = options.plain ? { text: read.contents.text, html: null, files: [] } : read.contents;
    options.restore?.();
    return pasteInto(field, contents, options.typeText);
}

/** The paste keys here, for a hint that names them: "Cmd+V" on Apple devices. */
export const pasteKeys = clipboard.pasteKeys;

/** Selects everything in the field. */
export function selectAllIn(field: Element): void {
    (field as HTMLElement).focus({ preventScroll: true });
    if (isTextField(field)) {
        field.select();
        return;
    }
    const selection = document.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(field);
    selection.removeAllRanges();
    selection.addRange(range);
}

/** Selects `start`..`end` of the field's text (in a rich field, of the text
 *  node the caret was in). */
export function selectRange(field: Element, start: number, end: number, node: Node | null): void {
    (field as HTMLElement).focus({ preventScroll: true });
    if (isTextField(field)) {
        field.setSelectionRange(start, end);
        return;
    }
    const selection = document.getSelection();
    if (!selection || !node) return;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    selection.removeAllRanges();
    selection.addRange(range);
}

/** The browser's own undo or redo, for the focused field. */
export function history(field: Element, step: "undo" | "redo"): void {
    (field as HTMLElement).focus({ preventScroll: true });
    command(step);
}

/** A picture's file name, from its address; "image" when it has none. */
export function imageName(src: string, type: string): string {
    let name = "";
    try {
        const url = new URL(src);
        if (url.protocol === "http:" || url.protocol === "https:") name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    } catch {
        name = "";
    }
    name = name.replace(/[\\/:*?"<>|]+/g, "").trim();
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
    const extension = type.split("/")[1]?.split(/[+;]/)[0] || "png";
    return `${name || "image"}.${extension === "jpeg" ? "jpg" : extension}`;
}

async function asPng(blob: Blob): Promise<Blob> {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png")
    );
}

/** Copies a picture as pixels; the desktop app copies whatever is drawn at
 *  the point, from any site. False when it could not. */
export async function copyImage(src: string, point: { readonly x: number; readonly y: number }): Promise<boolean> {
    const editing = desktopBridge()?.editing;
    if (editing && (await editing.copyImageAt(point.x, point.y).catch(() => false))) return true;
    try {
        const response = await fetch(src);
        if (!response.ok) return false;
        const png = await asPng(await response.blob());
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        return true;
    } catch {
        return false;
    }
}

function download(href: string, name: string): void {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
}

/** Saves a picture as a file. False when it could not. */
export async function saveImage(src: string): Promise<boolean> {
    const editing = desktopBridge()?.editing;
    if (editing && (await editing.saveImage(src).catch(() => false))) return true;
    try {
        const response = await fetch(src);
        if (!response.ok) return false;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        download(url, imageName(src, blob.type));
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return true;
    } catch {
        return false;
    }
}
