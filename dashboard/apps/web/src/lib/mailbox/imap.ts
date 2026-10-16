/**
 * The one place a socket is opened to somebody's mail server.
 *
 * Every read and every write in this app goes through `withImap`, which opens a
 * connection, hands it to the caller, and closes it whatever happens. There is
 * no pool: a unit of work here is "sync this account" or "open this message",
 * both of which do all their folders inside one call, so pooling would save a
 * handshake per user action and cost a file descriptor held open against a
 * server nobody is talking to. If that ever stops being true this is the single
 * function that grows one, and nothing above it changes.
 *
 * The other thing this file owns is turning a failure into one of two answers,
 * because the rest of the app only ever needs to tell them apart. A credential
 * the server refused is the person's to fix and is said plainly. Everything else
 * - DNS, a closed port, a certificate, a timeout, a server having a bad day - is
 * a retry, and its message is kept off the screen: those name hosts and internal
 * paths, and the reader can do nothing with either.
 */

import { ImapFlow } from "imapflow";
import { isCredentialRefusal } from "./refusals";
import { mailCredential, MailAuthError, type MailCredentialSource } from "./credentials";

/** Raised when the server could not be reached or would not finish a command.
 *  Distinct from `MailAuthError`, which is the person's to resolve. */
export class MailUnreachableError extends Error {
    /** The server's own words, for the log. Never shown. */
    public readonly detail: string;

    public constructor(detail: string) {
        super("Polaris could not reach this mail server.");
        this.name = "MailUnreachableError";
        this.detail = detail;
    }
}

/** What an account has to carry to be connected to. */
export interface MailConnectionSource extends MailCredentialSource {
    readonly imapHost: string;
    readonly imapPort: number;
    readonly imapSecurity: string;
}

/**
 * How long any one connection may take.
 *
 * Connecting and the greeting are tight: a server that has not said hello in
 * twenty seconds is not going to.
 */
const CONNECT_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 20_000;

/**
 * How long a connection may sit with a command unanswered, during work.
 *
 * imapflow's own five minutes rather than one. Gmail answers the odd FETCH or
 * STATUS a minute and more late on an ordinary day, and at sixty seconds every
 * one of those threw the whole pass away and put "cannot reach this mail server"
 * on the screen over a server that was answering. The scheduled sweep runs a
 * few mailboxes side by side, so a server that really has stopped holds up only
 * its own mailbox and not everybody else's mail behind it.
 */
const SOCKET_TIMEOUT_MS = 5 * 60_000;

/** The account form's check waits on a person, so it keeps the short one. */
const CHECK_SOCKET_TIMEOUT_MS = 60_000;

/**
 * imapflow's warnings, and only those, into the server log.
 *
 * A refused MOVE or STORE comes back from imapflow as `false` with the server's
 * reason written to its logger and nowhere else, so with the logger off a
 * mailbox that would not move a message left no trace of why. The reason and the
 * command are kept; the rest of the entry (connection ids, raw objects) is not.
 */
const IMAP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: (entry: unknown) => console.warn("imap:", describeImapEntry(entry)),
    error: (entry: unknown) => console.warn("imap:", describeImapEntry(entry))
};

export function describeImapEntry(entry: unknown): string {
    if (!entry || typeof entry !== "object") return String(entry);
    const { msg, err } = entry as { msg?: unknown; err?: unknown };
    const failure = (err ?? {}) as { message?: unknown; responseText?: unknown; command?: unknown };
    return [msg, failure.command, failure.message, failure.responseText]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" - ");
}

/**
 * The listener every client gets before it connects.
 *
 * imapflow reports a failure that lands after `connect()` has settled - a socket
 * timeout during the session's own setup, a dropped connection between commands -
 * as an `error` event, and an `error` event nobody listens to is thrown. Thrown
 * inside imapflow's own promise chain, that became an unhandled rejection in the
 * server log. Whatever command was waiting on the connection still fails on its
 * own and is answered there; this only keeps the event from being thrown.
 */
function reportImapError(caught: unknown): void {
    console.warn("imap:", describeImapEntry({ err: caught }));
}

/** What Polaris tells the server it is. Servers log this, and a client that
 *  refuses to name itself is the one that gets rate limited first. */
const CLIENT_INFO = { name: "Polaris", vendor: "Polaris" };

