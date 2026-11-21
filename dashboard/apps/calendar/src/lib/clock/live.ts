/**
 * Telling a person's open Time screens that their alarms, timers or stopwatch
 * moved.
 *
 * A timer paused from a Stream Deck, an alarm set through an assistant, a
 * stopwatch started on a phone - every one of them is a write in this server,
 * through `service.ts`, so the same in-process bus Chat and Tasks use is all it
 * takes: the service says whose clock changed, and every stream that account
 * has open tells its tab to read again.
 *
 * What travels is only the account id. The tab reads the snapshot through the
 * same route and checks it always does, so a frame can never hand anybody a row.
 *
 * Held on globalThis rather than in a module binding: the app's bundle may hold
 * more than one copy of this module, and a dev server re-evaluates it, and
 * either would otherwise strand every open stream on a set nobody writes to.
 *
 * Best effort on purpose: nothing that writes may fail because telling a
 * screen about it did. Server-only.
 */

type Listener = (userId: string) => void;

const REGISTRY = Symbol.for("polaris.calendar.clock.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    holder[REGISTRY] ??= new Set();
    return holder[REGISTRY];
}

/** Announce that this account's alarms, timers or stopwatch changed. Never
 *  throws. */
export function clockChanged(userId: string): void {
    for (const listener of listeners()) {
        try {
            listener(userId);
        } catch (caught) {
            console.error("calendar: a clock live listener failed", caught);
        }
    }
}

/** Hear about those changes until the returned function is called. */
export function onClockChanged(listener: Listener): () => void {
    const held = listeners();
    held.add(listener);
    return () => held.delete(listener);
}
