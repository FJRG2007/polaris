/**
 * Carrying one person's typing to everybody else in the document.
 *
 * The same in-process bus Chat and Tasks run on, for the same reason: every
 * writer is inside this server, so there is nothing for a broker to carry
 * between, and a Redis dependency for a deployment that is one container is a
 * dependency to keep working forever. If Polaris ever runs replicas, the three
 * modules grow a transport together and nothing above any of them changes.
 *
 * **What travels here IS the content, and that is the one place Office differs
 * from Chat.** A chat frame carries an id and the reader pulls the message
 * through the same access check that drew the screen; a document cannot work
 * that way, because the whole point is that the other side sees the letter you
 * just typed within a frame or two, and a round trip per keystroke is not that.
 * So an update travels as bytes.
 *
 * Which makes the subscription the security boundary rather than a second line
 * of one. A browser is only ever joined to a document it has already been
 * resolved against, and every frame is addressed to one document id - see the
 * stream route, which resolves access once when the connection opens and refuses
 * anything it was not opened for.
 *
 * A Yjs update is also safe to lose and safe to repeat: it is a set of changes
 * rather than a version, so a frame that never arrives is repaired by the next
 * one, and one that arrives twice does nothing the second time. That is why this
 * needs no acknowledgement, no ordering and no replay.
 */

/** One document moved. */
export interface OfficeChange {
    readonly documentId: string;
    /**
     * The Yjs update, base64 for the wire.
     *
     * Bytes rather than the whole document: an update is what changed, so a
     * paragraph is a few dozen bytes however long the document is.
     */
    readonly update: string;
    /** Who typed it. A browser does not need waking for its own keystroke, and
     *  applying your own update back into your own document is how a cursor
     *  ends up jumping to the end of a line. */
    readonly actorId: string;
    /**
     * Which tab, when one person has two open.
     *
     * The actor is not enough: somebody with the document open on a laptop and a
     * phone is one account and two editors, and each of them has to hear the
     * other. Without this the second tab is silently read-only.
     */
    readonly originId: string;
}

type Listener = (change: OfficeChange) => void;

/** Held on `globalThis` for the reason every bus here is: a dev server
 *  re-evaluates the module and a fresh set would drop every open document. */
const REGISTRY = Symbol.for("polaris.office.live");

interface Registry {
    listeners: Set<Listener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { listeners: new Set() };
    return holder[REGISTRY];
}

/** Announce a change. Never throws: a listener that fails is one dead browser
 *  connection, and it must not turn somebody's keystroke into an error. */
export function publishOfficeChange(change: OfficeChange): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeOfficeChanges(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}
