/**
 * Telling the other people in a channel that something was said.
 *
 * Delivered in this process through an index of listeners by conversation and
 * by account, and to every other dashboard replica through Postgres
 * LISTEN/NOTIFY (`live-transport.ts`): every install already has Postgres
 * between its writers, so a second replica needs no broker to be set up.
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
    /** Absent only on a `channels` change that is not about one conversation:
     *  a preference set for a whole space is about every channel in it, and
     *  naming one of them would be a lie the stream then filters on. */
    readonly channelId?: string;
    /** posted - a message arrived or changed, pull the channel again.
     *  channels - what this person can reach changed, redraw the rail.
     *  typing - somebody is composing right now.
     *  call - a call in this conversation started, moved or ended.
     *  appearance - somebody changed what their face looks like. Carries the id
     *      and nothing about the appearance: a browser drawing that face pulls
     *      it through the same endpoint it pulled the first one through, and a
     *      browser not drawing it does nothing at all.
     *  activity - what somebody is playing or listening to changed. Carried
     *      exactly like `appearance`: the id and the rooms, never the activity,
     *      which a browser drawing that face pulls through the presence
     *      endpoint and its privacy check.
     *  read - somebody caught up here. Two screens act on it and nobody else:
     *      their own other devices, which have an unread count to take down, and
     *      the person they were reading, whose ticks have just moved. Addressed
     *      through `audience`, because who may know is a setting.
     *  delivered - a device of somebody here now holds what arrived. For the
     *      other members alone (`audience`), whose ticks go from one to two;
     *      the person's own screens have nothing to move.
     *  pins - a message was pinned or unpinned here; the bar above the
     *      conversation reads its pins again.
     *  emoji - a space's own emoji were added, renamed or removed. Carries the
     *      space and its rooms, never an emoji: a tab that reaches one of the
     *      rooms asks for the list again through the same check.
     *  call-settled - somebody declined a call ringing for them on one of their
     *      devices. Sent to that person alone (`audience`), so every other
     *      device and tab of theirs stops ringing too.
     *  draft - Polar's answer to a mention as far as it has written it, so the
     *      conversation reads it growing. Never coalesced and never stored: the
     *      answer is posted as an ordinary message when it is done.
     *  badge - somebody cleared Chat's badge from the app list. Sent to that
     *      person alone (`audience`), so the badge on their other screens counts
     *      again. Nothing inside Chat moves: no conversation was read. */
    readonly kind:
        | "posted"
        | "channels"
        | "typing"
        | "call"
        | "appearance"
        | "read"
        | "delivered"
        | "activity"
        | "pins"
        | "emoji"
        | "game-invite"
        | "call-settled"
        | "badge"
        | "draft";
    /** Only on `read`: the mark moved BACKWARDS - somebody put a conversation
     *  back to unread. The same fact changing, so it is the same frame, but the
     *  opposite instruction for anything that withdraws a notice about it. */
    readonly unread?: true;
    /**
     * Only on `posted`: the messages that changed in place - edited, reacted to,
     * deleted, voted on - rather than arrived.
     *
     * A screen answers a bare `posted` by asking for what is newer than what it
     * holds, and a message that changed is not newer: without these ids a
     * deletion, an edit or a reaction reached every other screen as a wake that
     * fetched nothing, and stayed as it was until somebody reloaded. Ids only,
     * never what they say: the screen reads them again through the same check
     * that drew them.
     */
    readonly messageIds?: readonly string[];
    /** Who caused it. A tab does not need waking for its own write. */
    readonly actorId: string;
    /** Only on `emoji`: whose list changed. */
    readonly spaceId?: string;
    /** Only on `game-invite`: the game session somebody was invited to. Sent to
     *  its `audience` alone, who read the invitation through its own check. */
    readonly sessionId?: string;
    /**
     * Only on `draft`. `key` is the message being answered, one draft per
     * mention. `text` is everything written so far - never a piece - so a missed
     * frame is put right by the next; empty takes the draft back (the model went
     * to its tools, or its answer was refused). `messageId` is the answer once it
     * is posted: the draft stays until that message is on screen in its place.
     */
    readonly draft?: {
        readonly key: string;
        readonly parentId: string | null;
        readonly text: string;
        readonly messageId?: string;
    };
    /** Only on `call-settled`: the call that stopped ringing. */
    readonly meetingId?: string;
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
     * Only on `appearance`, `activity` and `emoji`: the conversations the
     * person is in, or the ones in the space whose emoji changed.
     *
     * How the fan-out is kept honest. Somebody changing their decoration is
     * news to the people who might be looking at their face, which is the people
     * they share a room with - so the frame carries the rooms and every stream
     * keeps it only if the reader reaches one of them. Bounded by that one
     * person's own membership, which is dozens, rather than by how many accounts
     * exist.
     */
    readonly channels?: readonly string[];
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
        /** Only somebody's mute or deafen changed: a roster redraws, nothing
         *  about who is in the call does. */
        readonly voice?: true;
        /** The group a call is ringing in, so the card can say where as well
         *  as who. Absent for a one-to-one, which is only ever the caller. */
        readonly group?: CallGroup;
        /** The accounts seated in it, while the room is small enough to name
         *  (`MOST_SEATED_NAMED`): sitting with somebody answers their missed
         *  calls on every screen. Absent from an ended call and a large room. */
        readonly seated?: readonly string[];
    };
}

/** Which group a call is in, as the ringing card names it: its own name, or how
 *  many are in it when nobody gave it one. */
export interface CallGroup {
    readonly name: string | null;
    readonly size: number;
}