/**
 * Turn whatever came off the socket into one of the two answers above.
 *
 * Which one is `isCredentialRefusal`'s decision, shared with SMTP: anything it
 * does not recognise is treated as reachable-but-failed, which retries instead
 * of telling somebody their password is wrong when it is not.
 */
export function asMailFailure(caught: unknown): MailAuthError | MailUnreachableError {
    if (caught instanceof MailAuthError || caught instanceof MailUnreachableError) return caught;
    if (isCredentialRefusal(caught)) {
        return new MailAuthError("The mail server refused this account's credentials.");
    }
    return new MailUnreachableError(caught instanceof Error ? caught.message : String(caught));
}

/**
 * Open a connection, run one unit of work on it, and close it.
 *
 * `logout()` rather than `close()` on the way out where the connection is still
 * healthy: a server that is told the client is leaving frees the session at
 * once, and one that is not holds it until it times out - which on a mailbox
 * being synced every five minutes is how an account reaches its concurrent
 * connection limit and starts being refused.
 */
export async function withImap<T>(
    account: MailConnectionSource,
    work: (client: ImapFlow) => Promise<T>
): Promise<T> {
    const client = await openImap(account);

    try {
        return await work(client);
    } catch (caught) {
        throw asMailFailure(caught);
    } finally {
        // Neither of these may throw over the caller's own result: a failed
        // logout on a connection that is being discarded is not news.
        await client.logout().catch(() => client.close());
    }
}

/**
 * Open a connection and hand it over connected, for a caller that keeps it.
 *
 * `withImap` is the way in for a unit of work; this is for the one connection
 * that is held open on purpose - the inbox listener in `idle.ts` - and which
 * therefore closes it itself. `maxIdleTime` is only meaningful there.
 */
export async function openImap(
    account: MailConnectionSource,
    tuning: { readonly maxIdleTime?: number } = {}
): Promise<ImapFlow> {
    const credential = await mailCredential(account);
    const client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        // imapflow reads `secure` as implicit TLS; false means it will upgrade
        // with STARTTLS where the server offers it, which is what `starttls` is.
        secure: account.imapSecurity === "tls",
        auth:
            credential.kind === "password"
                ? { user: credential.user, pass: credential.pass }
                : { user: credential.user, accessToken: credential.accessToken },
        clientInfo: CLIENT_INFO,
        // Nothing in this app waits on a connection between commands, so an
        // automatic IDLE would only be something the next command has to break.
        // The inbox listener issues its IDLE itself.
        disableAutoIdle: true,
        ...(tuning.maxIdleTime ? { maxIdleTime: tuning.maxIdleTime } : {}),
        logger: IMAP_LOGGER,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
        // A bridge on the same machine speaks TLS with a certificate it signed
        // itself, which is the whole design of a bridge. Nowhere else: this is
        // never widened to a host that is not a loopback address.
        ...(isLoopback(account.imapHost) ? { tls: { rejectUnauthorized: false } } : {})
    });
    client.on("error", reportImapError);

    try {
        await client.connect();
    } catch (caught) {
        client.close();
        throw asMailFailure(caught);
    }
    return client;
}

/** Whether a host is this machine. The only place a self-signed certificate is
 *  accepted, because a mail bridge issues one by design. */
export function isLoopback(host: string): boolean {
    const name = host.trim().toLowerCase();
    return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
}

/**
 * Whether the server would accept this account at all.
 *
 * Used by the account form before anything is stored, so somebody who mistyped a
 * password is told on the form rather than by a mailbox that silently never
 * syncs. `verifyOnly` makes imapflow log out the moment authentication
 * succeeds, so this costs one handshake and reads nobody's mail.
 */
export async function checkImap(account: MailConnectionSource): Promise<void> {
    const credential = await mailCredential(account);
    const client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecurity === "tls",
        auth:
            credential.kind === "password"
                ? { user: credential.user, pass: credential.pass }
                : { user: credential.user, accessToken: credential.accessToken },
        clientInfo: CLIENT_INFO,
        disableAutoIdle: true,
        logger: false,
        verifyOnly: true,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: CHECK_SOCKET_TIMEOUT_MS,
        ...(isLoopback(account.imapHost) ? { tls: { rejectUnauthorized: false } } : {})
    });
    client.on("error", reportImapError);
    try {
        await client.connect();
    } catch (caught) {
        throw asMailFailure(caught);
    } finally {
        client.close();
    }
}
