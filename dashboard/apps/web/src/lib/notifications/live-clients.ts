/**
 * Which of an account's live connections is the one that makes a sound.
 *
 * The tabs of a browser already settle this between themselves: they share one
 * connection (see `shared-stream`) and claim the moment in `localStorage` (see
 * `device-once`), so four windows are one chime. That breaks the moment somebody
 * has the desktop app open as well. The app loads the same Polaris in a window of
 * its own, and Electron gives it a storage partition of its own - so its
 * `localStorage` is not the browser's, neither can see the other's claim, and an
 * arriving message chimed twice. Nothing on the two clients can arbitrate it,
 * because the only thing they share is this server.
 *
 * So the server elects one. Every connection says which kind of client it is when
 * it opens, and each frame carries whether the connection reading it is the
 * elected one. The desktop app wins where there is one: it is the window with an
 * icon in the dock, it is the one that draws a notice the operating system shows,
 * and somebody who installed it meant it to be where Polaris lives.
 *
 * Held in memory, like the presence registry beside it and for the same reason: it
 * is worth knowing for as long as a connection is open and never again. It follows
 * that it is only true of the process it lives in, and the way it is wrong is that
 * two processes each elect one connection - which is the behaviour this replaced,
 * a sound per client. Nothing here is allowed to make a device silent: an account
 * nothing has registered for is told to chime, because a doubled chime is an
 * annoyance and a swallowed one is a missed message.
 */

/** What kind of Polaris is holding a connection. Sent by the client, so it is
 *  treated as a claim: the worst a lying one can do is take its own account's
 *  chime, which is a thing it could already do by being the only client. */
export type LiveClientKind = "desktop" | "browser";

export const LIVE_CLIENT_KINDS: readonly LiveClientKind[] = ["desktop", "browser"];

/**
 * How long a connection is believed in without a word from it.
 *
 * Connections say goodbye - the stream drops its entry when the request aborts -
 * so this is only for the ones that cannot: a process killed, a socket that went
 * away without unwinding. Comfortably more than the feed's own poll, so a
 * connection that is merely quiet is never mistaken for a dead one, and short
 * enough that a leaked entry cannot hold the election for long. A leak is the one
 * failure that would silence a device, which is why it expires at all.
 */
const STALE_MS = 30_000;

/** The most connections tracked for one account, so a client opening them in a
 *  loop grows nothing without bound. Past it the quietest goes. */
const MAX_CLIENTS_PER_USER = 16;

export interface LiveClient {
    /** This connection, for as long as it lives. */
    readonly id: string;
    readonly kind: LiveClientKind;
    /** When it opened. The election orders by this, so it does not move while the
     *  set of connections does not. */
    readonly opened: number;
    /** When it was last heard from, for expiring the ones that never said goodbye. */
    readonly seen: number;
}

/** userId -> connection id -> what that connection is. */
const clients = new Map<string, Map<string, LiveClient>>();

/**
 * Which connection should raise the effects that belong to the device.
 *
 * Pure, and the whole rule: a desktop client first, then the one that has been
 * open longest, then the lowest id. The last two are not arbitrary - the answer
 * has to be the same for every connection asking, and it must not move while
 * nothing changes, or two clients would trade the chime between them and a burst
 * of messages would sound on both.
 */
export function chimingClient(live: readonly LiveClient[]): string | null {
    let best: LiveClient | null = null;
    for (const client of live) {
        if (!best || better(client, best)) best = client;
    }
    return best?.id ?? null;
}

function better(one: LiveClient, than: LiveClient): boolean {
    const mine = one.kind === "desktop" ? 0 : 1;
    const theirs = than.kind === "desktop" ? 0 : 1;
    if (mine !== theirs) return mine < theirs;
    if (one.opened !== than.opened) return one.opened < than.opened;
    return one.id < than.id;
}

/** Forget the connections that have gone quiet, and the account once it empties. */
function sweep(now: number): void {
    for (const [userId, held] of clients) {
        for (const [id, client] of held) {
            if (now - client.seen > STALE_MS) held.delete(id);
        }
        if (held.size === 0) clients.delete(userId);
    }
}

/** Record that a connection has opened. */
export function openLiveClient(
    userId: string,
    id: string,
    kind: LiveClientKind,
    now = Date.now()
): void {
    sweep(now);
    let held = clients.get(userId);
    if (!held) {
        held = new Map();
        clients.set(userId, held);
    }
    held.set(id, { id, kind, opened: now, seen: now });

    // Past the cap the one heard from longest ago goes, which is the likeliest to
    // be a connection nobody is behind any more.
    while (held.size > MAX_CLIENTS_PER_USER) {
        const quietest = [...held.values()].reduce((least, client) =>
            client.seen < least.seen ? client : least
        );
        held.delete(quietest.id);
    }
}

/**
 * Say a connection is still there. Called as the stream ticks, so a connection
 * that is open is never swept out from under itself.
 *
 * A connection that is open and no longer here rejoins rather than being left
 * out. There are two ways to end up in that state and neither means the
 * connection has gone: a feed that stalled for longer than `STALE_MS` was swept,
 * and one past the cap was pushed out by a newer one. An entry that could never
 * come back would spend the rest of its life losing an election it is not in -
 * which is a Polaris that never chimes again, the one failure this is not allowed
 * to have.
 */
export function touchLiveClient(
    userId: string,
    id: string,
    kind: LiveClientKind,
    now = Date.now()
): void {
    const held = clients.get(userId);
    const client = held?.get(id);
    if (!client) {
        openLiveClient(userId, id, kind, now);
        return;
    }
    held?.set(id, { ...client, seen: now });
}

/** Record that a connection has gone. */
export function closeLiveClient(userId: string, id: string): void {
    const held = clients.get(userId);
    if (!held) return;
    held.delete(id);
    if (held.size === 0) clients.delete(userId);
}

/**
 * Whether this connection is the one that should chime.
 *
 * True for a connection nothing knows about, which is what keeps a device from
 * going silent: an unregistered caller is treated as the only one there is.
 */
export function liveClientChimes(userId: string, id: string, now = Date.now()): boolean {
    sweep(now);
    const held = clients.get(userId);
    if (!held || held.size === 0) return true;
    const elected = chimingClient([...held.values()]);
    return elected === null || elected === id;
}

/** Drop everything. Exists for tests, which must not inherit each other's state. */
export function resetLiveClients(): void {
    clients.clear();
}
