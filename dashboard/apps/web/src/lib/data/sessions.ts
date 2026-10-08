/**
 * Database sessions held open between calls, for the connections people browse.
 *
 * One screen of the browser is several calls - the tree, a page of rows, the
 * live stats, a statement - and each used to open its own SSH tunnel and its
 * own database login and close both again. Through a tunnel that is a full SSH
 * handshake per click, a forked `sshd` and a database backend per call on the
 * far side, and a burst of calls from one tab could run past `sshd`'s
 * `MaxStartups` and fail at random. So, the way desktop clients keep a
 * connection (Beekeeper Studio and DBeaver hold one per open connection, pgAdmin
 * keeps a small pool per server), a session here is:
 *
 * - **one route**: the SSH client of a tunnelled connection, kept open, with each
 *   database socket a channel multiplexed over it (`forwardOut` per accepted
 *   socket, which is how `listenForward` already works);
 * - **a small pool of drivers** (`PER_SESSION`), each one database login, lent
 *   to one call at a time; a call past that waits its turn in a short queue.
 *
 * What it is keyed by is the whole safety of it. The account and the connection
 * id come first - a session is never shared between two people, whatever they
 * point at - then a digest of the resolved address, secrets, TLS, read-only flag,
 * tunnel and database included. `addressOf` still runs on every call, so the
 * ownership check, the egress rule and the host resolution are asked again each
 * time; an edited connection, a rotated password or a changed rule resolves to
 * another key and never reaches the old session.
 *
 * What is never reused: a driver that ran a typed statement (`run`), because a
 * statement box can leave anything behind on its session - an open transaction,
 * a `SET`, a `USE`, a temporary table - and the next call must not inherit it;
 * and a driver whose call failed with anything other than a refusal Polaris
 * wrote, since the failure may have been the socket. Both are closed instead of
 * pooled, which is what every call did before.
 *
 * Sessions close when idle (`IDLE_MS`), when their connection is edited, deleted
 * or re-trusted (`closeSessions`), and when the process exits. A dead SSH client
 * is noticed on the next call, which evicts that session and opens one fresh
 * route - once, not in a loop.
 */

import * as data from "./driver";
import { createHash } from "node:crypto";
import type { OpenTunnel } from "./tunnel";

/** Drivers (database logins) one session may hold at once. */
export const PER_SESSION = 3;
/** Calls that may wait for one of them before the next is refused. */
export const MAX_QUEUE = 24;
/** Sessions held across the whole process, and by one account. */
export const MAX_SESSIONS = 64;
export const MAX_PER_USER = 8;
/** How long a session with nothing in flight is kept. */
export const IDLE_MS = 90_000;
/** A pooled driver unused for this long is pinged before it is lent again. */
export const PING_AFTER_MS = 15_000;

/** Said when the caps are reached. Matched to the catalog by `words`. */
export const SESSIONS_BUSY =
    "Polaris has too many database sessions open right now. Try again in a moment.";
/** Said to a call that was waiting when its session was closed under it. */
export const SESSION_CLOSED = "That connection was closed while this was waiting. Try again.";

/** Where a session's route leads, and the tunnel holding it open. */
export interface SessionRoute {
    readonly reached: data.DataAddress;
    readonly tunnel: OpenTunnel | null;
}

/** How a session reaches its database. `open.ts` supplies the real ones. */
export interface SessionDeps {
    readonly route: (address: data.DataAddress) => Promise<SessionRoute>;
    readonly driver: (address: data.DataAddress) => Promise<data.DataDriver>;
    readonly now?: () => number;
}

interface Pooled {
    readonly driver: data.DataDriver;
    readonly usedAt: number;
}

interface Session {
    readonly key: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly ready: Promise<SessionRoute>;
    route: SessionRoute | null;
    readonly idle: Pooled[];
    /** Drivers alive, lent or idle. */
    open: number;
    leases: number;
    readonly waiters: (() => void)[];
    timer: ReturnType<typeof setTimeout> | null;
    closed: boolean;
    lastUsed: number;
}

/** The session a pooled address belongs to; null for one that is not pooled. */
function keyOf(address: data.DataAddress): string | null {
    const owner = address.session;
    if (!owner) return null;
    const { session: _owner, ...rest } = address;
    const digest = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    return `${owner.userId}\u0000${owner.connectionId}\u0000${digest}`;
}

/** A refusal Polaris wrote, which says nothing about the socket it came over. */
function spoken(error: unknown): boolean {
    return error instanceof data.DataRequestError || error instanceof data.ReadOnlyError;
}

function routeAlive(route: SessionRoute | null): boolean {
    return !route?.tunnel || route.tunnel.alive?.() !== false;
}

export class SessionCache {
    private readonly sessions = new Map<string, Session>();
    private readonly now: () => number;

    constructor(private readonly deps: SessionDeps) {
        this.now = deps.now ?? Date.now;
    }

    /** How many sessions are held, for tests and for whoever reads the logs. */
    get size(): number {
        return this.sessions.size;
    }

    /**
     * Do one thing on a pooled driver of the address's session, opening the
     * session first when there is none. Addresses with no `session` owner are
     * not for here.
     */
    async use<T>(
        address: data.DataAddress,
        work: (driver: data.DataDriver) => Promise<T>
    ): Promise<T> {
        const key = keyOf(address);
        if (!key) throw new Error("A pooled call needs an address with an owner.");

        let session = await this.sessionFor(key, address);
        if (!routeAlive(session.route)) {
            // The SSH client died since the last call: start over, once.
            this.close(session);
            session = await this.sessionFor(key, address);
        }

        const driver = await this.acquire(session);
        let discard = false;
        const lent = new Proxy(driver, {
            get(target, property) {
                // Lent, not given: closing it is the session's to decide.
                if (property === "close") return async () => undefined;
                const value = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    if (property === "run") discard = true;
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            }
        });
        try {
            return await work(lent);
        } catch (error) {
            if (!spoken(error)) discard = true;
            throw error;
        } finally {
            this.release(session, driver, discard);
            if (!routeAlive(session.route)) this.close(session);
        }
    }

