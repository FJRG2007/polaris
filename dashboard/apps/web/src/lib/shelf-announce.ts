/**
 * The shelf somebody just picked in the header, before the server has drawn it.
 *
 * Switching shelf is a server action that answers with the whole signed-in
 * frame rendered again, and nothing moves until it lands - which is as long as
 * the slower of the two shelves takes to count its mail. A screen that can draw
 * the other shelf from what this device kept (Mail's list) does not have to
 * wait for that: the switcher announces where it is going, the screen draws
 * that shelf at once, and the server's render takes over when it arrives.
 *
 * Each announcement says which shelf it left, and only counts while the server
 * still says that one: once the new frame lands the announcement is moot on its
 * own, and one left behind by a switch made while no such screen was open can
 * never pull a later screen onto a shelf the server is not on. A refused switch
 * withdraws it, which puts the screen back where it was.
 */

import { useSyncExternalStore } from "react";

/** A switch on its way: from the shelf on screen to the one picked. Both are
 *  shelf keys - "personal" or an organization's id. */
export interface ShelfAnnouncement {
    readonly from: string;
    readonly to: string;
}

let announced: ShelfAnnouncement | null = null;
const listeners = new Set<() => void>();

/** Say where the header is switching to, or withdraw it with null. */
export function announceShelf(next: ShelfAnnouncement | null): void {
    if (next !== null && next.from === next.to) next = null;
    if (announced === next) return;
    announced = next;
    for (const listener of listeners) listener();
}

export function announcedShelf(): ShelfAnnouncement | null {
    return announced;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The switch on its way, for a screen that draws ahead of the server. */
export function useAnnouncedShelf(): ShelfAnnouncement | null {
    return useSyncExternalStore(subscribe, announcedShelf, () => null);
}

/**
 * The shelf a screen should draw: the one the server rendered, or the one being
 * switched to while the server still says the shelf it was switched from.
 * `followsHeader` is false for a screen that ignores the header's shelf (Mail
 * set to show every mailbox).
 */
export function shelfAhead(
    server: string,
    switching: ShelfAnnouncement | null,
    followsHeader: boolean
): string {
    return followsHeader && switching !== null && switching.from === server
        ? switching.to
        : server;
}
