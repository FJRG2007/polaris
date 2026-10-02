/**
 * The calendar's keyboard: the union of Nextcloud's and Google's shortcuts.
 *
 * A key typed into a field is the field's, never a shortcut, and a key with
 * Ctrl, Cmd or Alt held belongs to the browser - the editor's own Ctrl/Cmd
 * shortcuts are handled by the editor, where they apply.
 */

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

const KEYS: Readonly<Record<string, ShortcutAction>> = {
    k: { kind: "previous" },
    p: { kind: "previous" },
    j: { kind: "next" },
    n: { kind: "next" },
    t: { kind: "today" },
    g: { kind: "goTo" },
    "1": { kind: "view", view: "day" },
    d: { kind: "view", view: "day" },
    "2": { kind: "view", view: "week" },
    w: { kind: "view", view: "week" },
    "3": { kind: "view", view: "month" },
    m: { kind: "view", view: "month" },
    "4": { kind: "view", view: "year" },
    y: { kind: "view", view: "year" },
    "5": { kind: "view", view: "list" },
    l: { kind: "view", view: "list" },
    a: { kind: "view", view: "list" },
    "6": { kind: "view", view: "days" },
    x: { kind: "view", view: "days" },
    c: { kind: "create" },
    e: { kind: "open" },
    Delete: { kind: "delete" },
    Backspace: { kind: "delete" },
    z: { kind: "undo" },
    "/": { kind: "search" },
    r: { kind: "refresh" },
    s: { kind: "settings" },
    "+": { kind: "addCalendar" },
    "?": { kind: "help" },
    Escape: { kind: "close" }
};

/** The overview's rows: the keys, and the catalog key that says what they do. */
export const SHORTCUT_ROWS = [
    { keys: ["k", "p"], label: "previous" },
    { keys: ["j", "n"], label: "next" },
    { keys: ["t"], label: "today" },
    { keys: ["g"], label: "goTo" }, // i18n-ignore: a catalog key
    { keys: ["1", "d"], label: "day" },
    { keys: ["2", "w"], label: "week" },
    { keys: ["3", "m"], label: "month" },
    { keys: ["4", "y"], label: "year" },
    { keys: ["5", "l", "a"], label: "list" },
    { keys: ["6", "x"], label: "days" },
    { keys: ["c"], label: "create" },
    { keys: ["e"], label: "open" },
    { keys: ["Delete", "Backspace"], label: "delete" },
    { keys: ["z"], label: "undo" },
    { keys: ["/"], label: "search" },
    { keys: ["r"], label: "refresh" },
    { keys: ["s"], label: "settings" },
    { keys: ["+"], label: "addCalendar" }, // i18n-ignore: a catalog key
    { keys: ["?"], label: "help" },
    { keys: ["Esc"], label: "close" }
] as const;

/** The grid's own, on a focused day or event (`grid-menu.tsx`). */
export const GRID_SHORTCUT_ROWS = [
    { keys: ["Left", "Right", "Up", "Down"], label: "moveFocus" }, // i18n-ignore: a catalog key
    { keys: ["Enter"], label: "createHere" }, // i18n-ignore: a catalog key
    { keys: ["Shift+F10"], label: "menu" }
] as const;

/** Copying and pasting events, with Ctrl (Cmd on a Mac). */
export const CLIPBOARD_SHORTCUT_ROWS = [
    { keys: ["C"], label: "copy" },
    { keys: ["V"], label: "paste" }
] as const;

/** The editor's own, with Ctrl (Cmd on a Mac). */
export const EDITOR_SHORTCUT_ROWS = [
    { keys: ["Enter"], label: "save" },
    { keys: ["S"], label: "save" },
    { keys: ["Delete"], label: "deleteEvent" }, // i18n-ignore: a catalog key
    { keys: ["D"], label: "duplicate" }
] as const;

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

/** What a key press means on the calendar, or null. */
export function shortcutFor(
    event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">
): ShortcutAction | null {
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    if (isTyping(event.target)) return null;
    return KEYS[event.key] ?? KEYS[event.key.toLowerCase()] ?? null;
}

/** The editor's Ctrl/Cmd shortcuts. */
export type EditorShortcut = "save" | "delete" | "duplicate";

export function editorShortcutFor(
    event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">
): EditorShortcut | null {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
    const key = event.key.toLowerCase();
    if (key === "enter" || key === "s") return "save";
    if (key === "delete" || key === "backspace") return "delete";
    if (key === "d") return "duplicate";
    return null;
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
            const action = shortcutFor(event);
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
