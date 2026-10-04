/**
 * The one shape every external calendar source is driven through.
 *
 * Google, Microsoft Graph, CalDAV servers and plain ICS links differ in almost
 * everything, and the sync engine should not care: it lists calendars, pulls
 * what changed since the state it stored, and writes one object at a time with
 * the version it last saw. Each client turns its protocol into this, and every
 * object crosses the boundary as iCalendar text so the engine stores one format.
 */

/** A calendar as the remote side describes it. */
export interface RemoteCalendar {
    /** The provider's stable id: a collection URL for CalDAV, an id elsewhere. */
    remoteId: string;
    name: string;
    color: string | null;
    description: string;
    timezone: string | null;
    readOnly: boolean;
    components: ("VEVENT" | "VTODO")[];
}

/** One calendar object resource: every component sharing a UID. */
export interface RemoteObject {
    href: string;
    etag: string;
    ics: string;
}

/** What changed since the stored state. */
export interface ChangeSet {
    changed: RemoteObject[];
    /** Hrefs that are gone. */
    removed: string[];
    syncToken: string;
    ctag: string;
    /** True when `changed` is the complete set: anything not in it is gone. */
    full: boolean;
    /** The span a full set is complete for, when it covers only part of the calendar. */
    window?: { start: Date; end: Date };
}

/** The state a pull starts from, as the previous pull left it. */
export interface PullState {
    remoteId: string;
    syncToken: string;
    ctag: string;
    /** href -> etag of every object held locally. */
    known: ReadonlyMap<string, string>;
}

export interface WriteTarget {
    remoteId: string;
}

/**
 * Calendars the last `listCalendars` could not reach, while the rest of the
 * account listed fine - Google's tasks, when the account has not granted them
 * or the API is off. Calendars under `prefix` are kept as they are and not
 * pulled this time, and `cause` (a `SyncError`) says why.
 */
export interface ListingGap {
    readonly prefix: string;
    readonly cause: unknown;
}

export interface CalendarProvider {
    listCalendars(): Promise<RemoteCalendar[]>;
    /** What the last `listCalendars` left out, when anything; see `ListingGap`. */
    listingGaps?(): readonly ListingGap[];
    pull(state: PullState): Promise<ChangeSet>;
    /** Creates (`href` null) or replaces an object; a stale `etag` is a `SyncConflictError`. */
    put(
        target: WriteTarget,
        object: { href: string | null; etag: string | null; ics: string; uid: string }
    ): Promise<{ href: string; etag: string }>;
    remove(target: WriteTarget, object: { href: string; etag: string | null }): Promise<void>;
}
