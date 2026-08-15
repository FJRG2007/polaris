/**
 * Telling the other people in a channel that something was said.
 *
 * The same in-process bus Tasks uses, for the same reason: every writer is in
 * this server, so there is nothing for a broker to carry between, and a Redis
 * dependency for a deployment that is one container is a dependency to keep
 * working forever. If Polaris ever runs replicas, this module and the Tasks one
 * grow a transport together and nothing above either changes.
 *
 * What travels is the fact that a channel moved and, for typing, who is typing.
 * Never the message. A reader is handed the id and pulls the message through the
 * same service and the same access check that drew the channel in the first
 * place, so a frame can never turn into being shown something you are not in.
 * The stream also filters by what the reader reaches, so a frame for a channel
 * they are not in is not even delivered - but that filter is a second line, not
 * the reason this is safe.
 *
 * Typing is the exception and carries a name, because there is no second request
 * that would make it worth having: by the time you pulled who was typing, they
 * have stopped. It is only ever sent to a reader the stream has already resolved
 * as being in that channel.
 */

/** Something worth waking the other screens for. */
export interface ChatChange {
    readonly channelId: string;
    /** posted - a message arrived or changed, pull the channel again.
     *  channels - what this person can reach changed, redraw the rail.
     *  typing - somebody is composing right now. */
    readonly kind: "posted" | "channels" | "typing";
    /** Who caused it. A tab does not need waking for its own write. */
    readonly actorId: string;
    /** Only on `typing`: what to draw beside the dots. */
    readonly actorName?: string;
    /** Only on `channels`: who should redraw, when the change is about one
     *  person joining or leaving rather than about the channel itself. */
    readonly audience?: readonly string[];
}

type Listener = (change: ChatChange) => void;

/**
 * Held on globalThis rather than in a module binding. A dev server re-evaluates
 * a module on edit, and a fresh module-scoped Set would strand every connection
 * opened against the previous copy.
 */
const REGISTRY = Symbol.for("polaris.chat.live");

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
export function publishChatChange(change: ChatChange): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeChatChanges(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}
