/**
 * Why a storage location would not answer, in a sentence somebody can act on.
 *
 * A driver fails with whatever the network, the kernel or the far end had to
 * say - an errno, an SMB status, a timeout - and none of that may go on the
 * screen: it names hosts, shares and paths that the person reading a shared
 * connection was never given. The old answer was to replace all of it with one
 * sentence, and on a deployment where nobody opens a terminal or reads a
 * container's log that sentence is the end of the road. "Could not list this
 * location" tells the reader what they already knew.
 *
 * So the cause is classified rather than either published or thrown away. What
 * comes out names the kind of failure and what to do about it, in words that
 * hold for every driver and disclose nothing about any of them. The exact text
 * the far end sent travels separately and only to somebody who administers that
 * connection, which is the same rule agent sessions settled on.
 */

/** What went wrong, as the screen puts it. */
export interface StorageFailure {
    /** The sentence. Always safe to show to anybody who may read the folder. */
    readonly reason: string;
    /** What to do about it, when there is something. */
    readonly hint: string | null;
    /** Whether trying again is worth a button - true for anything transient, and
     *  false for a folder that is gone or an account that is refused, where the
     *  same request would fail the same way. */
    readonly retryable: boolean;
}

/** The codes and status words a driver actually surfaces, grouped by what a
 *  person would do about them. Ordered: the first group that matches wins, so
 *  the specific ones come before "the connection broke". */
const CAUSES: readonly {
    readonly match: RegExp;
    readonly reason: string;
    readonly hint: string | null;
    readonly retryable: boolean;
}[] = [
    {
        match: /\b(ENOENT|not_found|STATUS_OBJECT_NAME_NOT_FOUND|STATUS_OBJECT_PATH_NOT_FOUND|STATUS_BAD_NETWORK_NAME|NT_STATUS_NO_SUCH_FILE|no such file or directory)\b/i,
        reason: "This folder is not there any more.",
        hint: "It was renamed, moved or removed since the last time it was opened.",
        retryable: false
    },
    {
        match: /\b(ENOTDIR|STATUS_NOT_A_DIRECTORY|not a directory)\b/i,
        reason: "This is a file, not a folder.",
        hint: null,
        retryable: false
    },
    {
        match: /\b(STATUS_LOGON_FAILURE|STATUS_PASSWORD_EXPIRED|STATUS_ACCOUNT_DISABLED|STATUS_ACCOUNT_LOCKED_OUT|authentication failed|permission denied \(publickey|All configured authentication methods failed|invalid credentials|login failed)\b/i,
        reason: "The saved sign-in for this location was refused.",
        hint: "Its password or key changed on the device. Update the connection's credentials to reach it again.",
        retryable: false
    },
    {
        match: /\b(EACCES|EPERM|permission_denied|STATUS_ACCESS_DENIED|access denied|permission denied|not permitted)\b/i,
        reason: "The account this connection uses is not allowed to read this folder.",
        hint: "Its permissions on the device changed, or the folder belongs to somebody else there.",
        retryable: false
    },
    {
        match: /\b(ESTALE|ENOTCONN|EHOSTDOWN|EIO|transport endpoint is not connected|stale file handle|STATUS_USER_SESSION_DELETED|STATUS_NETWORK_SESSION_EXPIRED|STATUS_CONNECTION_DISCONNECTED)\b/i,
        reason: "The link to this device dropped while the folder was being read.",
        hint: "It is usually back on the next try. If it keeps happening, the device went away and came back.",
        retryable: true
    },
    {
        match: /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|connection_failed|timed out|timeout)\b/i,
        reason: "This device did not answer in time.",
        hint: "It may be off, asleep, or no longer at the address this connection uses.",
        retryable: true
    },
    {
        match: /\b(ENOSPC|EDQUOT|STATUS_DISK_FULL|STATUS_QUOTA_EXCEEDED)\b/i,
        reason: "The device has no room left.",
        hint: "Free some space on it, then try again.",
        retryable: true
    },
    {
        match: /\b(EMFILE|ENFILE|EAGAIN|EBUSY|STATUS_TOO_MANY_OPENED_FILES|STATUS_INSUFF_SERVER_RESOURCES)\b/i,
        reason: "The device is too busy to answer right now.",
        hint: "Try again in a moment.",
        retryable: true
    }
];

/** Everything an error carries that might name the cause: its own message, the
 *  errno-style `code` most drivers set, and the cause it wraps - an SMB or SSH
 *  failure is routinely two or three deep by the time it arrives here. */
function saidBy(error: unknown, depth = 0): string {
    if (depth > 4 || error === null || typeof error !== "object") {
        return typeof error === "string" ? error : "";
    }
    const said = error as { message?: unknown; code?: unknown; status?: unknown; cause?: unknown };
    // The code first, because this string is also what an administrator is shown
    // and it is bounded there: a long message must not be what pushes the one
    // identifier worth quoting off the end of it.
    return [
        typeof said.code === "string" ? said.code : "",
        typeof said.status === "string" ? said.status : "",
        typeof said.message === "string" ? said.message : "",
        saidBy(said.cause, depth + 1)
    ]
        .filter(Boolean)
        .join(" ");
}

/**
 * What to put on the screen for a driver that would not answer.
 *
 * Falls back to the general sentence rather than to the driver's own words: an
 * unrecognised failure is exactly the one whose text is most likely to be a
 * path, a share name or a stack, and the reader gets the retry either way.
 */
export function storageFailure(error: unknown): StorageFailure {
    const said = saidBy(error);
    const cause = CAUSES.find((entry) => entry.match.test(said));
    if (!cause) {
        return {
            reason: "Polaris could not read this folder.",
            hint: "Trying again is worth one attempt; the device may have been busy.",
            retryable: true
        };
    }
    return { reason: cause.reason, hint: cause.hint, retryable: cause.retryable };
}

/**
 * The same failure in the far end's own words, for somebody who administers the
 * connection.
 *
 * Bounded, and never shown to a reader who was only given the folder: it can
 * name a host, a share or a path on the device, and being able to open a shared
 * folder is not being told how the device behind it is put together.
 */
export function storageFailureDetail(error: unknown): string | null {
    const said = saidBy(error).trim().replace(/\s+/g, " ");
    return said ? said.slice(0, 400) : null;
}
