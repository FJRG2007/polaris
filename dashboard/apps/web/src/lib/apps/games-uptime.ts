/**
 * When a server was last up, and since when it has been.
 *
 * The list says what a server is doing right now, which is the wrong half of the
 * question for the one that is off: "Stopped" is the same word whether it went
 * down ten minutes ago or in March, and those are not the same server. So the same
 * line players get - when they were last seen - is kept for servers too.
 *
 * Written by the sweep that already asks every server who is on it, because that
 * sweep is the only thing that watches all of them once a minute; nothing else has
 * to run, and no new read is paid for. It goes in the install's config beside the
 * rest of what a server has been observed doing, which the list already loads - so
 * showing it costs no query at all.
 *
 * Pure: what to write is decided here and written by `games-activity-service`.
 */

import { readInstallConfig, type InstallConfig } from "@/lib/apps/install-config";

/** The last minute the server was seen answering. */
export const LAST_ONLINE_KEY = "lastOnlineAt";

/** When the run it is in the middle of began, cleared when it ends. */
export const ONLINE_SINCE_KEY = "onlineSince";

/**
 * How long a server may go unseen before coming back counts as a new run rather
 * than the same one.
 *
 * Longer than the sweep's minute, because a sweep that overran, a Polaris that was
 * restarted or a server that was too busy to answer once are not a server that went
 * down - and reporting "up for 30 seconds" about a world that has been up for a
 * week is the kind of wrong that gets somebody to restart it.
 */
const GAP_MS = 4 * 60_000;

/**
 * How stale the last-seen record may get while the server is up.
 *
 * The exact moment is written when the server is watched going down; this only
 * bounds the error when nothing watched it - a Polaris that was itself off. It has
 * to stay comfortably under the gap above: a record refreshed less often than a gap
 * is long would make every healthy server look like one that had just come back.
 */
const REFRESH_MS = 2 * 60_000;

/** What is known about one server's runs. */
export interface ServerUptime {
    /** The last minute it was seen answering, or null if it never has been. */
    readonly lastOnlineAt: string | null;
    /** When the run it is still in began. Null for a server that is not up. */
    readonly onlineSince: string | null;
}

export const NO_UPTIME: ServerUptime = { lastOnlineAt: null, onlineSince: null };

/**
 * What one sweep managed to establish about a server.
 *
 * Three states rather than two, because silence is not the same evidence as a
 * container that is down. A server that took too long to answer one rcon or
 * arkmanager call has told nobody anything, and a run that has been going for a
 * week must survive it: "unknown" is the reading that writes nothing at all.
 */
export type UptimeReading = "up" | "down" | "unknown";

function readTime(value: unknown): string | null {
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** What an install's config records about its runs. */
export function readServerUptime(config: string | null | undefined): ServerUptime {
    const parsed = readInstallConfig(config);
    return {
        lastOnlineAt: readTime(parsed[LAST_ONLINE_KEY]),
        onlineSince: readTime(parsed[ONLINE_SINCE_KEY])
    };
}

/**
 * What to write down after one reading, or null when nothing has changed enough to
 * be worth a write.
 *
 * Three moments are recorded and no others: a server that has just come up, a
 * server that has just gone down, and a server that has been up long enough that
 * the record of it would otherwise go stale. Everything else is the same answer as
 * a minute ago, and writing it would be a row updated every minute for every
 * server to say that nothing happened.
 *
 * A reading that established nothing writes nothing. Treating it as "down" would
 * end the run and stamp the server as last seen up at a moment nobody saw it up -
 * and the next sweep, finding no run in progress, would start a fresh one and
 * report a world that never went down as up since just now.
 */
export function uptimePatch(
    current: ServerUptime,
    reading: UptimeReading,
    now: Date
): InstallConfig | null {
    if (reading === "unknown") return null;
    const at = now.toISOString();
    if (reading === "down") {
        // Watched going down, which is the only moment the exact time is known.
        // A server that was already down has nothing new to say.
        return current.onlineSince === null
            ? null
            : { [ONLINE_SINCE_KEY]: null, [LAST_ONLINE_KEY]: at };
    }
    const last = current.lastOnlineAt === null ? null : Date.parse(current.lastOnlineAt);
    // Back after a gap nobody watched: the run it is in started now as far as
    // anything here can tell, and claiming the older start would report an uptime
    // that covers a stretch when it was demonstrably not up.
    const resumed = last === null || now.getTime() - last > GAP_MS;
    if (resumed) return { [ONLINE_SINCE_KEY]: at, [LAST_ONLINE_KEY]: at };
    if (current.onlineSince === null) return { [ONLINE_SINCE_KEY]: at, [LAST_ONLINE_KEY]: at };
    return now.getTime() - (last ?? 0) >= REFRESH_MS ? { [LAST_ONLINE_KEY]: at } : null;
}
