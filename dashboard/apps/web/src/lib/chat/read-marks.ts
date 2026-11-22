/**
 * What this tab has read, ahead of the server saying so.
 *
 * Every unread number in Polaris is the server's, counted from the reader's
 * mark in each conversation. Left at that, a conversation somebody is plainly
 * reading stayed bold until a chain of round trips had gone all the way round:
 * the read was sent, the server announced it on the live channel, the rail and
 * the badge each waited out their settle, and each asked for its count again.
 * Every link in that chain is right; together they are the badge that "takes a
 * while to go" while the reader is looking straight at the message.
 *
 * So the client decides first, from two facts it already has:
 *
 * - **A mark.** The newest message this tab read in a conversation, by the
 *   server's own timestamp. A count whose conversation has nothing newer than
 *   the mark is a count from before the read landed, and is drawn as zero. That
 *   is also what keeps a slow answer that set off before the read from putting
 *   the badge back: it is older than the mark, and the mark only moves forward.
 * - **Somebody reading.** An open conversation registers whether it is being
 *   read right now - at the newest line, in a tab that is shown and in front. A
 *   message arriving there is read the moment it lands, so its conversation is
 *   never counted at all, whichever request answers first.
 *
 * The read itself goes to the server in the background, one request at a time
 * per conversation and only ever for the newest message asked about, and the
 * mark is taken back if the server refuses it. Other tabs and devices are told
 * by the server's `read` frame, as they always were.
 */

/** A conversation the badge counts, as the server sends it. `at` is when its
 *  newest message was written, in milliseconds, or null for an empty one. */
export interface WaitingConversation {
    readonly id: string;
    readonly unread: number;
    readonly at: number | null;
}

/** The badge's totals, with the conversations behind them when the server
 *  sends those (it may cap the list; the totals are always whole). */
export interface WaitingTotals {
    readonly messages: number;
    readonly conversations: number;
    readonly waiting?: readonly WaitingConversation[];
}

type Reading = () => boolean;

const marks = new Map<string, number>();
const readers = new Map<string, Set<Reading>>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
    version += 1;
    for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: told whenever a mark or a reader changes. */
