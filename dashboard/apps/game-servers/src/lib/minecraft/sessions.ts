/**
 * When each player arrived and when they left, out of the server's own log.
 *
 * The game keeps no such record: RCON answers who is on this instant and nothing
 * about a minute ago, and the roster files say who may join, never who did. The
 * log is the only place a join and a leave are written down, so this reads them
 * back out of it.
 *
 * That makes the history exactly as long as the log Polaris asked for - a server
 * that has printed a lot since is a server whose older joins have scrolled off.
 * It is deliberately not stored: the log already holds it, and a second copy in
 * the database would be a second thing to keep true.
 *
 * Pure on purpose, like `players.ts` and `parse.ts` beside it: this runs on text
 * the panel has already polled, and none of it may drag the database or a session
 * into a client bundle.
 */

/** The RFC3339 stamp docker puts at the head of every line it hands back. */
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

/** How a line reads, before it is folded into the events around it. */
type LineKind = "login" | "join" | "lost" | "leave";

/**
 * The lines a session is read from, newest format first.
 *
 * Java prints the address on the login line and the name again when the player is
 * actually in the world; Bedrock prints one line for each and no address at all,
 * which is the same reason address rules can only be enforced on Java.
 *
 * Java also prints two lines for one departure: the network layer's "lost
 * connection" with the reason, then the chat's "left the game". The first is the
 * one no mod or setting can reword, so it is read too - a server whose join and
 * leave messages were customised still says when somebody went.
 */
const EVENT_PATTERNS: readonly {
    readonly kind: LineKind;
    readonly pattern: RegExp;
    /** Which capture holds the address, when the line carries one. */
    readonly address?: number;
}[] = [
    { kind: "login", pattern: /([A-Za-z0-9_]{1,16})\[\/((?:\d{1,3}\.){3}\d{1,3}):\d+\]\s+logged in/, address: 2 },
    { kind: "join", pattern: /([A-Za-z0-9_ ]{1,32}) joined the game/ },
    { kind: "join", pattern: /Player connected:\s*([^,]{1,32})/ },
    // After the logger's own "]: ", so a connection dropped before it had a name -
    // "/203.0.113.9:5555 lost connection" - is not read as a player.
    { kind: "lost", pattern: /\]:\s+([A-Za-z0-9_]{1,16}) lost connection: / },
    { kind: "leave", pattern: /([A-Za-z0-9_ ]{1,32}) left the game/ },
    { kind: "leave", pattern: /Player disconnected:\s*([^,]{1,32})/ }
];

/**
 * The lines that mean the server itself started or stopped.
 *
 * Everybody on it went with it, whether or not a leave was printed for them: a
 * server that crashed or was killed prints nothing on the way down, and the first
 * thing the next one prints is that it is starting.
 */
const SERVER_BOUNDARY = /Starting minecraft server version|\]:\s+Stopping server\s*$/;

/** How far apart two lines about one arrival, or one departure, can be and still
 *  be the same one. Both pairs are printed in the same tick; this is slack for a
 *  server that is struggling, not a window anything real fits inside. */
const SAME_EVENT_MS = 30_000;

export type PlayerSessionKind = "join" | "leave";

/** One arrival or one departure, as the log recorded it. */
export interface PlayerSessionEvent {
    /** As the server spelled it on that line. */
    readonly name: string;
    readonly kind: PlayerSessionKind;
    /** When it happened, ISO 8601. Null when the log carried no timestamp - some
     *  engines hand lines back without one, and an invented time is worse than
     *  none on a screen somebody reads to work out what happened. */
    readonly at: string | null;
    /** Where they connected from, on a join line that carried it. */
    readonly address: string | null;
}

/** Whether two stamps are close enough to describe one event. Two lines with no
 *  time at all are taken to be neighbours, which is what they are in the log. */
function sameMoment(left: string | null, right: string | null): boolean {
    if (!left || !right) return true;
    const gap = Math.abs(Date.parse(right) - Date.parse(left));
    return Number.isNaN(gap) || gap <= SAME_EVENT_MS;
}

/**
 * Every join and leave in this log, oldest first.
 *
 * Java prints two lines for one arrival - the login with the address, then the
 * name joining the world - and two for one departure; each pair is folded into
 * the single event it describes. Only a login followed by its own join is folded:
 * a second login is a second connection, whatever happened to the leave between
 * them, and folding it into the first is how somebody who reconnected all day was
 * shown as playing since the morning.
 *
 * A server starting or stopping ends every visit still open at that moment, since
 * nobody stays connected to a server that is not running.
 */
