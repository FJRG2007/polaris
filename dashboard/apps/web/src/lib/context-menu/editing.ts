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
 * field first as a `paste` event, so an editor that handles pasting itself
 * (formatting, pictures, its own schema) does; a field that does not gets the
 * plain text typed in. Pasted HTML is never inserted by this file.
 */

import { desktopBridge } from "@/lib/desktop-bridge";

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

/** What is on the clipboard: the text, and HTML when there is some. */
export interface ClipboardContents {
    readonly text: string;
    readonly html: string | null;
}

/** Reads the clipboard; null when it was refused. `rich` asks for HTML too. */
export async function readClipboard(rich: boolean): Promise<ClipboardContents | null> {
    if (rich && typeof navigator.clipboard?.read === "function") {
        try {
            const items = await navigator.clipboard.read();
            let text = "";
            let html: string | null = null;
            for (const item of items) {
                if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
                if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
            }
            return { text, html };
        } catch {
            // Fall through to plain text.
        }
    }
    try {
        return { text: await navigator.clipboard.readText(), html: null };
    } catch {
        // Refused here: the desktop app's clipboard.
    }
    const text = await desktopBridge()?.editing?.readClipboard().catch(() => null);
    return typeof text === "string" ? { text, html: null } : null;
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

/**
 * Pastes into the field at its selection: offered as a `paste` event first,
 * then typed as plain text when nothing took it. `html` only travels inside
 * that event, for an editor that parses it through its own rules.
 */
export function pasteInto(field: Element, contents: ClipboardContents): void {
    try {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", contents.text);
        if (contents.html) transfer.setData("text/html", contents.html);
        const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
        if (!field.dispatchEvent(event)) return;
    } catch {
        // No DataTransfer to build one with: plain text below.
    }
    insertText(field, contents.text);
}

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
