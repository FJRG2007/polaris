"use client";

/**
 * What Ctrl+C put on the clipboard, kept in the browser.
 *
 * A paste is nearly always somewhere else: another list, another space, a screen
 * reached by a link. React state does not survive that navigation and neither
 * does a module variable once the route unmounts, so the ids live in
 * localStorage - which also means a copy made in one tab pastes in the next one,
 * the way a clipboard is expected to behave.
 *
 * Only ids and a label are held. Nothing about a task is cached here: what the
 * paste actually copies is read on the server at the moment it lands, so a
 * clipboard left sitting for an hour pastes what the task says now rather than
 * what it said when it was copied. Ids that have since gone, or that the person
 * pasting may not read, are dropped by the action.
 */

const KEY = "polaris.tasks.clipboard";

export interface TaskClipboard {
    readonly taskIds: readonly string[];
    /** What was copied, for the line the paste reports back. */
    readonly label: string;
}

export function writeTaskClipboard(entry: TaskClipboard): void {
    try {
        window.localStorage.setItem(KEY, JSON.stringify(entry));
    } catch {
        // Private browsing refuses the write, and so does a full quota. Copy
        // then does nothing rather than breaking the screen; paste finds
        // nothing and says so.
    }
}

export function readTaskClipboard(): TaskClipboard | null {
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        const held = parsed as { taskIds?: unknown; label?: unknown } | null;
        const ids = Array.isArray(held?.taskIds)
            ? held.taskIds.filter((id): id is string => typeof id === "string")
            : [];
        if (ids.length === 0) return null;
        return { taskIds: ids, label: typeof held?.label === "string" ? held.label : "" };
    } catch {
        return null;
    }
}
