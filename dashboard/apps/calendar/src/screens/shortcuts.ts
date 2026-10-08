/**
 * The calendar's keyboard: the union of Nextcloud's and Google's shortcuts.
 *
 * Which key does what is the shared table's `calendar.*` (in @polaris/core), so
 * a key moved in Keyboard shortcuts is moved here and in the help at once.
 *
 * A key typed into a field is the field's, never a shortcut, and a key with
 * Ctrl, Cmd or Alt held belongs to the browser - the editor's own Ctrl/Cmd
 * shortcuts are handled by the editor, where they apply.
 */

import * as core from "@polaris/core";
import { shortcutBindings } from "@polaris/ui";
import { useEffect, useRef } from "react";
import type { CalendarViewName } from "../lib/preferences";

export type ShortcutAction =
    | { readonly kind: "previous" }
    | { readonly kind: "next" }
    | { readonly kind: "today" }
    | { readonly kind: "goTo" }
    | { readonly kind: "view"; readonly view: CalendarViewName }
    | { readonly kind: "create" }
    | { readonly kind: "open" }
    | { readonly kind: "delete" }
    | { readonly kind: "undo" }
    | { readonly kind: "search" }
    | { readonly kind: "refresh" }
    | { readonly kind: "settings" }
    | { readonly kind: "addCalendar" }
    | { readonly kind: "help" }
    | { readonly kind: "close" };

/** Each action, by the shared shortcut that triggers it. */
const ACTIONS: Readonly<Record<string, ShortcutAction>> = {
    "calendar.previous": { kind: "previous" },
    "calendar.next": { kind: "next" },
    "calendar.today": { kind: "today" },
    "calendar.goTo": { kind: "goTo" },
    "calendar.view.day": { kind: "view", view: "day" },
    "calendar.view.week": { kind: "view", view: "week" },
    "calendar.view.month": { kind: "view", view: "month" },
    "calendar.view.year": { kind: "view", view: "year" },
    "calendar.view.list": { kind: "view", view: "list" },
    "calendar.view.days": { kind: "view", view: "days" },
    "calendar.create": { kind: "create" },
    "calendar.open": { kind: "open" },
    "calendar.delete": { kind: "delete" },
    "calendar.undo": { kind: "undo" },
    "calendar.search": { kind: "search" },
    "calendar.refresh": { kind: "refresh" },
    "calendar.settings": { kind: "settings" },
    "calendar.addCalendar": { kind: "addCalendar" },
    "calendar.help": { kind: "help" },
    "calendar.close": { kind: "close" }
};
const ACTION_IDS = Object.keys(ACTIONS);

/** The editor's Ctrl/Cmd shortcuts, by the shared shortcut behind each. */
export type EditorShortcut = "save" | "delete" | "duplicate";
const EDITOR_ACTIONS: Readonly<Record<string, EditorShortcut>> = {
    "calendar.editor.save": "save",
    "calendar.editor.delete": "delete",
    "calendar.editor.duplicate": "duplicate"
};
const EDITOR_IDS = Object.keys(EDITOR_ACTIONS);

type Press = {
    readonly key: string;
    readonly code?: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey?: boolean;
};

/** Read field by field: a DOM event's keys are getters, which a spread drops. */
const plain = (event: Press) => ({
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey ?? false
});

/** Google's letter for each view, the one the view picker shows. */
export const VIEW_KEYS: Readonly<Record<CalendarViewName, string>> = {
    day: "d",
    week: "w",
    month: "m",
    year: "y",
    list: "a",
    days: "x"
};

/** The key the view picker shows for a view: Google's letter while it still
 *  opens that view, otherwise the first key that does now, or none. */
export function viewKey(
    bindings: ReadonlyMap<string, readonly string[]>,
    view: CalendarViewName
): string | null {
    const keys = core.keysOf(bindings, `calendar.view.${view}`);
    return keys.includes(VIEW_KEYS[view]) ? VIEW_KEYS[view] : (keys[0] ?? null);
}

/** Whether the key is going into something that takes text. */
export function isTyping(target: EventTarget | null): boolean {
    if (!target || typeof (target as HTMLElement).closest !== "function") return false;
    const element = target as HTMLElement;
    if (element.isContentEditable) return true;
    return (
        element.closest(
            "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], [role='listbox']"
        ) !== null
    );
}

/** What a key press means on the calendar, or null - against the keys in force,
 *  or the defaults when none are given. */
export function shortcutFor(
    event: Press & { readonly target: EventTarget | null },
    bindings: ReadonlyMap<string, readonly string[]> = core.resolveShortcuts()
): ShortcutAction | null {
    if (isTyping(event.target)) return null;
    const id = core.shortcutMatching(bindings, plain(event), ACTION_IDS);
    return id ? (ACTIONS[id] ?? null) : null;
}

export function editorShortcutFor(
    event: Press,
    bindings: ReadonlyMap<string, readonly string[]> = core.resolveShortcuts()
): EditorShortcut | null {
    const id = core.shortcutMatching(bindings, plain(event), EDITOR_IDS);
    return id ? (EDITOR_ACTIONS[id] ?? null) : null;
}

/**
 * Listen on the document while `enabled`. `handle` answers whether it acted, so
 * a key it did not use keeps its default (a Backspace with nothing selected).
 * Not while a dialog is open: its keys are its own.
 */
export function useShortcuts(enabled: boolean, handle: (action: ShortcutAction) => boolean): void {
    const handler = useRef(handle);
    handler.current = handle;
    useEffect(() => {
        if (!enabled) return;
        const listener = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            const action = shortcutFor(event, shortcutBindings());
            if (!action) return;
            const dialog = document.querySelector(
                "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"
            );
            if (dialog) return;
            if (handler.current(action)) event.preventDefault();
        };
        document.addEventListener("keydown", listener);
        return () => document.removeEventListener("keydown", listener);
    }, [enabled]);
}
