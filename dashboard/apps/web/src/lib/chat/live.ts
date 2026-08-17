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

import type * as core from "@polaris/core";

/** What a call in a conversation just did. */
export type CallState = "ringing" | "moved" | "ended";

/** Something worth waking the other screens for. */
export interface ChatChange {
    readonly channelId: string;
    /** posted - a message arrived or changed, pull the channel again.
     *  channels - what this person can reach changed, redraw the rail.
     *  typing - somebody is composing right now.
     *  call - a call in this conversation started, moved or ended.
     *  read - somebody caught up here. Two screens act on it and nobody else:
     *      their own other devices, which have an unread count to take down, and
     *      the person they were reading, whose ticks have just moved. Addressed
     *      through `audience`, because who may know is a setting. */
    readonly kind: "posted" | "channels" | "typing" | "call" | "read";
    /** Who caused it. A tab does not need waking for its own write. */
    readonly actorId: string;
    /** Only on `typing` and `call`: what to draw beside the dots, or who is
     *  calling. */
    readonly actorName?: string;
    /** Only on `typing`: which of the two things that take a while they are
     *  doing. A recording is silence from the other side otherwise. */
    readonly activity?: core.ChatActivity;
    /**
     * Who this is for, when it is not for everybody in the channel.
     *
     * On `channels`: who should redraw, when the change is about one person
     * joining or leaving rather than about the channel itself. On `call`: whose
     * telephone should ring - adding somebody to a group call rings them, and
     * would otherwise ring the nine people who were already in the group and had
     * decided not to join. On `read`: the reader's own account, plus the one
     * other person in a one-to-one conversation where the ticks are theirs to
     * see - reaching a channel is not a reason to be told when somebody in it
     * opened a message.
     */
    readonly audience?: readonly string[];
    /**
     * Only on `call`: where the call has gone.
     *
     * A one-to-one call cannot take a third person - a direct message is between
     * the two it is keyed by - so bringing somebody in makes a group and moves
     * the call into it. This is what tells the other person's browser to follow
     * rather than to sit in a room that has quietly emptied.
     */
    readonly movedTo?: { readonly meetingId: string; readonly channelId: string };
    /**
     * Only on `call`.
     *
     * Starting a call posts no message, so without this nothing tells the rest
     * of the conversation that one is running - which is why the count beside
     * the call button used to be whatever it was when the screen last had a
     * reason to ask, differently wrong in every tab. `ringing` is the one that
     * makes somebody's browser sound: it is only sent when the room went from
     * empty to occupied, so walking into a call already in progress does not
     * ring the people already sitting in it.
     */
    readonly call?: {
        readonly meetingId: string;
        readonly state: CallState;
        readonly count: number;
    };
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
