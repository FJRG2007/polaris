"use client";

/**
 * How wide somebody left a panel, kept in this browser.
 *
 * The same reasoning as the Tasks view preferences next door: it is read before
 * the first paint, so the screen opens at the size it was left rather than
 * snapping to it a moment later, and it is nobody else's business, so it never
 * costs a write anyone else has to be told about.
 *
 * Kept per runtime, which is the part that is not obvious. The desktop app and a
 * browser tab are the same screen at different sizes - the app has no browser
 * chrome and is usually the window somebody sizes deliberately, a tab is
 * whatever is left after everything else - and one remembered width shared
 * between them means every switch lands on a layout that was chosen for the
 * other one.
 *
 * Every read is clamped rather than trusted. A stored number is a number
 * somebody could have edited, and a limit that only exists while dragging is a
 * limit that stops existing the moment localStorage is touched by hand - which
 * would open the screen with a panel taking the whole window and no divider left
 * on screen to drag back.
 */

import { z } from "zod";
import { desktopBridge } from "@/lib/desktop-bridge";

const PREFIX = "polaris.chat.pane.";

/** A size is a number of pixels and nothing else; anything stored under one of
 *  these keys that is not one is treated as never having been written. */
const sizeSchema = z.number().finite().positive();

/** Which runtime this is, as the half of the key that separates them. The app
 *  puts its bridge on the page and a browser has none, so this is the same
 *  question `useDesktopBridge` answers, asked where a hook cannot go. */
function runtime(): string {
    try {
        return desktopBridge() ? "app" : "web";
    } catch {
        return "web";
    }
}

function keyFor(pane: string): string {
    return `${PREFIX}${pane}.${runtime()}`;
}

function clamp(size: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, size));
}

/**
 * What that panel was left at, or the fallback when this browser has never seen
 * it - already inside the limits either way.
 */
export function readPaneSize(
    pane: string,
    bounds: { readonly min: number; readonly max: number; readonly fallback: number }
): number {
    // The same read, and the same reasons to refuse one - a value nobody wrote,
    // a value that is not a size, a browser that will not be read from at all.
    // What separates the two is only what is said when there is no answer, so
    // the key, the parse and the limits are decided in one place.
    return storedPaneSize(pane, bounds) ?? clamp(bounds.fallback, bounds.min, bounds.max);
}

/**
 * What that panel was left at, or null when nobody has ever decided.
 *
 * The difference matters for a panel whose default is a share of the screen
 * rather than a number of pixels. Handed the fallback, such a panel would be
 * pinned to whatever that share came to in the window it was first drawn in, and
 * would stop following the window from then on - so the caller needs to know that
 * the answer is "nobody said", not "they said this".
 */
export function storedPaneSize(
    pane: string,
    bounds: { readonly min: number; readonly max: number }
): number | null {
    try {
        const raw = window.localStorage.getItem(keyFor(pane));
        if (!raw) return null;
        const parsed = sizeSchema.safeParse(Number(raw));
        return parsed.success ? clamp(parsed.data, bounds.min, bounds.max) : null;
    } catch {
        return null;
    }
}

/** Remember it, now. */
export function writePaneSize(pane: string, size: number): void {
    try {
        window.localStorage.setItem(keyFor(pane), String(Math.round(size)));
    } catch {
        // A refused write costs this visit's arrangement and nothing else.
    }
}

/**
 * How long after the last move the size is actually written.
 *
 * Short enough that letting go of the divider and closing the tab in the same
 * breath still keeps it, long enough that a drag is one write rather than one per
 * frame of it.
 */
const SETTLE_MS = 200;

/** What a drag has moved but nothing has written yet, by panel. */
const pending = new Map<string, number>();
let settling: number | null = null;
let watching = false;

/**
 * Write whatever a drag left behind, now.
 *
 * Exported because the way out of a page is not a pause: a tab being closed or
 * hidden gets no quiet moment afterwards for a timer to fire in, so the listeners
 * below call this and the last position is kept rather than lost with the timer.
 */
export function flushPaneSizes(): void {
    const held = [...pending];
    pending.clear();
    for (const [pane, size] of held) writePaneSize(pane, size);
}

/** Once, and only from a browser: the two moments a page stops being able to
 *  finish anything it has put off. `pagehide` covers the tab going away, hidden
 *  covers a phone where that is the only one of the two that is ever fired. */
function watchForTheWayOut(): void {
    if (watching) return;
    try {
        window.addEventListener("pagehide", flushPaneSizes);
        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") flushPaneSizes();
        });
        // Only once both are on, so that a browser which refused them is asked
        // again on the next drag rather than written off for the whole visit.
        watching = true;
    } catch {
        // Nothing to hang the listeners on. The write below still happens; only
        // the last few hundred milliseconds of a drag are at risk.
    }
}

/**
 * Remember it, as it is dragged rather than on the way out: a tab that is closed
 * or navigated away from never gets a last word.
 *
 * Held for a moment first, because a divider reports every pixel it moves and
 * `localStorage` is written on the same thread that is drawing the drag - one
 * synchronous write per frame, for a number only the last of which anybody will
 * ever read back.
 */
export function savePaneSize(pane: string, size: number): void {
    pending.set(pane, size);
    watchForTheWayOut();
    try {
        if (settling !== null) window.clearTimeout(settling);
        settling = window.setTimeout(() => {
            settling = null;
            flushPaneSizes();
        }, SETTLE_MS);
    } catch {
        // No timer to wait on, so there is nothing to wait for.
        flushPaneSizes();
    }
}

/** Forget it, which is what a double press on the divider means. */
export function forgetPaneSize(pane: string): void {
    // Before the storage, because a drag ending in a double press leaves a size
    // held here that would otherwise be written back moments after the reset.
    pending.delete(pane);
    try {
        window.localStorage.removeItem(keyFor(pane));
    } catch {
        // Nothing to undo: the value it would have removed is unreachable anyway.
    }
}

/** Everything on screen that holds a size, told when the whole layout is put back. */
const resetListeners = new Set<() => void>();

/**
 * Hear about "Reset layout". Returns the way to stop hearing it.
 *
 * Every panel holds its own size in its own state, so forgetting the stored
 * numbers is only half of putting the layout back: the panels already on
 * screen have to be told to go back to their defaults too.
 */
export function onLayoutReset(listener: () => void): () => void {
    resetListeners.add(listener);
    return () => resetListeners.delete(listener);
}

/**
 * Put every panel back where it started: forget each size this runtime
 * remembers and tell whatever is drawn now.
 *
 * Only this runtime's, for the same reason each size is kept per runtime - the
 * desktop app's layout is a separate decision from a browser tab's.
 */
export function resetPaneLayout(): void {
    pending.clear();
    try {
        const suffix = `.${runtime()}`;
        const keys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index++) {
            const key = window.localStorage.key(index);
            if (key?.startsWith(PREFIX) && key.endsWith(suffix)) keys.push(key);
        }
        for (const key of keys) window.localStorage.removeItem(key);
    } catch {
        // Nothing stored to forget; the panels below still go back.
    }
    for (const listener of [...resetListeners]) listener();
}
