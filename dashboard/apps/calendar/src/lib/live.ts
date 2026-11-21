/**
 * Telling the open calendar screens that an event or task in one calendar
 * changed.
 *
 * An event moved through an assistant's calendar tool, an invitation answered
 * from a mail link, a Stream Deck key, another tab or device - every one of them
 * is a write in this server that ends in `afterObjectChange`, so the same
 * in-process bus Chat, Tasks and the Time screen use is all it takes: the write
 * says which calendar moved, and every stream whose reader reaches that calendar
 * tells its tab to read again.
 *
 * What travels is only the calendar and whose it is. The tab reads its window through the
 * same route and checks it always does, so a frame can never hand anybody a row.
 *
 * Held on globalThis rather than in a module binding: the app's bundle may hold
 * more than one copy of this module, and a dev server re-evaluates it, and
 * either would otherwise strand every open stream on a set nobody writes to.
 *
 * Best effort on purpose: nothing that writes may fail because telling a
 * screen about it did. Server-only.
 */

/** Which calendar changed, and whose it is: its owner's stream wakes even for a
 *  calendar created after that stream opened. */
export interface CalendarChange {
    readonly calendarId: string;
    readonly ownerId: string;
}

type Listener = (change: CalendarChange) => void;

const REGISTRY = Symbol.for("polaris.calendar.events.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    holder[REGISTRY] ??= new Set();
    return holder[REGISTRY];
}

/** Announce that something in this calendar changed. Never throws. */
export function calendarChanged(change: CalendarChange): void {
    for (const listener of listeners()) {
        try {
            listener(change);
        } catch (caught) {
            console.error("calendar: an events live listener failed", caught);
        }
    }
}

/** Hear about those changes until the returned function is called. */
export function onCalendarChanged(listener: Listener): () => void {
    const held = listeners();
    held.add(listener);
    return () => held.delete(listener);
}