type Listener = (change: ChatChange) => void;

/**
 * Whose changes a listener is after: one account, and the conversations it
 * reaches. A listener with an interest is indexed under both, so a message is
 * handed only to the listeners of its own conversation and the accounts it
 * names, never offered to every open connection to be turned down by each.
 * Discord's guild process fans out the same way: to the sessions of that
 * guild, not to every session on the gateway (discord.com/blog/maxjourney-
 * pushing-discords-limits-with-a-million-plus-online-users-in-a-single-server).
 */
export interface ChatInterest {
    readonly userId: string;
    readonly channels: Iterable<string>;
}

/** Stop listening; `retarget` swaps the conversations a listener is indexed
 *  under, after its reader's reachable set was resolved again. */
export interface ChatSubscription {
    (): void;
    retarget(channels: Iterable<string>): void;
}

/**
 * Held on globalThis rather than in a module binding. A dev server re-evaluates
 * a module on edit, and a fresh module-scoped index would strand every
 * connection opened against the previous copy.
 */
const REGISTRY = Symbol.for("polaris.chat.live.index");

interface Entry {
    readonly listener: Listener;
    readonly userId: string | null;
    channels: Set<string>;
}

interface Registry {
    /** Listeners with no interest: every change. Tests and nothing else. */
    wide: Set<Entry>;
    byUser: Map<string, Set<Entry>>;
    byChannel: Map<string, Set<Entry>>;
    /** Every indexed listener, for the one change that is for everybody. */
    all: Set<Entry>;
    /** Where a change also goes: the other processes (`live-transport.ts`). */
    relay: ((change: ChatChange) => void) | null;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    holder[REGISTRY] ??= {
        wide: new Set(),
        byUser: new Map(),
        byChannel: new Map(),
        all: new Set(),
        relay: null
    };
    return holder[REGISTRY];
}

function addTo(index: Map<string, Set<Entry>>, key: string, entry: Entry): void {
    let set = index.get(key);
    if (!set) index.set(key, (set = new Set()));
    set.add(entry);
}

function removeFrom(index: Map<string, Set<Entry>>, key: string, entry: Entry): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) index.delete(key);
}

/**
 * The listeners a change can concern. Pure over the index: what each listener
 * then keeps or drops is still its own filter, this only spares it the
 * changes it could never keep.
 *
 * - the conversation it names, and the rooms an `appearance`, `activity` or
 *   `emoji` change carries;
 * - the account that caused it (its own other tabs) and every account in its
 *   `audience`;
 * - for a `channels` change addressed to nobody in particular - a channel
 *   created, a heading renamed - everybody. Structural and rare: no message,
 *   typing or read ever takes this path.
 */
export function listenersFor(change: ChatChange): Set<Listener> {
    const { wide, byUser, byChannel, all } = registry();
    const picked = new Set<Entry>(wide);
    if (change.kind === "channels" && !change.audience) {
        for (const entry of all) picked.add(entry);
    } else {
        const take = (set: Set<Entry> | undefined) => {
            if (set) for (const entry of set) picked.add(entry);
        };
        if (change.channelId) take(byChannel.get(change.channelId));
        for (const id of change.channels ?? []) take(byChannel.get(id));
        take(byUser.get(change.actorId));
        for (const id of change.audience ?? []) take(byUser.get(id));
    }
    return new Set([...picked].map((entry) => entry.listener));
}

/** Hand a change to the listeners in this process alone. What a notice from
 *  another process is delivered through. Never throws. */
export function deliverChatChange(change: ChatChange): void {
    for (const listener of listenersFor(change)) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Announce a change, here and in every other process. Never throws: a
 *  listener that fails is one dead browser connection, and it must not turn
 *  somebody's sent message into an error. */
export function publishChatChange(change: ChatChange): void {
    deliverChatChange(change);
    const { relay } = registry();
    if (!relay) return;
    try {
        relay(change);
    } catch (caught) {
        console.error(caught);
    }
}

/** Where published changes also go. Set once by the transport. */
export function setChatRelay(relay: ((change: ChatChange) => void) | null): void {
    registry().relay = relay;
}

/** Listen until the returned function is called. With an interest, only the
 *  changes that can concern that account and those conversations arrive. */
export function subscribeChatChanges(listener: Listener, interest?: ChatInterest): ChatSubscription {
    const state = registry();
    const entry: Entry = { listener, userId: interest?.userId ?? null, channels: new Set() };
    let open = true;
    if (!interest) {
        state.wide.add(entry);
    } else {
        state.all.add(entry);
        addTo(state.byUser, interest.userId, entry);
        for (const id of interest.channels) {
            entry.channels.add(id);
            addTo(state.byChannel, id, entry);
        }
    }
    const unsubscribe = () => {
        if (!open) return;
        open = false;
        state.wide.delete(entry);
        state.all.delete(entry);
        if (entry.userId) removeFrom(state.byUser, entry.userId, entry);
        for (const id of entry.channels) removeFrom(state.byChannel, id, entry);
        entry.channels.clear();
    };
    const retarget = (channels: Iterable<string>) => {
        if (!open || !entry.userId) return;
        const next = new Set(channels);
        for (const id of entry.channels) if (!next.has(id)) removeFrom(state.byChannel, id, entry);
        for (const id of next) if (!entry.channels.has(id)) addTo(state.byChannel, id, entry);
        entry.channels = next;
    };
    return Object.assign(unsubscribe, { retarget });
}

/** How many listeners are indexed under a conversation. For tests. */
export function chatListenersOn(channelId: string): number {
    return registry().byChannel.get(channelId)?.size ?? 0;
}
