/**
 * New mail the moment the server has it.
 *
 * Every other read here asks: a pass opens a connection, looks at every folder
 * and leaves, on the mailbox's interval or every twenty seconds while somebody
 * has Polaris open (`watch.ts`). Mail that arrived just after a pass waited for
 * the next one, plus the length of the pass itself - while the provider's own
 * app showed it at once, because it does not ask. It keeps one connection open
 * on the inbox in IDLE (RFC 2177) and the server says when something changed.
 *
 * This is that connection. One per mailbox, on its INBOX, apart from the
 * connections the passes open and close, and only while the owner has a
 * Polaris tab holding the live channel - the same people `watch.ts` counts. A
 * mailbox nobody has open gains nothing from it: arrivals are announced by an
 * open tab and nowhere else, so the interval its owner chose is still the right
 * one. It also keeps the cost bounded: one extra session per watched mailbox
 * against a provider limit of about fifteen, two for the minute an update runs
 * the old and the new dashboard side by side.
 *
 * When the server speaks - a new message, one gone, a flag changed - the inbox
 * alone is brought up to date (`syncFolderNow`), through the same code a pass
 * runs, so rules, the junk filter and the away reply behave exactly as before.
 * The twenty-second pass carries on underneath for every other folder, and for
 * a server that has no IDLE at all, which is left exactly as it was.
 */

import type { ImapFlow } from "imapflow";

/** IDLE is broken and issued again before this, under the twenty-nine minutes
 *  RFC 2177 lets a server drop a client after. */
export const IDLE_RESTART_MS = 25 * 60_000;

/** Reconnecting after a drop: from this, doubling, capped, with jitter so a
 *  server that dropped everybody is not met by everybody at once. */
export const RECONNECT_MIN_MS = 5_000;
export const RECONNECT_MAX_MS = 10 * 60_000;

/** A connection that lasted this long was healthy, and its drop starts the
 *  backoff over rather than continuing it. */
const STABLE_MS = 60_000;

/** A server without IDLE is not asked again for this long. Its capabilities do
 *  not change between ticks, and the passes are covering it the whole time. */
const NO_IDLE_RECHECK_MS = 6 * 60 * 60_000;

/** Notices are gathered this long into one catch-up: a message arriving is
 *  usually an EXISTS and a FETCH of its flags within a few milliseconds. */
const COALESCE_MS = 300;

/** What a listener needs to know about where it is. */
interface Listener {
    readonly accountId: string;
    readonly userId: string;
    stopped: boolean;
    client: ImapFlow | null;
    /** The wait before the next reconnect, so stopping can cut it short. */
    wait: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null;
    notice: ReturnType<typeof setTimeout> | null;
    attempt: number;
    done: Promise<void>;
}

interface Registry {
    listeners: Map<string, Listener>;
    /** Mailboxes whose server has no IDLE, and until when that is believed. */
    noIdle: Map<string, number>;
}

/** On `globalThis` like `watch.ts` and `live.ts`: a dev server re-evaluates the
 *  module on edit, and a fresh map would leave the old connections open with
 *  nobody able to close them. */
const REGISTRY = Symbol.for("polaris.mail.idle");

function registry(): Registry {
    const held = globalThis as { [REGISTRY]?: Registry };
    held[REGISTRY] ??= { listeners: new Map(), noIdle: new Map() };
    return held[REGISTRY];
}

/**
 * Hold a listener on each of these mailboxes of one person, and none on the
 * ones they no longer have.
 *
 * Called by `watch.ts` when somebody starts watching and on every tick after,
 * with the mailboxes they own then - so a mailbox added is listened to within
 * a tick, and one removed is let go of within one. An empty list lets go of
 * everything that person held.
 */
export function holdInboxListeners(userId: string, accountIds: readonly string[]): void {
    const { listeners, noIdle } = registry();
    const wanted = new Set(accountIds);
    for (const listener of [...listeners.values()]) {
        if (listener.userId === userId && !wanted.has(listener.accountId)) stopListener(listener);
    }
    const now = Date.now();
    for (const accountId of wanted) {
        if (listeners.has(accountId)) continue;
        const until = noIdle.get(accountId);
        if (until !== undefined && until > now) continue;
        noIdle.delete(accountId);
        startListener(accountId, userId);
    }
}

