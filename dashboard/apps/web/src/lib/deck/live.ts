/**
 * Telling an account's open deck streams that something a key shows moved.
 *
 * A writer that changes what a deck key reads - Calendar pausing a timer, a
 * minute added from another device - says so here with the account and the
 * deck actions it touched, and every state stream that account has open with
 * one of those keys reads again at once, instead of on its next clock tick.
 *
 * The same in-process bus the chat and Tasks use: every writer is in this
 * server. What travels is only who and which actions; the stream reads the
 * state through the same tools and checks it always does.
 *
 * Best effort on purpose: nothing that writes may fail because telling a deck
 * about it did. Server-only.
 */

type Listener = (userId: string, actions: readonly string[]) => void;

const REGISTRY = Symbol.for("polaris.deck.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    holder[REGISTRY] ??= new Set();
    return holder[REGISTRY];
}

/** Announce that what these deck actions show changed for this account. Never
 *  throws. Asynchronous only because apps reach it through the host, where
 *  every service is. */
export async function deckChanged(userId: string, actions: readonly string[]): Promise<void> {
    for (const listener of listeners()) {
        try {
            listener(userId, actions);
        } catch (caught) {
            console.error("deck: a live listener failed", caught);
        }
    }
}

/** Hear about those changes until the returned function is called. */
export function onDeckChanged(listener: Listener): () => void {
    const held = listeners();
    held.add(listener);
    return () => held.delete(listener);
}
