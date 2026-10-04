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
type LineKind = "login" | "join" | "lost" | "leave" | "refused" | "kicked";

/** A name as Java prints it before the player is in the world: bare, or inside
 *  the authlib profile it logs for a connection that never got that far. */
const PROFILE_NAME =
    "(?:com\\.mojang\\.authlib\\.GameProfile@\\w+\\[[^\\]]*?name=([A-Za-z0-9_]{1,16})[^\\]]*\\]|([A-Za-z0-9_]{1,16}))";

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
    /** Which capture holds the server's own words about why, when it says. */
    readonly reason?: number;
    /** A second capture the name may be in: the profile form puts it in one
     *  and the bare form in the other. */
    readonly altName?: number;
}[] = [
    // A connection turned away before it reached the world, with the server's
    // reason: not on the whitelist, banned, an outdated client, a full server.
    // Older servers say "Disconnecting <who> (/address): <why>"; newer ones say
    // "<who> (/address) lost connection: <why>". Either way the address in
    // brackets is what tells it from a player who was in the game.
    {
        kind: "refused",
        pattern: new RegExp(`\\]:\\s+Disconnecting ${PROFILE_NAME}\\s*\\(\\/[^)]*\\):\\s*(.*)$`),
        altName: 2,
        reason: 3
    },
    {
        kind: "refused",
        pattern: new RegExp(`\\]:\\s+${PROFILE_NAME}\\s*\\(\\/[^)]*\\) lost connection:\\s*(.*)$`),
        altName: 2,
        reason: 3
    },
    // An operator's kick, with its message. Not an event of its own: it is why
    // the "lost connection" that follows it happened.
    { kind: "kicked", pattern: /\]:\s+Kicked ([A-Za-z0-9_]{1,16}): (.*)$/, reason: 2 },
    {
        kind: "login",
        pattern: /([A-Za-z0-9_]{1,16})\[\/((?:\d{1,3}\.){3}\d{1,3}):\d+\]\s+logged in/,
        address: 2
    },
    { kind: "join", pattern: /([A-Za-z0-9_ ]{1,32}) joined the game/ },
    { kind: "join", pattern: /Player connected:\s*([^,]{1,32})/ },
    // After the logger's own "]: ", so a connection dropped before it had a name -
    // "/203.0.113.9:5555 lost connection" - is not read as a player.
    { kind: "lost", pattern: /\]:\s+([A-Za-z0-9_]{1,16}) lost connection: (.*)$/, reason: 2 },
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

/**
 * An arrival, a departure, or an attempt the server turned away before the
 * player was in the world. "refused" is not part of any visit: whoever it names
 * never got in.
 */
export type PlayerSessionKind = "join" | "leave" | "refused";

/**
 * Why somebody went, or why the server would not let them in - the reasons a
 * Minecraft server actually prints, each with a label an operator can read.
 * `other` is anything it printed that is none of these (a plugin's own kick
 * message, say); the raw words are always kept beside it.
 */
export const DISCONNECT_REASONS = [
    "quit",
    "timeout",
    "kicked",
    "banned",
    "whitelist",
    "outdated",
    "full",
    "duplicate",
    "idle",
    "auth",
    "flying",
    "shutdown",
    "network",
    "other"
] as const;

export type DisconnectReasonKind = (typeof DISCONNECT_REASONS)[number];

export interface DisconnectReason {
    readonly kind: DisconnectReasonKind;
    /** Exactly what the server printed, for the reader who wants the detail. */
    readonly raw: string;
}

/** The server's words, most specific first. Matched without case: the same
 *  message is capitalised differently across versions. */
const REASON_WORDS: readonly [DisconnectReasonKind, RegExp][] = [
    ["whitelist", /white-?listed|not on the whitelist/i],
    ["banned", /\bbanned\b/i],
    ["outdated", /outdated (client|server)|incompatible client|multiplayer\.disconnect\.(outdated|incompatible)/i],
    ["full", /server is full|multiplayer\.disconnect\.server_full/i],
    ["duplicate", /logged in from another location|duplicate_login|duplicate login/i],
    ["idle", /idle for too long|multiplayer\.disconnect\.idling/i],
    ["auth", /failed to verify username|invalid session|unverified_username|failed to log in|authentication/i],
    ["flying", /flying is not enabled|multiplayer\.disconnect\.flying/i],
    ["kicked", /kicked by an operator|you have been kicked|multiplayer\.disconnect\.kicked/i],
    ["shutdown", /server closed|server shutting down|multiplayer\.disconnect\.server_shutdown/i],
    ["timeout", /timed out|readtimeoutexception|took too long to log in|disconnect\.timeout/i],
    ["quit", /^\s*disconnected\s*$|disconnect\.quitting|^\s*quitting\s*$/i],
    ["network", /internal exception|connection reset|end of stream|disconnect\.genericreason|broken pipe/i]
];

/**
 * What one line of the server's says about why.
 *
 * `kickedWith` is an operator's kick message printed just before: a kick's
 * "lost connection" carries the message the operator typed, which is free text
 * and could be anything, so the kick line is what says it was a kick.
 */
