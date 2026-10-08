/**
 * A database turning a connection away, in a sentence the reader can act on.
 *
 * Every driver error used to become "That did not work", because a driver's own
 * message describes the database out loud - its users, its rules, its paths. But
 * the commonest failures are the reader's to fix and say nothing private: the
 * password is wrong, the database name is wrong, nothing listens on that port.
 * Those are recognised here by their error code, never by their text, and said
 * without repeating anything the error carried. Anything else stays generic.
 */

/** The sentences, matched back to the catalog by `lib/data/words`. */
export const DRIVER_REFUSALS = {
    credentials:
        "The database turned the sign-in down: the user or the password is wrong. Check both - a password copied from a connection URL has to be decoded first (%40 is @).",
    notAllowed:
        "The database does not let this user in from here: the user does not exist, or its access rules do not include this address.",
    noDatabase: "The database server answered, but there is no database by that name on it.",
    noAccess: "This user does not have permission for that in this database.",
    tooMany: "The database has no free connections right now. Try again in a moment.",
    starting: "The database is starting up or shutting down. Try again in a moment.",
    refused:
        "Nothing answers at that address and port. Check that the database is running and that the port is the right one.",
    timeout:
        "The database did not answer in time. Check the address, and that a firewall lets Polaris through.",
    unknownHost: "That host name does not resolve to an address. Check how it is spelled.",
    closed: "The database closed the connection before answering. If it expects encryption, turn SSL on.",
    noTls: "This database does not accept encrypted connections. Turn SSL off for it, or turn it on in the database."
} as const;

type Refusal = (typeof DRIVER_REFUSALS)[keyof typeof DRIVER_REFUSALS];

/** Postgres SQLSTATEs (pg), MySQL errnos (mysql2), Mongo codes, Node's own. */
const BY_CODE: Readonly<Record<string, Refusal>> = {
    "28P01": DRIVER_REFUSALS.credentials,
    "28000": DRIVER_REFUSALS.notAllowed,
    "3D000": DRIVER_REFUSALS.noDatabase,
    "42501": DRIVER_REFUSALS.noAccess,
    "53300": DRIVER_REFUSALS.tooMany,
    "57P03": DRIVER_REFUSALS.starting,
    ER_ACCESS_DENIED_ERROR: DRIVER_REFUSALS.credentials,
    ER_DBACCESS_DENIED_ERROR: DRIVER_REFUSALS.noAccess,
    ER_BAD_DB_ERROR: DRIVER_REFUSALS.noDatabase,
    ER_CON_COUNT_ERROR: DRIVER_REFUSALS.tooMany,
    ER_HOST_NOT_PRIVILEGED: DRIVER_REFUSALS.notAllowed,
    ECONNREFUSED: DRIVER_REFUSALS.refused,
    ETIMEDOUT: DRIVER_REFUSALS.timeout,
    ENOTFOUND: DRIVER_REFUSALS.unknownHost,
    EAI_AGAIN: DRIVER_REFUSALS.unknownHost,
    ECONNRESET: DRIVER_REFUSALS.closed
};

/** MongoDB's server error codes and names for a refused sign-in. */
const MONGO_AUTH = new Set<unknown>([18, "AuthenticationFailed"]);

/** What a refused connection means, or null when it is not one of those. */
export function driverRefusal(caught: unknown, depth = 0): Refusal | null {
    if (depth > 5 || !caught || typeof caught !== "object") return null;
    const error = caught as {
        code?: unknown;
        codeName?: unknown;
        message?: unknown;
        cause?: unknown;
    };
    if (MONGO_AUTH.has(error.code) || MONGO_AUTH.has(error.codeName))
        return DRIVER_REFUSALS.credentials;
    if (typeof error.code === "string" && BY_CODE[error.code]) return BY_CODE[error.code]!;
    const message = typeof error.message === "string" ? error.message : "";
    // Redis answers a refused sign-in in its reply text, which is the protocol's
    // own fixed word rather than anything about the server.
    if (/^(WRONGPASS|NOAUTH)\b/.test(message)) return DRIVER_REFUSALS.credentials;
    // pg's own sentence when the server answers the SSL request with "no".
    if (message === "The server does not support SSL connections") return DRIVER_REFUSALS.noTls;
    // A driver that wraps the socket's error keeps it as the cause.
    return error.cause && error.cause !== caught ? driverRefusal(error.cause, depth + 1) : null;
}
