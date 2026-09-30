/**
 * What went wrong talking to a calendar server, in the few kinds the sync engine
 * acts on differently.
 *
 * The kind decides the reaction: an auth error marks the account as needing to
 * be connected again, a conflict keeps the local edit aside, a gone token starts
 * a full resync, an unreachable server is retried later. So every client maps
 * its protocol's failures onto exactly these, and nothing else is thrown out of
 * this module on purpose.
 *
 * Messages are short and never carry a credential, a URL with a password in it
 * or more than a sliver of a response body: they end up in logs and, through the
 * sync status, on screen.
 */

/** The longest piece of a server's own words an error keeps. */
const MAX_REASON = 200;

/** Cuts a server-supplied reason down to something safe to log and show. */
export function safeReason(text: string): string {
    const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 3)}...` : flat;
}

/** Base class, so a caller can tell a sync failure from a bug with one check. */
export abstract class SyncError extends Error {
    /** The HTTP status that caused it, or null when there was no response. */
    readonly status: number | null;

    constructor(message: string, status: number | null) {
        super(safeReason(message));
        this.name = new.target.name;
        this.status = status;
    }
}

/** The credentials were refused (401/403, an OAuth `invalid_grant`). */
export class SyncAuthError extends SyncError {}

/** The object changed on the server since it was read (412). */
export class SyncConflictError extends SyncError {
    constructor(status = 412) {
        super("The object changed on the server", status);
    }
}

/** The calendar or object no longer exists there (404). */
export class SyncNotFoundError extends SyncError {}

/** The stored sync token expired (410): the caller has to do a full resync. */
export class SyncGoneError extends SyncError {}

/**
 * The server could not be reached, timed out, failed on its side (5xx) or asked
 * to slow down. Worth retrying; `retryAfterSeconds` is the server's own hint.
 */
export class SyncUnreachableError extends SyncError {
    readonly retryAfterSeconds: number | null;

    constructor(message: string, status: number | null, retryAfterSeconds: number | null = null) {
        super(message, status);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** Any other refusal (a 4xx that is none of the above), with a short reason. */
export class SyncRefusedError extends SyncError {}