export function classifyDisconnect(raw: string, kickedWith: string | null = null): DisconnectReason {
    const text = stripCodes(raw).trim();
    if (kickedWith !== null) return { kind: "kicked", raw: text || stripCodes(kickedWith).trim() };
    for (const [kind, words] of REASON_WORDS) {
        if (words.test(text)) return { kind, raw: text };
    }
    return { kind: "other", raw: text };
}

/** The section-sign colour codes a reason can carry, which are formatting and
 *  not words. */
function stripCodes(text: string): string {
    return text.replace(/\u00a7[0-9a-fk-or]/gi, "");
}

/** One arrival or one departure, as the log recorded it. */
export interface PlayerSessionEvent {
    /** As the server spelled it on that line. */
    readonly name: string;
    readonly kind: PlayerSessionKind;
    /** Why they went or were turned away, when the server said. Absent on an
     *  arrival and on a departure the log gives no reason for. */
    readonly reason?: DisconnectReason;
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
    /** An operator's kick waiting for the "lost connection" it causes. */
    const kicks = new Map<string, { readonly message: string; readonly at: string | null }>();

    for (const raw of log.split("\n")) {
        // A terminal ends each line with a return as well; the reasons are read
        // to the end of the line, so it goes before anything is matched.
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
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
            const name = (match[1] ?? (entry.altName ? match[entry.altName] : undefined))?.trim();
            if (!name) break;
            const key = name.toLowerCase();
            const previous = last.get(key);
            const held = previous ? events[previous.index] : undefined;
            const address = entry.address ? (match[entry.address] ?? null) : null;
            const said = entry.reason ? (match[entry.reason] ?? "") : "";

            if (entry.kind === "kicked") {
                kicks.set(key, { message: said, at });
                break;
            }
            /** Why, from this line - a kick printed just before it wins. */
            const why = (): DisconnectReason => {
                const kick = kicks.get(key);
                kicks.delete(key);
                return classifyDisconnect(
                    said,
                    kick && sameMoment(kick.at, at) ? kick.message : null
                );
            };

            if (entry.kind === "refused" || (entry.kind === "lost" && !inGame.has(key))) {
                // The second line about one departure - the stop already ended
                // it, or "left the game" came first - is its reason.
                if (held && sameMoment(held.at, at) && (held.kind === "leave" || held.kind === "refused")) {
                    if (!held.reason && said) events[previous!.index] = { ...held, reason: why() };
                    break;
                }
                // Only the server turning somebody away is a refusal. A client
                // that went on its own before reaching the world - "Disconnected"
                // - was never refused, and nothing said is nothing to record.
                const reason = why();
                if (!said.trim() || reason.kind === "quit") break;
                last.set(key, { index: events.length, line: "refused" });
                events.push({ name, kind: "refused", at, address: null, reason });
                break;
            }

            if (entry.kind === "login" || entry.kind === "join") {
                // The join line after its own login is the same arrival. It
                // carries no address, so the login's is kept, and so is its time.
                if (
                    entry.kind === "join" &&
                    previous?.line === "login" &&
                    held &&
                    sameMoment(held.at, at)
                ) {
                    events[previous.index] = { ...held, at: held.at ?? at };
                    last.set(key, { index: previous.index, line: "join" });
                    break;
                }
                last.set(key, { index: events.length, line: entry.kind });
                inGame.set(key, name);
                events.push({ name, kind: "join", at, address });
                break;
            }

            // The second line of one departure, or the line printed for somebody
            // already counted as gone when the server stopped.
            if (previous && held?.kind === "leave" && !inGame.has(key) && sameMoment(held.at, at)) {
                last.set(key, { index: previous.index, line: entry.kind });
                break;
            }
            last.set(key, { index: events.length, line: entry.kind });
            inGame.delete(key);
            // Only the network layer's line carries the reason; "left the game"
            // never does.
            events.push(
                entry.kind === "lost" && said.trim()
                    ? { name, kind: "leave", at, address: null, reason: why() }
                    : { name, kind: "leave", at, address: null }
            );
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
        // Turned away at the door is not a visit, and ends none.
        if (event.kind === "refused") continue;
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
    // Attempts the server turned away are not visits: somebody only ever
    // refused has never played here.
    events = events.filter((event) => event.kind !== "refused");
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
        if (Number.isNaN(at) || now - at < CONNECTING_MS)
            return { presence: "connecting", lastSeen };
    }
    return { presence: "offline", lastSeen };
}

/** Each player's events, keyed by the lowercase name the rest of the panel folds
 *  its lists on. */
export function sessionsByPlayer(
    events: readonly PlayerSessionEvent[]
): Map<string, PlayerSessionEvent[]> {
    const byPlayer = new Map<string, PlayerSessionEvent[]>();
    for (const event of events) {
        const key = event.name.toLowerCase();
        const held = byPlayer.get(key);
        if (held) held.push(event);
        else byPlayer.set(key, [event]);
    }
    return byPlayer;
}
