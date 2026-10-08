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
 * Which key is which is the shared table's `drive.*`, so a key moved in
 * Keyboard shortcuts is moved here. Kept free of React and the DOM so the
 * mapping can be tested on its own.
 */

import * as core from "@polaris/core";

export type ExplorerShortcut =
    | "new-folder"
    | "new-file"
    | "upload-files"
    | "upload-folder"
    | "request-files";

/** The parts of a keyboard event that decide which shortcut was pressed. */
export interface ShortcutKey {
    readonly key: string;
    readonly code?: string;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly altKey?: boolean;
}

/** The shared shortcut behind each action - also what its menu hint reads. */
export const SHORTCUT_IDS: Record<ExplorerShortcut, string> = {
    "new-folder": "drive.newFolder",
    "new-file": "drive.newFile",
    "upload-files": "drive.uploadFiles",
    "upload-folder": "drive.uploadFolder",
    "request-files": "drive.requestFiles"
};

const ACTIONS = Object.keys(SHORTCUT_IDS) as ExplorerShortcut[];

/** The action a key press stands for, or null when it is not a shortcut - against
 *  the keys in force, or the defaults when none are given. */
export function matchShortcut(
    event: ShortcutKey,
    bindings: ReadonlyMap<string, readonly string[]> = core.resolveShortcuts()
): ExplorerShortcut | null {
    const id = core.shortcutMatching(
        bindings,
        {
            key: event.key,
            code: event.code,
            shiftKey: event.shiftKey ?? false,
            ctrlKey: event.ctrlKey ?? false,
            metaKey: event.metaKey ?? false,
            altKey: event.altKey ?? false
        },
        ACTIONS.map((action) => SHORTCUT_IDS[action])
    );
    return ACTIONS.find((action) => SHORTCUT_IDS[action] === id) ?? null;
}
