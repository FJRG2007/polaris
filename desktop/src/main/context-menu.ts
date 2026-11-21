/**
 * The right-click menu in every window.
 *
 * Electron draws none of its own: without this, a right-click anywhere the page
 * itself does not answer - a link in a mail message, a selected sentence, a text
 * field - does nothing at all, where a browser would offer copy, paste and the
 * link. A page that handles the click itself (Polaris's own menus) cancels it,
 * and Electron then raises no `context-menu` event, so this never covers those.
 *
 * The shape follows what browsers and electron-context-menu settled on:
 * spelling first, then the link, the image, the selection, and the edit roles.
 *
 * A dashboard from this release on answers every right-click itself, with its
 * own menu (`components/context-menu-fallback.tsx` there), and asks for the
 * spelling checker and the clipboard through the `editing` bridge instead - so
 * this menu is what an older Polaris, which still lets some clicks through,
 * and this app's own pages get. The checks those bridge calls run are here too.
 */

import { openExternal } from "./open-external";
import { clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

/** What the menu is built from: the part of Electron's params it reads. */
export type MenuParams = Pick<ContextMenuParams, "linkURL" | "selectionText" | "isEditable" | "editFlags" | "misspelledWord" | "dictionarySuggestions" | "mediaType" | "srcURL" | "hasImageContents" | "formControlType">;

export interface ContextMenuActions {
    readonly openExternal: (url: string) => void;
    readonly copyText: (text: string) => void;
    readonly replaceMisspelling: (word: string) => void;
    readonly addToDictionary: (word: string) => void;
    /** Copies the image under the pointer, as pixels. */
    readonly copyImage: () => void;
    /** Downloads `url`, which asks where to save it. */
    readonly saveImage: (url: string) => void;
}

/** How long a selection may be in the Search label before it is cut. */
const SEARCH_LABEL_LENGTH = 30;

/** The web search a selection is looked up with. */
export function searchAddress(text: string): string {
    return `https://www.google.com/search?q=${encodeURIComponent(text.trim().replace(/\s+/g, " "))}`;
}

/** The selection, on one line and short enough for a menu item. */
export function searchLabel(text: string): string {
    const line = text.trim().replace(/\s+/g, " ");
    const shown = line.length > SEARCH_LABEL_LENGTH ? `${line.slice(0, SEARCH_LABEL_LENGTH - 3).trimEnd()}...` : line;
    return `Search Google for "${shown}"`;
}

/** Longest word the dictionary takes; anything longer is not a word. */
const WORD_MAX = 64;

/** A word the page asks to add to the dictionary, or null when it is not one. */
export function dictionaryWord(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const word = raw.trim();
    return word.length > 0 && word.length <= WORD_MAX && /^[\p{L}\p{M}'’-]+$/u.test(word) ? word : null;
}

/** More text than anybody copies by hand; past it the request is refused. */
export const CLIPBOARD_TEXT_MAX = 16 * 1024 * 1024;

/** Text the page asks to put on the clipboard, or null. */
export function clipboardText(raw: unknown): string | null {
    return typeof raw === "string" && raw.length <= CLIPBOARD_TEXT_MAX ? raw : null;
}

/**
 * A point the page names, in CSS pixels, as the web contents' own coordinates:
 * scaled by the zoom the window is drawn at. Null for anything not a point on
 * the page.
 */
export function pagePoint(x: unknown, y: unknown, zoom: number): { readonly x: number; readonly y: number } | null {
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || !Number.isFinite(zoom) || zoom <= 0) return null;
    return { x: Math.round(x * zoom), y: Math.round(y * zoom) };
}

/** An image the page asks to save: an address or inline data, never a file
 *  on this computer or an app's own scheme. */
export function savableImageUrl(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length > CLIPBOARD_TEXT_MAX || !savableImage(raw)) return null;
    return raw;
}

/** An image that can be saved: one the page loaded from an address or inline. */
function savableImage(url: string): boolean {
    try {
        return ["http:", "https:", "data:", "blob:"].includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

/** Only these leave the app for the system's browser or mail client. */
export function openableLink(url: string): string | null {
    try {
        const parsed = new URL(url);
        return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
}

/**
 * The address a selection is, when the whole selection is one: an address
 * printed as text (a terminal, a log, a code block) is not a link, so without
 * this it offered only Copy. Only http and https - a selected word with a colon
 * in it is not a mail link.
 */
export function linkInSelection(text: string): string | null {
    const trimmed = text.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
    return openableLink(trimmed.replace(/[.,;:!?)\]}>"']+$/, ""));
}

/** The menu for one right-click; empty when there is nothing to offer. */
export function contextMenuTemplate(params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
    const groups: MenuItemConstructorOptions[][] = [];
    if (params.isEditable && params.misspelledWord) {
        const suggestions = params.dictionarySuggestions.slice(0, 5);
        const word = params.misspelledWord;
        groups.push([
            ...(suggestions.length > 0 ? suggestions.map((suggestion) => ({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) })) : [{ label: "No spelling suggestions", enabled: false }]),
            { type: "separator" as const },
            { label: "Add to dictionary", click: () => actions.addToDictionary(word) }
        ]);
    }
    const link = (params.linkURL ? openableLink(params.linkURL) : null) ?? linkInSelection(params.selectionText);
    if (link) {
        const address = link.startsWith("mailto:") ? link.slice("mailto:".length) : link;
        groups.push([
            { label: link.startsWith("mailto:") ? "Send email" : "Open link in browser", click: () => actions.openExternal(link) },
            { label: link.startsWith("mailto:") ? "Copy email address" : "Copy link", click: () => actions.copyText(address) }
        ]);
    }
    if (params.mediaType === "image" && params.srcURL) {
        const image = params.srcURL;
        const address = image.startsWith("http:") || image.startsWith("https:") ? image : null;
        groups.push([
            ...(params.hasImageContents ? [{ label: "Copy image", click: () => actions.copyImage() }] : []),
            ...(address ? [{ label: "Copy image address", click: () => actions.copyText(address) }] : []),
            ...(savableImage(image) ? [{ label: "Save image as...", click: () => actions.saveImage(image) }] : [])
        ]);
    }
    const selection = params.selectionText.trim();
    if (selection) {
        // A field copies through its own group below; a password is never sent to a search engine.
        const searchable = !link && params.formControlType !== "input-password";
        groups.push([
            ...(params.isEditable ? [] : [{ role: "copy" as const }]),
            ...(searchable ? [{ label: searchLabel(selection), click: () => actions.openExternal(searchAddress(selection)) }] : [])
        ]);
    }
    if (params.isEditable) {
        groups.push([
            { role: "undo", enabled: params.editFlags.canUndo },
            { role: "redo", enabled: params.editFlags.canRedo }
        ]);
        groups.push([
            { role: "cut", enabled: params.editFlags.canCut },
            { role: "copy", enabled: params.editFlags.canCopy },
            { role: "paste", enabled: params.editFlags.canPaste },
            { role: "selectAll", enabled: params.editFlags.canSelectAll }
        ]);
    }
    return groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

/** Answers right-clicks in one web contents, frames inside it included. */
export function installContextMenu(contents: WebContents): void {
    contents.on("context-menu", (_event, params) => {
        const template = contextMenuTemplate(params, {
            openExternal: (url) => openExternal(url),
            copyText: (text) => clipboard.writeText(text),
            replaceMisspelling: (word) => contents.replaceMisspelling(word),
            addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
            copyImage: () => contents.copyImageAt(params.x, params.y),
            saveImage: (url) => contents.downloadURL(url)
        });
        if (template.length > 0) Menu.buildFromTemplate(template).popup();
    });
}
