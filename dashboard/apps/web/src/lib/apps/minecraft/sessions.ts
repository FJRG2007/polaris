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

/**
 * The lines a session is read from, newest format first.
 *
 * Java prints the address on the login line and the name again when the player is
 * actually in the world; Bedrock prints one line for each and no address at all,
 * which is the same reason address rules can only be enforced on Java.
 */
const EVENT_PATTERNS: readonly {
    readonly kind: PlayerSessionKind;
    readonly pattern: RegExp;
    /** Which capture holds the address, when the line carries one. */
    readonly address?: number;
}[] = [
    { kind: "join", pattern: /([A-Za-z0-9_]{1,16})\[\/((?:\d{1,3}\.){3}\d{1,3}):\d+\]\s+logged in/, address: 2 },
    { kind: "join", pattern: /([A-Za-z0-9_ ]{1,32}) joined the game/ },
    { kind: "join", pattern: /Player connected:\s*([^,]{1,32})/ },
    { kind: "leave", pattern: /([A-Za-z0-9_ ]{1,32}) left the game/ },
    { kind: "leave", pattern: /Player disconnected:\s*([^,]{1,32})/ }
];

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

/**
 * Every join and leave in this log, oldest first.
 *
 * Java prints two lines for one arrival - the login with the address, then the
 * name joining the world - and they are folded into the single event they
 * describe rather than reported as two arrivals a moment apart.
 */
export function parsePlayerSessions(log: string): PlayerSessionEvent[] {
    const events: PlayerSessionEvent[] = [];
    for (const line of log.split("\n")) {
        const at = LOG_TIMESTAMP.exec(line)?.[1] ?? null;
        for (const entry of EVENT_PATTERNS) {
            const match = entry.pattern.exec(line);
            if (!match) continue;
            const name = match[1]?.trim();
            if (!name) break;
            const address = entry.address ? (match[entry.address] ?? null) : null;
            const previous = events.at(-1);
            // The login line and the "joined the game" line are one arrival. The
            // second carries no address, so the first's is kept.
            if (
                previous &&
                previous.kind === "join" &&
                entry.kind === "join" &&
                previous.name.toLowerCase() === name.toLowerCase()
            ) {
                events[events.length - 1] = { ...previous, at: previous.at ?? at, address: previous.address ?? address };
                break;
            }
            events.push({ name, kind: entry.kind, at, address });
            break;
        }
    }
    return events;
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
    /** When they were last seen arriving or leaving, ISO 8601. Null when the log
     *  no longer reaches back to either. */
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
    const lastSeen = last?.at ?? null;
    if (online) return { presence: "playing", lastSeen };
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
