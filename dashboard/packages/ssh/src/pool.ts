/**
 * Reuse of an expensive connection, keyed by an arbitrary key (typically a host or
 * connection id). Opening one costs a TCP connect and a multi-round-trip handshake
 * - key exchange and auth for SSH, negotiate/session-setup/tree-connect for SMB -
 * which for a short operation is most of what the operation costs. Keeping one open
 * and lending it out is the difference between browsing a machine and waiting on it.
 *
 * `LeasePool` is generic because the reuse is not specific to SSH: it is whatever a
 * caller can open, close and hand back. `SshPool` is the ssh2 flavour of it.
 *
 * Three properties make reuse safe rather than merely fast:
 *
 *   - Leases. `acquire` hands back a lease, and a connection with an outstanding
 *     lease is never reaped however long it stays idle. Without that, a download
 *     or a terminal quietly outliving the TTL would have its connection closed
 *     under it by an unrelated `acquire` elsewhere in the process.
 *   - One connect per key. Callers racing for the same key await the same connect
 *     instead of opening a connection each - the case every time a screen paints
 *     and several panels ask about the same machine at once.
 *   - Nothing cached that could go stale in a way that matters. Credentials are
 *     never held here: the caller's `connect` factory re-reads and decrypts them on
 *     each real connect, so a rotated credential takes effect on the next reconnect
 *     without a process restart. `evict` forces that moment for a credential (or a
 *     machine) that changed right now.
 */

import type { Client } from "ssh2";

/** A borrowed connection. Release it when the work is done; releasing twice is
 *  harmless, never releasing holds the connection for the life of the process. */
export interface Lease<T> {
    readonly value: T;
    release(): void;
}

/** A borrowed SSH connection. */
export interface SshLease extends Lease<Client> {
    readonly client: Client;
}

interface PoolEntry<T> {
    /** The in-flight or settled connect, awaited by every borrower of this key. */
    readonly connecting: Promise<T>;
    /** Set once the connect resolves, so closing does not have to wait a tick. */
    value?: T;
    lastUsed: number;
    leases: number;
    /** Dropped from the pool while borrowers still held it: closed as soon as the
     *  last one gives it back. */
    closeWhenIdle?: boolean;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export class LeasePool<T> {
    private readonly entries = new Map<string, PoolEntry<T>>();

    /**
     * @param close  How to hang up on a connection this pool is done with.
     * @param idleTtlMs  How long an unused connection is kept before it is closed.
     */
    public constructor(
        private readonly close: (value: T) => void,
        private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS
    ) {}

    /** Borrow a live connection for `key`, opening one via `connect` if none is
     *  cached or the cached one has died. */
    public async acquire(key: string, connect: () => Promise<T>): Promise<Lease<T>> {
        this.sweep();
        const entry = this.entries.get(key) ?? this.open(key, connect);
        entry.leases += 1;
        entry.lastUsed = Date.now();
        try {
            return this.lease(entry, await entry.connecting);
        } catch (error) {
            this.giveBack(entry);
            throw error;
        }
    }

    /** Close and forget a connection now - a removed machine, a credential that just
     *  changed, or a session that turned out to be dead. */
    public evict(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this.hangUp(entry);
    }

    /**
     * Forget a connection a borrower found dead, if it is still the one cached for
     * `key`.
     *
     * Two things separate this from `evict`. The identity check: a borrower whose
     * check failed may be holding a connection the pool has already replaced, and
     * hanging up on the replacement would take down the borrower that just opened
     * it. And the wait: a check can fail for its own reasons - a timeout, one
     * refused call - while another request is midway through a download on the same
     * connection, so it is closed only once the last lease comes back rather than
     * under whoever is still using it.
     */
    public discard(key: string, value: T): void {
        const entry = this.entries.get(key);
        if (!entry || entry.value !== value) return;
        this.entries.delete(key);
        if (entry.leases > 0) {
            entry.closeWhenIdle = true;
            return;
        }
        this.hangUp(entry);
    }

    /** Close and forget any unused connection idle longer than the TTL. */
    public sweep(now: number = Date.now()): void {
        for (const [key, entry] of this.entries) {
            if (entry.leases > 0 || now - entry.lastUsed <= this.idleTtlMs) continue;
            this.entries.delete(key);
            this.hangUp(entry);
        }
    }

    /** Close every pooled connection (process shutdown). */
    public dispose(): void {
        for (const entry of this.entries.values()) this.hangUp(entry);
        this.entries.clear();
    }

    /** How many connections are currently held. For tests and diagnostics. */
    public get size(): number {
        return this.entries.size;
    }

    private open(key: string, connect: () => Promise<T>): PoolEntry<T> {
        let entry: PoolEntry<T> | undefined;
        const drop = (): void => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
        };
        const connecting = connect().then((value) => {
            this.watch(value, drop);
            if (entry) entry.value = value;
            return value;
        });
        // A refused connect must not stay cached as a poisoned promise that every
        // later borrower awaits; the next one reconnects instead.
        connecting.catch(drop);
        entry = { connecting, lastUsed: Date.now(), leases: 0 };
        this.entries.set(key, entry);
        return entry;
    }

    /** Hook for a connection that announces its own death, so the pool can drop it
     *  before somebody borrows a corpse. The base pool has nothing to listen to. */
    protected watch(_value: T, _onDead: () => void): void {}

    private lease(entry: PoolEntry<T>, value: T): Lease<T> {
        let released = false;
        return {
            value,
            release: (): void => {
                if (released) return;
                released = true;
                this.giveBack(entry);
            }
        };
    }

    private giveBack(entry: PoolEntry<T>): void {
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsed = Date.now();
        if (entry.closeWhenIdle && entry.leases === 0) this.hangUp(entry);
    }

    /** Close a pooled connection, tolerating one that never connected or is already
     *  gone. One still handshaking is closed when it lands, not left running. */
    private hangUp(entry: PoolEntry<T>): void {
        if (entry.value !== undefined) {
            this.end(entry.value);
            return;
        }
        entry.connecting.then(
            (value) => this.end(value),
            () => {
                // Never connected - nothing to close.
            }
        );
    }

    private end(value: T): void {
        try {
            this.close(value);
        } catch {
            // Already closed - nothing to do.
        }
    }
}

/** The pool of authenticated SSH connections. A client that closes or errors is
 *  dropped on its own event, so the next borrow reconnects. */
export class SshPool extends LeasePool<Client> {
    public constructor(idleTtlMs?: number) {
        super((client) => client.end(), idleTtlMs);
    }

    public override async acquire(key: string, connect: () => Promise<Client>): Promise<SshLease> {
        const lease = await super.acquire(key, connect);
        return { client: lease.value, value: lease.value, release: lease.release };
    }

    protected override watch(client: Client, onDead: () => void): void {
        client.once("close", onDead);
        client.once("error", onDead);
    }
}