export function parsePlayerSessions(log: string): PlayerSessionEvent[] {
    const events: PlayerSessionEvent[] = [];
    /** Each player's last event, by lowercase name, and the line it came from. */
    const last = new Map<string, { readonly index: number; readonly line: LineKind }>();
    /** Who the log has in the world right now, by lowercase name. */
    const inGame = new Map<string, string>();

    for (const line of log.split("\n")) {
        const at = LOG_TIMESTAMP.exec(line)?.[1] ?? null;
        if (SERVER_BOUNDARY.test(line)) {
            for (const [key, name] of inGame) {
                last.set(key, { index: events.length, line: "leave" });
                events.push({ name, kind: "leave", at, address: null });
            }
            inGame.clear();
            continue;
        }
        for (const entry of EVENT_PATTERNS) {
            const match = entry.pattern.exec(line);
            if (!match) continue;
            const name = match[1]?.trim();
            if (!name) break;
            const key = name.toLowerCase();
            const previous = last.get(key);
            const held = previous ? events[previous.index] : undefined;
            const address = entry.address ? (match[entry.address] ?? null) : null;

            if (entry.kind === "login" || entry.kind === "join") {
                // The join line after its own login is the same arrival. It
                // carries no address, so the login's is kept, and so is its time.
                if (entry.kind === "join" && previous?.line === "login" && held && sameMoment(held.at, at)) {
                    events[previous.index] = { ...held, at: held.at ?? at };
                    last.set(key, { index: previous.index, line: "join" });
                    break;
                }
                last.set(key, { index: events.length, line: entry.kind });
                inGame.set(key, name);
                events.push({ name, kind: "join", at, address });
                break;
            }

            // A "lost connection" is only a departure for somebody the log has in
            // the world: the same words are printed for a connection dropped
            // before it ever got there, and that is not somebody leaving.
            if (entry.kind === "lost" && !inGame.has(key)) break;
            // The second line of one departure, or the line printed for somebody
            // already counted as gone when the server stopped.
            if (previous && held?.kind === "leave" && !inGame.has(key) && sameMoment(held.at, at)) {
                last.set(key, { index: previous.index, line: entry.kind });
                break;
            }
            last.set(key, { index: events.length, line: entry.kind });
            inGame.delete(key);
            events.push({ name, kind: "leave", at, address: null });
            break;
        }
    }
    return events;
}

/** What the log says about one player's connection as it stands. */
export interface LogConnection {
    /** Whether their last event is an arrival nothing has ended since. */
    readonly online: boolean;
    /** When the connection they are on started. Null when they are not on, or
     *  when the log carried no time for it. */
    readonly since: string | null;
    /** When they last left - for somebody who is on, the departure before the
     *  connection they are on now. */
    readonly lastLeft: string | null;
}

/**
 * One player's own events, read as a connection: whether it is open, and when it
 * began. Oldest first, as `parsePlayerSessions` returns them.
 */
export function logConnection(events: readonly PlayerSessionEvent[]): LogConnection {
    let online = false;
    let since: string | null = null;
    let lastLeft: string | null = null;
    for (const event of events) {
        if (event.kind === "join") {
            online = true;
            since = event.at;
        } else {
            online = false;
            since = null;
            lastLeft = event.at ?? lastLeft;
        }
    }
    return { online, since, lastLeft };
}

/** How long a player has been treated as still arriving after their join line,
 *  before the absence of them from the server's own answer is taken at face
 *  value. Comfortably over the panel's poll, so a player who joined between two
 *  reads is not reported as offline for a second. */
const CONNECTING_MS = 60_000;

/**
 * What to say a player is doing.
 *
 * Deliberately only what the server actually reports. Vanilla Minecraft has no
 * idea of idleness - no command answers it and nothing prints it - so there is no
 * "away" here: it would be a guess from how long somebody has been quiet, and a
 * player mining in silence would be labelled away to the operator about to kick
 * them.
 */
export type PlayerPresence = "playing" | "connecting" | "offline" | "never";

export interface PlayerActivity {
    readonly presence: PlayerPresence;
    /** For somebody playing, when the connection they are on started; for
     *  anybody else, when they were last seen arriving or leaving. ISO 8601, and
     *  null when the log no longer reaches back to it. */
    readonly lastSeen: string | null;
}

/**
 * Fold a player's own events into what to show for them.
 *
 * `online` is the server's answer and wins outright. The log only decides the
 * rest: a join with no leave after it, recent enough to still be in flight, is
 * somebody the server has not caught up with rather than somebody who is not
 * there.
 */
export function playerActivity(
    events: readonly PlayerSessionEvent[],
    online: boolean,
    now: number
): PlayerActivity {
    const last = events.at(-1) ?? null;
    if (online) {
        // Only the start of the connection they are on. A log whose last word
        // about them is a departure has lost the arrival after it - to the tail
        // it was cut at, or to a line it could not read - and the time of that
        // departure is not when they arrived; the record fills it in instead.
        const connection = logConnection(events);
        return { presence: "playing", lastSeen: connection.online ? connection.since : null };
    }
    const lastSeen = last?.at ?? null;
    if (events.length === 0) return { presence: "never", lastSeen: null };
    if (last?.kind === "join") {
        const at = last.at ? Date.parse(last.at) : Number.NaN;
        if (Number.isNaN(at) || now - at < CONNECTING_MS) return { presence: "connecting", lastSeen };
    }
    return { presence: "offline", lastSeen };
}

/** Each player's events, keyed by the lowercase name the rest of the panel folds
 *  its lists on. */
export function sessionsByPlayer(events: readonly PlayerSessionEvent[]): Map<string, PlayerSessionEvent[]> {
    const byPlayer = new Map<string, PlayerSessionEvent[]>();
    for (const event of events) {
        const key = event.name.toLowerCase();
        const held = byPlayer.get(key);
        if (held) held.push(event);
        else byPlayer.set(key, [event]);
    }
    return byPlayer;
}
