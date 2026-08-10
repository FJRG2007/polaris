"use client";

/**
 * What a Tasks screen was left looking like, kept in the browser.
 *
 * A saved view is the list's answer to how its work gets looked at, and changing
 * one changes it for whoever else opens it. This is the other half: one reader's
 * own arrangement of one screen - which view, grouped and sorted how, narrowed by
 * what - so the board they come back to is the board they left.
 *
 * It lives in localStorage rather than on the server for two reasons. It is read
 * before the first paint, so the screen opens arranged instead of arranging
 * itself a moment later; and it is nobody else's business, so it never costs a
 * write that the rest of the team would have to be told about.
 *
 * Two things it deliberately holds. Sort included, which is what lets an
 * arrangement somebody dragged into place survive the tab even on Everything,
 * where there is no list or space to hang a saved view on. Search excluded: a
 * half-typed name is a question asked once, and a screen that reopened still
 * narrowed to it looks empty for no reason anybody could see.
 */

import * as core from "@polaris/core";

const PREFIX = "polaris.tasks.view.";

/**
 * Which screen a preference belongs to.
 *
 * A list is its own screen; a space view is the space's; and Everything belongs
 * to no list and no space, so it is named outright rather than sharing a key
 * with whichever screen happened to have an empty id.
 */
export function viewScopeKey(listId: string | null, spaceId: string): string {
    return listId ?? (spaceId || "everything");
}

/** What that screen was left on, or null when this browser has never seen it. */
export function readViewPreferences(scope: string): core.TaskViewPreferences | null {
    try {
        const raw = window.localStorage.getItem(PREFIX + scope);
        if (!raw) return null;
        const parsed = core.taskViewPreferencesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        // A screen that will not open because a stored preference is malformed is
        // worse than one that forgets how it was arranged.
        return null;
    }
}

/** Remember it, now rather than on the way out: a tab that is closed, or a link
 *  followed away from, never gets the chance to save on leaving. */
export function writeViewPreferences(scope: string, preferences: core.TaskViewPreferences): void {
    try {
        window.localStorage.setItem(PREFIX + scope, JSON.stringify(preferences));
    } catch {
        // Private browsing refuses the write, and a full quota refuses it too.
        // The screen still works this visit; it just opens fresh the next one.
    }
}
