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
 * Unless nobody is at it. The server cannot tell which computer a connection
 * comes from, so an app left open on a desk at home silenced the browser its
 * owner was using somewhere else - a call rang in an empty room. So a client may
 * say that nobody is at its computer (`away`), and one that is not is preferred
 * over one that is, before the desktop rule applies. The app asks the operating
 * system how long the machine has gone untouched. A browser can only see its own
 * page, so it says when somebody last touched Polaris in it (`activeAt`), and it
 * counts as away once that is `BROWSER_IDLE_MS` old.
 *
 * Away on its own was not enough. A browser used to never be away, so somebody
 * who set a timer and walked away from their computer had the app go away two
 * minutes later and the browser tab on the same desk take the ring. When every
 * client is away, the one touched most recently wins: on one computer the app
 * always is (any input in the browser is input the system saw too), and across
 * two computers it is the one somebody left last. A client that never reports -
 * an older build - counts as somebody there, which is how it behaved before.
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

/** How long a browser goes untouched before it counts as away. The same as the
 *  app's own threshold (`IDLE_AFTER_SECONDS` in the desktop app). */
export const BROWSER_IDLE_MS = 120_000;

export interface LiveClient {
    /** This connection, for as long as it lives. */
    readonly id: string;
    readonly kind: LiveClientKind;
    /**
     * Whether this client would actually make the sound if it were told to.
     *
     * Declared by the client, because the switch is not the server's to read: the
     * chime is turned off per device, in `localStorage`, and the whole premise
     * here is that the desktop app keeps its own. Without this the preference and
     * the election worked against each other - the sound turned off in the app,
     * which still won for being the app, and every browser tab told to stay quiet
     * because the app had it. The account got no chime anywhere, from a switch
     * that used to silence one window.
     */
    readonly rings: boolean;
    /**
     * Whether the client said nobody is at its computer. False until it says
     * so, because a client that never reports - a browser, an older app - must
     * keep the place it always had.
     */
    readonly away: boolean;
    /**
     * When somebody was last known to be at it, or null for never said. For the
     * app, the moment it said it went away (an upper bound, which is what keeps
     * the app ahead of a browser on the same computer); for a browser, the last
     * touch of Polaris in it.
     */
    readonly activeAt: number | null;
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
 * Pure, and the whole rule: a client somebody is at first, then a desktop
 * client, then the one that has been open longest, then the lowest id. With
 * nobody at any of them, the one touched most recently, then the same order.
 * The last two are not arbitrary - the answer
 * has to be the same for every connection asking, and it must not move while
 * nothing changes, or two clients would trade the chime between them and a burst
 * of messages would sound on both.
 */
export function chimingClient(live: readonly LiveClient[], now = Date.now()): string | null {
    // A client that has the sound switched off is not a candidate. It would win on
    // being the app and then play nothing, and everybody else would have been told
    // to stay quiet - so the one switch somebody flipped to silence one window
    // silenced the account.
    //
    // Unless they are all switched off, in which case the ordinary rule decides.
    // Nothing is gained by electing nobody: each of them suppresses the sound
    // locally anyway, and answering "nobody" here is the one shape this module
    // must never take.
    const willing = live.filter((client) => client.rings);
    const pool = willing.length > 0 ? willing : live;
    // The same shape for nobody being anywhere: then the app is as good a place
    // as any, and the ordinary rule still has to elect somebody.
    const attended = pool.filter((client) => present(client, now));
    let best: LiveClient | null = null;
    for (const client of attended.length > 0 ? attended : pool) {
        if (!best) best = client;
        else if (attended.length > 0 ? better(client, best) : leftLater(client, best))
            best = client;
    }
    return best?.id ?? null;
}

/** Whether somebody is at a client: the app until it says otherwise, a browser
 *  touched within `BROWSER_IDLE_MS`, and anything that never said. */
function present(client: LiveClient, now: number): boolean {
    if (client.away) return false;
    if (client.kind === "desktop" || client.activeAt === null) return true;
    return now - client.activeAt <= BROWSER_IDLE_MS;
}

/** Between clients nobody is at: the one left most recently, then the usual order. */
function leftLater(one: LiveClient, than: LiveClient): boolean {
    const mine = one.activeAt ?? 0;
    const theirs = than.activeAt ?? 0;
    if (mine !== theirs) return mine > theirs;
    return better(one, than);
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
    rings: boolean,
    now = Date.now()
): void {
    sweep(now);
    let held = clients.get(userId);
    if (!held) {
        held = new Map();
        clients.set(userId, held);
    }
    held.set(id, { id, kind, rings, away: false, activeAt: null, opened: now, seen: now });

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
    rings: boolean,
    now = Date.now()
): void {
    const held = clients.get(userId);
    const client = held?.get(id);
    if (!client) {
        openLiveClient(userId, id, kind, rings, now);
        return;
    }
    held?.set(id, { ...client, seen: now });
}

/**
 * Record whether anybody is at the computer a connection comes from. The next
 * tick of every connection of the account reads the new election.
 *
 * Only an open connection of this account can be marked: the id is minted by
 * the stream and looked up under the account asking, so a report can never
 * reach somebody else's. One for a connection that is gone changes nothing.
 */
export function markLiveClientAway(
    userId: string,
    id: string,
    away: boolean,
    now = Date.now()
): boolean {
    const held = clients.get(userId);
    const client = held?.get(id);
    if (!held || !client) return false;
    // Away keeps the moment it started: that is when somebody was last there,
    // and a report repeated every half minute must not move it later.
    const activeAt = away && client.away && client.activeAt !== null ? client.activeAt : now;
    held.set(id, { ...client, away, activeAt, seen: now });
    return true;
}

/**
 * Record when somebody last touched Polaris in a browser, as how long ago that
 * was - the browser's clock is not the server's, and an interval does not
 * depend on either. Only for a connection of this account, like `markLiveClientAway`.
 */
export function markLiveClientActive(
    userId: string,
    id: string,
    idleMs: number,
    now = Date.now()
): boolean {
    const held = clients.get(userId);
    const client = held?.get(id);
    if (!held || !client) return false;
    held.set(id, { ...client, activeAt: now - Math.max(0, idleMs), seen: now });
    return true;
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
    const elected = chimingClient([...held.values()], now);
    return elected === null || elected === id;
}

/**
 * Which KIND of client the account's elected connection is, or null with nobody
 * registered.
 *
 * The chime is not the only thing that belongs to one client. A message's sound,
 * a call's ring and the notice the system draws for either are settled between
 * the tabs of one browser by `device-once`, which the desktop app cannot see -
 * so each of them is told which kind of client has it, and a client of the other
 * kind leaves it alone. The kind rather than the connection, because the tabs of
 * a browser already agree which of them acts, and a frozen tab that happens to
 * hold the elected connection must not be able to silence its siblings.
 */
export function chimingKind(userId: string, now = Date.now()): LiveClientKind | null {
    sweep(now);
    const held = clients.get(userId);
    if (!held || held.size === 0) return null;
    const live = [...held.values()];
    const elected = chimingClient(live, now);
    return live.find((client) => client.id === elected)?.kind ?? null;
}

/** Drop everything. Exists for tests, which must not inherit each other's state. */
export function resetLiveClients(): void {
    clients.clear();
}
