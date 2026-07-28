/**
 * Keyboard shortcuts for the explorer's create and upload actions.
 *
 * They are plain letters rather than the desktop combinations: Windows makes a
 * new folder with Ctrl+Shift+N, which a web page never receives - the browser
 * keeps it for a private window - and the same is true of most Ctrl+Shift pairs.
 * Single keys are what file managers on the web settle on, and they only fire
 * when the explorer itself has the keyboard (never while typing, renaming, or
 * with a dialog open) - that check belongs to the caller.
 *
 * Kept free of React and the DOM so the mapping can be tested on its own.
 */

export type ExplorerShortcut =
    | "new-folder"
    | "new-file"
    | "upload-files"
    | "upload-folder"
    | "request-files";

/** The parts of a keyboard event that decide which shortcut was pressed. */
export interface ShortcutKey {
    readonly key: string;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly altKey?: boolean;
}

/** How each shortcut is written next to its action in menus. */
export const SHORTCUT_HINTS: Record<ExplorerShortcut, string> = {
    "new-folder": "N",
    "new-file": "F",
    "upload-files": "U",
    "upload-folder": "Shift+U",
    "request-files": "R"
};

/** The action a key press stands for, or null when it is not a shortcut. */
export function matchShortcut(event: ShortcutKey): ExplorerShortcut | null {
    // A modifier means the press belongs to the browser or to an editing
    // shortcut (Ctrl+C, ...), never to these.
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    switch (event.key.toLowerCase()) {
        case "n":
            return event.shiftKey ? null : "new-folder";
        case "f":
            return event.shiftKey ? null : "new-file";
        case "u":
            return event.shiftKey ? "upload-folder" : "upload-files";
        case "r":
            return event.shiftKey ? null : "request-files";
        default:
            return null;
    }
}
