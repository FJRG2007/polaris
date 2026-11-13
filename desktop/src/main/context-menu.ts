/**
 * The right-click menu in every window.
 *
 * Electron draws none of its own: without this, a right-click anywhere the page
 * itself does not answer - a link in a mail message, a selected sentence, a text
 * field - does nothing at all, where a browser would offer copy, paste and the
 * link. A page that handles the click itself (Polaris's own menus) cancels it,
 * and Electron then raises no `context-menu` event, so this never covers those.
 */

import { clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

/** What the menu is built from: the part of Electron's params it reads. */
export type MenuParams = Pick<ContextMenuParams, "linkURL" | "selectionText" | "isEditable" | "editFlags" | "misspelledWord" | "dictionarySuggestions">;

export interface ContextMenuActions {
    readonly openExternal: (url: string) => void;
    readonly copyText: (text: string) => void;
    readonly replaceMisspelling: (word: string) => void;
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

/** The menu for one right-click; empty when there is nothing to offer. */
export function contextMenuTemplate(params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
    const groups: MenuItemConstructorOptions[][] = [];
    if (params.isEditable && params.misspelledWord) {
        const suggestions = params.dictionarySuggestions.slice(0, 5);
        if (suggestions.length > 0) groups.push(suggestions.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) })));
    }
    const link = params.linkURL ? openableLink(params.linkURL) : null;
    if (link) {
        const address = link.startsWith("mailto:") ? link.slice("mailto:".length) : link;
        groups.push([
            { label: link.startsWith("mailto:") ? "Send email" : "Open link in browser", click: () => actions.openExternal(link) },
            { label: link.startsWith("mailto:") ? "Copy email address" : "Copy link", click: () => actions.copyText(address) }
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
    } else if (params.selectionText.trim()) {
        groups.push([{ role: "copy" }]);
    }
    return groups.flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

/** Answers right-clicks in one web contents, frames inside it included. */
export function installContextMenu(contents: WebContents): void {
    contents.on("context-menu", (_event, params) => {
        const template = contextMenuTemplate(params, {
            openExternal: (url) => void shell.openExternal(url),
            copyText: (text) => clipboard.writeText(text),
            replaceMisspelling: (word) => contents.replaceMisspelling(word)
        });
        if (template.length > 0) Menu.buildFromTemplate(template).popup();
    });
}