export function subscribeReadMarks(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Moves on every change, so a memo can depend on it. */
export function readMarksVersion(): number {
    return version;
}

/** The newest moment read in a conversation on this tab, if any. */
export function readMarkOf(channelId: string): number | undefined {
    return marks.get(channelId);
}

/**
 * Read up to `at` in a conversation. Never backwards: a mark that is already
 * further along is kept, the way the server keeps its own. Returns what puts it
 * back, which does nothing once a later mark has replaced this one.
 */
export function readUpTo(channelId: string, at: number): () => void {
    const before = marks.get(channelId);
    if (!Number.isFinite(at) || (before !== undefined && before >= at)) return () => {};
    marks.set(channelId, at);
    changed();
    return () => {
        if (marks.get(channelId) !== at) return;
        if (before === undefined) marks.delete(channelId);
        else marks.set(channelId, before);
        changed();
    };
}

/**
 * Read whole conversations up to their newest message, as the list knows it -
 * "Mark as read" from a row or a heading. Returns what puts every one back, for
 * a refusal.
 */
export function readThrough(
    channels: readonly { id: string; lastMessageAt: string | null }[]
): () => void {
    const undos = channels.flatMap((channel) => {
        const at = moment(channel.lastMessageAt);
        return at === null ? [] : [readUpTo(channel.id, at)];
    });
    return () => {
        for (const undo of undos) undo();
    };
}

/** Drop a conversation's mark: somebody put it back to unread on purpose, and
 *  the server's count is the truth again. */
export function forgetReadMark(channelId: string): void {
    if (!marks.delete(channelId)) return;
    changed();
}

/**
 * An open conversation saying whether it is being read right now. Asked when a
 * count is drawn rather than pushed, because "at the newest line" changes on
 * every scroll and none of those is worth a render. Returns the unregister,
 * which redraws the counts: whatever arrived while it was open and not read is
 * counted again once nobody is reading it.
 */
export function watchReading(channelId: string, reading: Reading): () => void {
    const set = readers.get(channelId) ?? new Set<Reading>();
    set.add(reading);
    readers.set(channelId, set);
    changed();
    return () => {
        set.delete(reading);
        if (set.size === 0) readers.delete(channelId);
        changed();
    };
}

/** Whether any screen on this tab is reading the conversation now. */
export function isBeingRead(channelId: string): boolean {
    const set = readers.get(channelId);
    if (!set) return false;
    for (const reading of set) if (reading()) return true;
    return false;
}

function moment(at: string | number | null): number | null {
    if (at === null) return null;
    const parsed = typeof at === "number" ? at : Date.parse(at);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Whether this tab already knows a count for the conversation is out of date. */
function readHere(channelId: string, lastMessageAt: string | number | null): boolean {
    if (isBeingRead(channelId)) return true;
    const mark = marks.get(channelId);
    const at = moment(lastMessageAt);
    return mark !== undefined && at !== null && at <= mark;
}

/** A conversation's unread count as this tab should draw it. */
export function settledUnread(
    channelId: string,
    unread: number,
    lastMessageAt: string | number | null
): number {
    return unread > 0 && readHere(channelId, lastMessageAt) ? 0 : unread;
}

/** The badge's totals as this tab should draw them. Without the conversations
 *  behind them there is nothing to settle against, and the server's stand. */
export function settledTotals(server: WaitingTotals): { messages: number; conversations: number } {
    if (!server.waiting) return { messages: server.messages, conversations: server.conversations };
    let messages = server.messages;
    let conversations = server.conversations;
    for (const entry of server.waiting) {
        if (entry.unread <= 0 || !readHere(entry.id, entry.at)) continue;
        messages -= entry.unread;
        conversations -= 1;
    }
    return { messages: Math.max(0, messages), conversations: Math.max(0, conversations) };
}

/** Sends one read to the server. True when it was taken. */
export type ReadSender = (channelId: string, messageId: string) => Promise<boolean>;

/** The route a notice's "Mark as read" uses: a plain request, so it never waits
 *  in the queue the router keeps for actions behind a send or a page load. */
export const postRead: ReadSender = async (channelId, messageId) => {
    try {
        const response = await fetch(`/api/chat/channels/${encodeURIComponent(channelId)}/read`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId }),
            keepalive: true
        });
        return response.ok;
    } catch {
        return false;
    }
};

interface Sending {
    busy: boolean;
    /** The newest read asked for and not yet sent. */
    next: { messageId: string; at: number } | null;
    /** How far the server has taken this tab's reads, or the mark there was
     *  before any of them: what a refusal goes back to. */
    confirmed: number | undefined;
}

const sending = new Map<string, Sending>();

/**
 * Mark a conversation read up to a message: on this tab now, on the server in
 * the background. A read already on its way is let finish and followed by the
 * newest one asked for since, never by every one in between; a refusal takes
 * the mark back to the last read the server took.
 */
export function markRead(
    channelId: string,
    messageId: string,
    createdAt: string | number,
    send: ReadSender = postRead
): void {
    const at = moment(createdAt);
    if (at === null) return;
    const mark = marks.get(channelId);
    if (mark !== undefined && mark >= at) return;
    const state = sending.get(channelId) ?? { busy: false, next: null, confirmed: mark };
    sending.set(channelId, state);
    state.next = { messageId, at };
    readUpTo(channelId, at);
    if (!state.busy) void drain(channelId, state, send);
}

async function drain(channelId: string, state: Sending, send: ReadSender): Promise<void> {
    state.busy = true;
    while (state.next) {
        const { messageId, at } = state.next;
        state.next = null;
        if (await send(channelId, messageId)) {
            state.confirmed = Math.max(state.confirmed ?? at, at);
        } else if (!state.next && marks.get(channelId) === at) {
            // Nothing newer is on its way to settle it, so the server's mark is
            // the one to draw: put back to the last read it took.
            if (state.confirmed === undefined) marks.delete(channelId);
            else marks.set(channelId, state.confirmed);
            changed();
        }
    }
    state.busy = false;
    if (sending.get(channelId) === state) sending.delete(channelId);
}

/** Everything back to empty. For a session switch, and for tests. */
export function resetReadMarks(): void {
    marks.clear();
    readers.clear();
    sending.clear();
    changed();
}
