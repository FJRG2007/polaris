"use client";

/**
 * Where a reader last was inside an app, kept in their browser.
 *
 * Leaving Tasks for Chat and coming back should reopen the list that was on
 * screen, not the app's front door - which is how every application with rooms
 * or lists behaves, and the thing whose absence reads as the app having
 * forgotten what you were doing.
 *
 * Per device rather than per account, and never sent anywhere: it is one
 * browser's idea of where its reader was, it changes several times a minute, and
 * nobody else has any business knowing. A screen that has since been deleted is
 * the one failure, and it lands on the app's own not-found page with a way back.
 */

const PREFIX = "polaris.place.";

/** Remember where this app was left. */
export function rememberPlace(appId: string, path: string): void {
    try {
        window.localStorage.setItem(PREFIX + appId, path);
    } catch {
        // Private browsing refuses the write, and so does a full quota. The app
        // opens on its front door instead, which is where it opened before.
    }
}

/** Where it was left, or null when this browser has never been there. Only a
 *  path inside the app is answered: a stored value from another version, or one
 *  somebody edited, must not become somewhere the switcher sends people. */
export function readPlace(appId: string, root: string): string | null {
    try {
        const stored = window.localStorage.getItem(PREFIX + appId);
        if (!stored || !stored.startsWith(`${root}/`)) return null;
        return stored;
    } catch {
        return null;
    }
}