/** The mailboxes listened to right now, for tests and nothing else. */
export function listenedMailboxes(): ReadonlySet<string> {
    return new Set(registry().listeners.keys());
}

/** Let go of every listener and wait for each to close. */
export async function stopAllInboxListeners(): Promise<void> {
    const all = [...registry().listeners.values()];
    for (const listener of all) stopListener(listener);
    await Promise.allSettled(all.map((listener) => listener.done));
}

function startListener(accountId: string, userId: string): void {
    const listener: Listener = {
        accountId,
        userId,
        stopped: false,
        client: null,
        wait: null,
        notice: null,
        attempt: 0,
        done: Promise.resolve()
    };
    registry().listeners.set(accountId, listener);
    listener.done = listen(listener)
        .catch((caught: unknown) => {
            console.warn("mail inbox listener stopped", accountId, describe(caught));
        })
        .finally(() => {
            // Only its own entry: a listener stopped and started again in the
            // meantime is a different one.
            if (registry().listeners.get(accountId) === listener) {
                registry().listeners.delete(accountId);
            }
        });
}

function stopListener(listener: Listener): void {
    if (listener.stopped) return;
    listener.stopped = true;
    if (registry().listeners.get(listener.accountId) === listener) {
        registry().listeners.delete(listener.accountId);
    }
    if (listener.notice) clearTimeout(listener.notice);
    listener.notice = null;
    if (listener.wait) {
        clearTimeout(listener.wait.timer);
        listener.wait.resolve();
    }
    const client = listener.client;
    // logout breaks the IDLE with DONE and tells the server the session is
    // over, so it does not count against the account until it times out.
    if (client) void client.logout().catch(() => client.close());
}

/**
 * The listener's whole life: connect, open the inbox, wait in IDLE, and on a
 * drop wait out the backoff and do it again - until it is stopped, or there is
 * nothing to listen to.
 *
 * The modules with the database behind them are reached here rather than at
 * the top, for the reason `watch.ts` gives: `watch.ts` imports this file, and
 * the sync imports `watch.ts`.
 */
async function listen(listener: Listener): Promise<void> {
    const [{ prisma }, { ACCOUNT_COLUMNS }, { openImap }, { MailAuthError }, sync, refused] =
        await dependencies();

    while (!listener.stopped) {
        const account = await prisma.mailAccount.findUnique({
            where: { id: listener.accountId },
            select: ACCOUNT_COLUMNS
        });
        // Gone, or refused: a refused credential is the passes' to retry on
        // their backoff, never this connection's every few seconds.
        if (!account || account.state === "auth") return;
        const inbox = await prisma.mailFolder.findFirst({
            where: { accountId: account.id, role: "inbox" },
            select: { id: true, path: true }
        });
        // Not synced yet. The first pass makes the folder, and the next tick
        // of `watch.ts` starts a listener again.
        if (!inbox) return;

        const opened = Date.now();
        let client: ImapFlow;
        try {
            client = await openImap(account, { maxIdleTime: IDLE_RESTART_MS });
        } catch (caught) {
            if (caught instanceof MailAuthError) {
                await refused.recordCredentialRefusal(account.id, caught.message);
                return;
            }
            console.warn("mail inbox listener could not connect", account.id, describe(caught));
            await backOff(listener, opened);
            continue;
        }
        if (listener.stopped) {
            await client.logout().catch(() => client.close());
            return;
        }
        listener.client = client;

        if (!supportsIdle(client)) {
            // Asked every twenty seconds by the passes already; a connection
            // held open polling on top of that would only be a second poll.
            registry().noIdle.set(account.id, Date.now() + NO_IDLE_RECHECK_MS);
            listener.client = null;
            await client.logout().catch(() => client.close());
            return;
        }

        const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
        const notice = () => noticeFrom(listener, () => sync.syncFolderNow(account.id, inbox.id));
        client.on("exists", notice);
        client.on("expunge", notice);
        client.on("flags", notice);

        try {
            await client.mailboxOpen(inbox.path, { readOnly: true });
            // Whatever landed between the last pass and this connection, and
            // after a drop whatever landed while it was down.
            notice();
            await idleUntilClosed(client, closed, listener);
        } catch (caught) {
            if (!listener.stopped) {
                console.warn("mail inbox listener dropped", account.id, describe(caught));
            }
        } finally {
            listener.client = null;
            client.removeListener("exists", notice);
            client.removeListener("expunge", notice);
            client.removeListener("flags", notice);
            if (client.usable) await client.logout().catch(() => client.close());
            else client.close();
        }
        if (listener.stopped) return;
        await backOff(listener, opened);
    }
}