    /** Close every session of one connection of one account - on an edit, a
     *  removal, or a newly trusted key or certificate. */
    closeFor(userId: string, connectionId: string): void {
        for (const session of [...this.sessions.values()]) {
            if (session.userId === userId && session.connectionId === connectionId) {
                this.close(session);
            }
        }
    }

    /** Close everything, now. */
    closeAll(): void {
        for (const session of [...this.sessions.values()]) this.close(session);
    }

    private async sessionFor(key: string, address: data.DataAddress): Promise<Session> {
        const existing = this.sessions.get(key);
        const session = existing ?? this.create(key, address);
        try {
            session.route = await session.ready;
        } catch (error) {
            // A route that did not open is not kept: the next call tries again.
            this.close(session);
            throw error;
        }
        return session;
    }

    private create(key: string, address: data.DataAddress): Session {
        const owner = address.session as { userId: string; connectionId: string };
        const mine = [...this.sessions.values()].filter((entry) => entry.userId === owner.userId);
        if (mine.length >= MAX_PER_USER) this.evictIdle(mine);
        if (this.sessions.size >= MAX_SESSIONS) this.evictIdle([...this.sessions.values()]);

        const ready = this.deps.route(address);
        // Awaited by `sessionFor`; this keeps a failure before then from being
        // reported as unhandled.
        ready.catch(() => undefined);
        const session: Session = {
            key,
            userId: owner.userId,
            connectionId: owner.connectionId,
            ready,
            route: null,
            idle: [],
            open: 0,
            leases: 0,
            waiters: [],
            timer: null,
            closed: false,
            lastUsed: this.now()
        };
        this.sessions.set(key, session);
        registerShutdown(this);
        return session;
    }

    /** Make room by closing the least recently used session with nothing in
     *  flight, or refuse when every one of them is busy. */
    private evictIdle(among: Session[]): void {
        const quiet = among
            .filter((entry) => entry.leases === 0 && entry.waiters.length === 0)
            .sort((left, right) => left.lastUsed - right.lastUsed)[0];
        if (!quiet) throw new data.DataRequestError(SESSIONS_BUSY);
        this.close(quiet);
    }

    private async acquire(session: Session): Promise<data.DataDriver> {
        for (;;) {
            if (session.closed) throw new data.DataRequestError(SESSION_CLOSED);
            if (session.timer) {
                clearTimeout(session.timer);
                session.timer = null;
            }
            const pooled = session.idle.pop();
            if (pooled) {
                session.leases += 1;
                if (this.now() - pooled.usedAt < PING_AFTER_MS) return pooled.driver;
                try {
                    // Validated on borrow after a quiet spell: a backend that
                    // timed out or a socket the network dropped is found here
                    // rather than in the middle of somebody's call.
                    await pooled.driver.version();
                    return pooled.driver;
                } catch {
                    session.leases -= 1;
                    session.open -= 1;
                    void pooled.driver.close().catch(() => undefined);
                    continue;
                }
            }
            if (session.open < PER_SESSION) {
                session.open += 1;
                session.leases += 1;
                try {
                    return await this.deps.driver((session.route as SessionRoute).reached);
                } catch (error) {
                    session.open -= 1;
                    session.leases -= 1;
                    this.wake(session);
                    this.armIdle(session);
                    throw error;
                }
            }
            if (session.waiters.length >= MAX_QUEUE) {
                throw new data.DataRequestError(SESSIONS_BUSY);
            }
            await new Promise<void>((resolve) => session.waiters.push(resolve));
        }
    }

    private release(session: Session, driver: data.DataDriver, discard: boolean): void {
        session.leases -= 1;
        session.lastUsed = this.now();
        if (discard || session.closed) {
            session.open -= 1;
            void driver.close().catch(() => undefined);
        } else {
            session.idle.push({ driver, usedAt: this.now() });
        }
        this.wake(session);
        if (session.closed) {
            if (session.leases === 0) this.closeRoute(session);
            return;
        }
        this.armIdle(session);
    }

    /** Start the idle clock on a session nothing is using or waiting for. */
    private armIdle(session: Session): void {
        if (session.closed || session.leases > 0 || session.waiters.length > 0) return;
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => this.close(session), IDLE_MS);
        // Never what keeps the process alive.
        session.timer.unref?.();
    }

    private wake(session: Session): void {
        session.waiters.shift()?.();
    }

    /** Close a session: its idle drivers now, its route once nothing is using
     *  it, and every waiting call refused. */
    private close(session: Session): void {
        if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
        if (session.closed) return;
        session.closed = true;
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
        for (const pooled of session.idle.splice(0)) {
            session.open -= 1;
            void pooled.driver.close().catch(() => undefined);
        }
        for (const waiter of session.waiters.splice(0)) waiter();
        if (session.leases === 0) this.closeRoute(session);
    }

    private closeRoute(session: Session): void {
        const route = session.route;
        session.route = null;
        if (route) {
            route.tunnel?.close();
            return;
        }
        // Still opening: close it once it has.
        session.ready.then((opened) => opened.tunnel?.close()).catch(() => undefined);
    }
}

const registered = new WeakSet<SessionCache>();

/** Close a cache's tunnels when the process ends. `exit` rather than a signal
 *  handler: a SIGTERM listener would stop the server's own shutdown. */
function registerShutdown(cache: SessionCache): void {
    if (registered.has(cache)) return;
    registered.add(cache);
    process.once("exit", () => cache.closeAll());
}
