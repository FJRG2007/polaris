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
    try {
        const raw = window.localStorage.getItem(keyFor(pane));
        if (!raw) return clamp(bounds.fallback, bounds.min, bounds.max);
        const parsed = sizeSchema.safeParse(Number(raw));
        if (!parsed.success) return clamp(bounds.fallback, bounds.min, bounds.max);
        return clamp(parsed.data, bounds.min, bounds.max);
    } catch {
        // Private browsing refuses the read outright. A panel that opens at its
        // usual width is a smaller loss than a screen that will not open.
        return clamp(bounds.fallback, bounds.min, bounds.max);
    }
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

/** Remember it, as it is dragged rather than on the way out: a tab that is closed
 *  or navigated away from never gets a last word. */
export function writePaneSize(pane: string, size: number): void {
    try {
        window.localStorage.setItem(keyFor(pane), String(Math.round(size)));
    } catch {
        // A refused write costs this visit's arrangement and nothing else.
    }
}

/** Forget it, which is what a double press on the divider means. */
export function forgetPaneSize(pane: string): void {
    try {
        window.localStorage.removeItem(keyFor(pane));
    } catch {
        // Nothing to undo: the value it would have removed is unreachable anyway.
    }
}