/** Loaded once for every listener, the first time one starts: several
 *  listeners starting together share the one load. */
function dependencies(): ReturnType<typeof loadDependencies> {
    // A load that failed is tried again by the next listener, not kept.
    loading ??= loadDependencies().catch((caught: unknown) => {
        loading = null;
        throw caught;
    });
    return loading;
}

function loadDependencies() {
    return Promise.all([
        import("@polaris/db"),
        import("./access"),
        import("./imap"),
        import("./credentials"),
        import("./sync"),
        import("./refused")
    ]);
}

let loading: ReturnType<typeof loadDependencies> | null = null;

/**
 * Stay in IDLE for as long as the connection lives.
 *
 * imapflow returns from `idle()` whenever the IDLE ends - broken for its own
 * keep-alive NOOP, or ended by the server - and restarts it itself every
 * `maxIdleTime`. So it is issued again until the connection closes. A server
 * that ends IDLE the moment it starts would turn that into a busy loop, so
 * several quick returns in a row are treated as a dropped connection.
 */
async function idleUntilClosed(
    client: ImapFlow,
    closed: Promise<void>,
    listener: Listener
): Promise<void> {
    let quick = 0;
    let isClosed = false;
    void closed.then(() => {
        isClosed = true;
    });
    while (!listener.stopped && !isClosed && client.usable) {
        const started = Date.now();
        const result = await Promise.race([client.idle(), closed.then(() => "closed" as const)]);
        if (result === "closed" || result === false) return;
        quick = Date.now() - started < 1_000 ? quick + 1 : 0;
        if (quick >= 5) return;
    }
}

/** Gather a burst of notices into one catch-up. */
function noticeFrom(listener: Listener, catchUp: () => Promise<void>): void {
    if (listener.stopped || listener.notice) return;
    listener.notice = setTimeout(() => {
        listener.notice = null;
        if (listener.stopped) return;
        void catchUp().catch(() => undefined);
    }, COALESCE_MS);
    listener.notice.unref?.();
}

/** Wait before reconnecting: capped exponential with jitter, from the start
 *  again after a connection that had been up a while. */
async function backOff(listener: Listener, opened: number): Promise<void> {
    if (Date.now() - opened >= STABLE_MS) listener.attempt = 0;
    const delay = reconnectDelayMs(listener.attempt);
    listener.attempt += 1;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            listener.wait = null;
            resolve();
        }, delay);
        timer.unref?.();
        listener.wait = { timer, resolve };
    });
}

/** The wait before reconnect number `attempt` (from zero): half to all of a
 *  doubling step, so listeners dropped together come back apart. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
    const step = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 20));
    return Math.round(step / 2 + (step / 2) * random());
}

/** IDLE is its own capability, and part of IMAP4rev2. */
function supportsIdle(client: ImapFlow): boolean {
    return client.capabilities.has("IDLE") || client.capabilities.has("IMAP4rev2");
}

/** For the log: the server's own words where there are any. */
function describe(caught: unknown): string {
    if (caught && typeof caught === "object" && "detail" in caught) {
        const detail = (caught as { detail?: unknown }).detail;
        if (typeof detail === "string" && detail) return detail;
    }
    return caught instanceof Error ? caught.message : String(caught);
}
