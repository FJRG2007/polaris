"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the phone's account screen is open.
 *
 * Two controls open the one screen - the face in the header and the "You" tab
 * at the bottom - and they live in different parts of the frame, so the answer
 * lives here rather than in either of them. The screen itself is drawn once, by
 * the account menu (see AccountSheet).
 */

let open = false;
const listeners = new Set<() => void>();

export function setAccountSheetOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    for (const listener of listeners) listener();
}

export function useAccountSheetOpen(): boolean {
    return useSyncExternalStore(
        (notify) => {
            listeners.add(notify);
            return () => listeners.delete(notify);
        },
        () => open,
        () => false
    );
}
