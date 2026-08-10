/**
 * Which screens each account has open right now.
 *
 * An alert about something the reader is already watching is not news. Somebody
 * sitting on a project's deploy screen watching a build fail does not need the
 * bell to light up and chime to tell them what the page in front of them just
 * said; they need it in the history, and nowhere else. So every open tab reports
 * the path it is showing while it is actually on screen, and the dispatcher asks
 * this before deciding whether an alert arrives read (see `notify`).
 *
 * Held in memory rather than in the database. A viewer is worth knowing about
 * for the few seconds either side of an event and never again, so a table of
 * them would be written constantly and read once; and the cost of losing the lot
 * - on a restart, say - is that an alert arrives unread, which is the direction
 * that is safe to be wrong in. It follows that this is only true of the process
 * it lives in, which is the one that serves the reports and raises the alerts.
 *
 * Reports are claims made by a browser, so they are treated as such: a report
 * only ever suppresses the badge on the reporter's own account, and the number
 * one account can hold is capped, so a client inventing viewer ids grows nothing.
 */

/**
 * How long a report is believed for. Comfortably longer than the heartbeat, so a
 * tab that is merely slow is not treated as gone, and short enough that a closed
 * laptop stops counting as somebody watching within a few seconds.
 */
export const PRESENCE_TTL_MS = 45000;

/** The most screens one account is tracked on. Enough for anybody working with
 *  several tabs open, and a ceiling on what a client can make this hold. */
const MAX_VIEWERS_PER_USER = 24;

interface Viewer {
    path: string;
    at: number;
}

/** userId -> viewerId -> what that tab is showing. */
const viewers = new Map<string, Map<string, Viewer>>();

/**
 * The comparable part of an in-app link: its path, without the query or the
 * fragment and without a trailing slash. Null for anything that is not an
 * in-app path, which is how an external link never matches a screen.
 */
export function viewPath(value: string | null | undefined): string | null {
    if (!value || !value.startsWith("/")) return null;
    const end = value.search(/[?#]/);
    const path = (end === -1 ? value : value.slice(0, end)).replace(/\/+$/, "");
    return path === "" ? "/" : path;
}

/** Forget everything that has gone quiet, and the account entry once it empties. */
function sweep(now: number): void {
    for (const [userId, held] of viewers) {
        for (const [viewerId, viewer] of held) {
            if (now - viewer.at > PRESENCE_TTL_MS) held.delete(viewerId);
        }
        if (held.size === 0) viewers.delete(userId);
    }
}

/**
 * Record that one tab is showing one path. Called on every navigation and on a
 * heartbeat while the tab is on screen; a path that is not an in-app one is
 * treated as the tab reporting nothing.
 */
export function recordPresence(userId: string, viewerId: string, path: string, now = Date.now()): void {
    sweep(now);
    const normalized = viewPath(path);
    if (!normalized) return dropPresence(userId, viewerId);

    let held = viewers.get(userId);
    if (!held) {
        held = new Map();
        viewers.set(userId, held);
    }
    held.set(viewerId, { path: normalized, at: now });

    // Past the cap the oldest report goes, which is the one least likely to be a
    // tab somebody is looking at.
    while (held.size > MAX_VIEWERS_PER_USER) {
        const oldest = [...held.entries()].reduce((least, entry) => (entry[1].at < least[1].at ? entry : least));
        held.delete(oldest[0]);
    }
}

/** Record that a tab has stopped showing anything - hidden, navigated away, closed. */
export function dropPresence(userId: string, viewerId: string): void {
    const held = viewers.get(userId);
    if (!held) return;
    held.delete(viewerId);
    if (held.size === 0) viewers.delete(userId);
}

/**
 * Whether this account has the page an alert points at open and on screen.
 *
 * The match is on the path alone, so the query decides nothing: a deploy alert
 * links at one service of a project, and somebody with that project's deploy
 * screen open is watching it whichever service tab they left selected. It is
 * also exact rather than a prefix, because being somewhere above a page is not
 * seeing it - a list of tasks does not show what happened to one of them.
 */
export function isViewing(userId: string, href: string | null | undefined, now = Date.now()): boolean {
    const target = viewPath(href);
    if (!target) return false;
    const held = viewers.get(userId);
    if (!held) return false;
    for (const viewer of held.values()) {
        if (viewer.path === target && now - viewer.at <= PRESENCE_TTL_MS) return true;
    }
    return false;
}

/** Drop every report. Exists for tests, which must not inherit each other's state. */
export function resetPresence(): void {
    viewers.clear();
}
