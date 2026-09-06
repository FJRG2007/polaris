/**
 * Telling an open Mail tab that its mailbox moved.
 *
 * The same in-process bus Chat and Tasks use, for the same reason: every writer
 * is in this server, so there is nothing for a broker to carry between. What
 * travels is which mailbox and which folder changed - never a message, never a
 * subject, never an address. A browser told that a folder moved pulls it through
 * the same service and the same ownership check that drew the screen, so a frame
 * can never turn into being shown mail that is not yours.
 *
 * The stream also filters by whose mailbox it is, so a frame for somebody else's
 * account is not even delivered. That is a second line rather than the reason
 * this is safe.
 */

/** Something worth waking a Mail tab for. */
export interface MailChange {
    readonly accountId: string;
    /** Whose mailbox it is. The only thing the stream filters on. */
    readonly actorId: string;
    /**
     * folders - the folder list or its counts moved, redraw the rail.
     * messages - a folder's contents changed, pull it again.
     * sending - a queued message changed state, so the composer's own tab and
     *     the Outbox both stop showing it as waiting.
     */
    readonly kind: "folders" | "messages" | "sending";
    /** Only on `messages`: which folder, so a tab looking at another one does
     *  nothing. */
    readonly folderId?: string;
}

type Listener = (change: MailChange) => void;

/** Held on globalThis rather than in a module binding, because a dev server
 *  re-evaluates a module on edit and a fresh Set would strand every connection
 *  opened against the previous copy. */
const REGISTRY = Symbol.for("polaris.mail.live");

interface Registry {
    listeners: Set<Listener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { listeners: new Set() };
    return holder[REGISTRY];
}

/** Announce a change. Never throws: a listener that fails is one dead browser
 *  connection, and it must not turn somebody's sent message into an error. */
export function publishMail(change: MailChange): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeMail(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}
