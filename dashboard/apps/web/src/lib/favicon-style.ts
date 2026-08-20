"use client";

/**
 * What the tab icon is allowed to say, and where that choice is kept.
 *
 * Three answers, because people mean three different things by "tell me":
 *
 * - **Count** - the number waiting, drawn on the icon. What Polaris has always
 *   done, and still the default: it is the only one of the three that is worth
 *   anything without the page being opened.
 * - **Dot** - something is waiting, and that is all. What a phone puts on an app
 *   icon. Somebody who reads everything anyway does not need the number, and a
 *   number that keeps changing in the corner of the eye is what makes people
 *   close the tab.
 * - **Nothing** - the plain mark, whatever is waiting. Screen-shared, recorded,
 *   or simply not wanted.
 *
 * Kept on the device rather than on the account, for the same reason the chime
 * is: it is a property of the machine being looked at - a laptop on a call, a
 * shared desk - not of who is signed in. It follows from that that the choice
 * must reach the tab icon at once, in this tab and in the others: the `storage`
 * event carries it between tabs and the custom event carries it inside the one
 * that made the change, which fires no `storage` event for itself.
 */

import { badgeLabel } from "@/lib/notification-badge";
import type { FaviconBadge } from "@/lib/favicon";

export const FAVICON_STYLES = ["count", "dot", "none"] as const;

export type FaviconStyle = (typeof FAVICON_STYLES)[number];

/** The count, because an icon that says how much is the only one that saves
 *  somebody from opening the tab to find out. */
export const DEFAULT_FAVICON_STYLE: FaviconStyle = "count";

export const FAVICON_STYLE_LABEL: Record<FaviconStyle, string> = {
    count: "Count",
    dot: "Dot",
    none: "Nothing"
};

const STORAGE_KEY = "polaris.notifications.favicon";

/** Raised at the window when the choice changes here, since the browser only
 *  tells the *other* tabs about a write. */
const CHANGED_EVENT = "polaris:favicon-style";

/** Mirrors storage so the choice still holds when a write is refused. */
let chosen: FaviconStyle | null = null;

/** What this device chose, or the count it was never asked about. */
export function faviconStyle(): FaviconStyle {
    if (chosen === null) {
        let stored: string | null = null;
        try {
            stored = window.localStorage.getItem(STORAGE_KEY);
        } catch {
            // Private browsing refuses the read; the default holds for this visit.
        }
        chosen = asFaviconStyle(stored);
    }
    return chosen;
}

export function setFaviconStyle(next: FaviconStyle): void {
    chosen = next;
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Private browsing refuses the write; the choice holds for this visit.
    }
    window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Told whenever the choice changes - here, or in another tab of this browser.
 *  Returns the unsubscribe. */
export function onFaviconStyleChange(listener: () => void): () => void {
    const changed = () => {
        // Dropped rather than re-read here: the next `faviconStyle()` takes it
        // from storage, which is where the other tab put it.
        chosen = null;
        listener();
    };
    const stored = (event: StorageEvent) => {
        // A null key is the whole store being cleared, which changes this too.
        if (event.key !== null && event.key !== STORAGE_KEY) return;
        changed();
    };
    window.addEventListener("storage", stored);
    window.addEventListener(CHANGED_EVENT, changed);
    return () => {
        window.removeEventListener("storage", stored);
        window.removeEventListener(CHANGED_EVENT, changed);
    };
}

/** A stored value that may have been written by another build, or by hand. */
export function asFaviconStyle(value: string | null | undefined): FaviconStyle {
    return FAVICON_STYLES.includes(value as FaviconStyle) ? (value as FaviconStyle) : DEFAULT_FAVICON_STYLE;
}

/**
 * What to draw on the icon for `waiting` alerts under this choice. Null is a
 * plain mark: nothing is waiting, or the reader asked for nothing to be drawn.
 *
 * The count comes from the same `badgeLabel` the bell and the sidebar use, so
 * the icon and the interface never disagree about the number - including where
 * it stops, which is "9+": a 16px tab icon has room for two characters and the
 * exact figure past nine is not what anybody is reading it for.
 */
export function faviconBadge(style: FaviconStyle, waiting: number): FaviconBadge | null {
    if (style === "none") return null;
    const label = badgeLabel(waiting);
    if (!label) return null;
    return style === "dot" ? { kind: "dot" } : { kind: "count", label };
}
