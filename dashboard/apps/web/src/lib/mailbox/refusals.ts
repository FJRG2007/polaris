/**
 * Telling a refused credential apart from a bad day, and how long to leave a
 * refused mailbox alone.
 *
 * Pure, and kept apart from the sockets that produce the failures, because both
 * answers decide something expensive. Reading a network blip as a refusal tells
 * somebody their password changed when it did not. Reading a refusal as a blip
 * is worse: the mailbox is retried on every tick with a password the server has
 * already said no to, and a provider that sees a login fail every twenty seconds
 * locks the account - which is the one outcome here nobody can undo from Polaris.
 */

/**
 * The words servers use to refuse a credential.
 *
 * Read on top of the structured markers below rather than instead of them: an
 * older server says no in a sentence and nothing else, and the sentence is the
 * only thing that separates "your password is wrong" from "try again later".
 */
const REFUSAL_PHRASES = [
    "authenticationfailed",
    "authentication failed",
    "authentication unsuccessful",
    "invalid credentials",
    "invalid login",
    "login failed",
    "auth failed",
    "authorizationfailed",
    "invalid_grant",
    "user is authenticated but not connected",
    "application-specific password required",
    "username and password not accepted",
    "web login required",
    "log in via your web browser",
    "logindisabled",
    "login is disabled",
    "authenticate failed"
];

/**
 * The IMAP response codes (RFC 5530) that mean the credential itself was
 * refused. `UNAVAILABLE` is deliberately absent: it is a server saying it cannot
 * check right now, and a retry is the right answer to it.
 */
const REFUSAL_CODES = new Set(["AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED"]);
const TEMPORARY_CODES = new Set(["UNAVAILABLE", "INUSE", "LIMIT"]);

/** What imapflow and nodemailer put on the errors they throw. */
interface MailFailureShape {
    readonly message?: unknown;
    /** nodemailer: `EAUTH` for a refused login. */
    readonly code?: unknown;
    /** nodemailer: the SMTP reply code. */
    readonly responseCode?: unknown;
    /** imapflow: stamped on everything thrown while logging in. */
    readonly authenticationFailed?: unknown;
    /** imapflow: the bracketed code of the reply, uppercased. */
    readonly serverResponseCode?: unknown;
    /** imapflow: `NO` or `BAD` when the server answered at all. */
    readonly responseStatus?: unknown;
    readonly responseText?: unknown;
    readonly response?: unknown;
}

function mentionsRefusal(text: string): boolean {
    const lowered = text.toLowerCase();
    return REFUSAL_PHRASES.some((phrase) => lowered.includes(phrase));
}

/** Every piece of text a failure carries, joined. imapflow's own message for a
 *  refused LOGIN is "Command failed"; what the server said is beside it. */
function textOf(failure: MailFailureShape): string {
    return [failure.message, failure.responseText, failure.response]
        .filter((part): part is string => typeof part === "string")
        .join(" ");
}

/**
 * Whether a failure is the server refusing this mailbox's credential.
 *
 * Anything unrecognised is not, which is the safer of the two mistakes for the
 * person reading the screen - but the markers are read first, because the
 * sentence alone missed every IMAP refusal: imapflow reports one as "Command
 * failed", and that was being filed as an unreachable server and retried on
 * every tick.
 */
export function isCredentialRefusal(caught: unknown): boolean {
    if (typeof caught === "string") return mentionsRefusal(caught);
    if (typeof caught !== "object" || caught === null) return false;
    const failure = caught as MailFailureShape;

    const imapCode =
        typeof failure.serverResponseCode === "string" ? failure.serverResponseCode.toUpperCase() : "";
    if (TEMPORARY_CODES.has(imapCode)) return false;
    if (REFUSAL_CODES.has(imapCode)) return true;

    // SMTP: a 4xx is "not now", whatever it is about. 535 is the refusal every
    // server sends; 534 is Google's "use an app password" or "sign in on the web".
    const smtpCode = typeof failure.responseCode === "number" ? failure.responseCode : 0;
    if (smtpCode >= 400 && smtpCode < 500) return false;
    if (smtpCode === 535 || smtpCode === 534) return true;
    if (failure.code === "EAUTH") return true;

    if (failure.authenticationFailed === true) {
        // imapflow marks a socket that closed half way through LOGIN the same
        // way as a refusal, so the marker alone is not enough: the server has to
        // have answered, or said something that reads as no. An answer with a
        // code that is not a refusal's - `[ALERT] Too many simultaneous
        // connections` - is judged by what it says.
        const answered = failure.responseStatus === "NO" || failure.responseStatus === "BAD";
        return (answered && imapCode === "") || mentionsRefusal(textOf(failure));
    }
    return mentionsRefusal(textOf(failure));
}

/**
 * Where every notice about a refused mailbox sends somebody: the edit form, open
 * on that mailbox and on the field that fixes it. One address for the bell, the
 * rail and the list, so none of them can point somewhere the others do not.
 */
export function refusedMailboxHref(accountId: string): string {
    return `/mail/settings/accounts?edit=${encodeURIComponent(accountId)}`;
}

/** The shortest wait before a refused mailbox is tried again. */
export const REFUSED_RETRY_MIN_MS = 30 * 60 * 1000;
/** The longest. Once a day is quiet enough that no provider locks an account
 *  over it, and often enough that a server-side fix is noticed the same day. */
export const REFUSED_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/** What deciding whether to try a mailbox needs off its row. */
export interface MailPassState {
    readonly state: string;
    /** The last time anything talked to the server about it, refusals included. */
    readonly lastSyncAt: Date | null;
    /** The last time the server accepted it. */
    readonly lastOkAt: Date | null;
    readonly createdAt: Date;
}

/**
 * How long to leave a refused mailbox alone before trying it once more.
 *
 * Half of how long it has been refused, between half an hour and a day. That is
 * a backoff with no counter to keep: every failed try moves `lastSyncAt` on, and
 * the refusal gets older, so the tries get further apart on their own - about
 * ten in the first day and one a day from the third, where a mailbox somebody had
 * open was tried every twenty seconds before. Tried at all, rather than parked
 * for good, because a refusal can end without anybody touching Polaris - a
 * provider lifting a lock, an administrator restoring a login - and a mailbox
 * that never noticed would be the same silence this exists to end.
 */
export function refusedRetryDelayMs(account: MailPassState): number {
    const since = (account.lastOkAt ?? account.createdAt).getTime();
    const tried = (account.lastSyncAt ?? account.createdAt).getTime();
    const refusedFor = Math.max(0, tried - since);
    return Math.min(REFUSED_RETRY_MAX_MS, Math.max(REFUSED_RETRY_MIN_MS, refusedFor / 2));
}

/**
 * Whether a pass over this mailbox may open a connection now.
 *
 * Every mailbox that is not refused may: when it is due is the caller's own
 * question. A refused one waits out its backoff unless its owner asked for this
 * pass themselves - the Check now button is one deliberate try, not a loop.
 */
export function mayTryMailbox(
    account: MailPassState,
    options: { readonly force?: boolean; readonly now?: number } = {}
): boolean {
    if (account.state !== "auth" || options.force) return true;
    if (!account.lastSyncAt) return true;
    const now = options.now ?? Date.now();
    return now - account.lastSyncAt.getTime() >= refusedRetryDelayMs(account);
}
