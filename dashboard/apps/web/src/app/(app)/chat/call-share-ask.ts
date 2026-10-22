"use client";

/**
 * A deck key asked this tab to share its screen.
 *
 * A browser opens its screen picker only from a press on the page itself
 * (`getDisplayMedia` needs the page's own user activation), so a key cannot
 * start a share the way it stops one. What it can do is put the share button in
 * front of the person: the call bar and the room both draw it, marked, for a
 * minute, and a notice outside the window brings the tab forward when it is not
 * being looked at. One click from there opens the picker.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

/** How long the marked button stays up after the key was pressed. */
export const SHARE_ASK_MS = 60_000;

let askedAt = 0;
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) listener();
}

/** Mark the share button: a key asked for it. */
export function askToShare(now: number = Date.now()): void {
    askedAt = now;
    changed();
}

/** Unmark it: the share started, or the key asked to stop. */
export function clearShareAsk(): void {
    if (askedAt === 0) return;
    askedAt = 0;
    changed();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Whether the share button is marked right now. Clears itself after a minute. */
export function useShareAsked(): boolean {
    const at = useSyncExternalStore(
        subscribe,
        () => askedAt,
        () => 0
    );
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!at) return;
        setNow(Date.now());
        const left = at + SHARE_ASK_MS - Date.now();
        if (left <= 0) return;
        const timer = window.setTimeout(() => setNow(Date.now()), left);
        return () => window.clearTimeout(timer);
    }, [at]);
    return at > 0 && now < at + SHARE_ASK_MS;
}
