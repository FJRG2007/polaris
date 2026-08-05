/**
 * A small pool of open SSH clients keyed by an arbitrary key (typically a host
 * id). Reusing one authenticated connection across many operations (deploy
 * commands, log follows, a Drive listing, a metrics probe) avoids a fresh TCP +
 * KEX + auth handshake per call, which is the dominant cost of a short operation.
 * A dead connection (close/error) is evicted transparently, so the next `acquire`
 * reconnects; idle connections are reaped past a TTL.
 *
 * Two properties make reuse safe rather than merely fast:
 *
 *   - Leases. `acquire` hands back a lease, and a connection with an outstanding
 *     lease is never reaped however long it stays idle. Without that, a download
 *     or a terminal quietly outliving the TTL would have its connection closed
 *     under it by an unrelated `acquire` elsewhere in the process.
 *   - One connect per key. Callers racing for the same key await the same connect
 *     instead of opening a connection each - the case every time a screen paints
 *     and several panels ask about the same machine at once.
 *
 * Credentials are never cached here - the caller's `connect` factory re-reads and
 * decrypts them on each real connect, so a rotated credential takes effect on the
 * next reconnect without a process restart. `evict` forces that moment for a
 * credential (or a machine) that changed right now.
 */

import type { Client } from "ssh2";

/** A borrowed connection. Release it when the work is done; releasing twice is
 *  harmless, never releasing holds the connection for the life of the process. */
export interface SshLease {
    readonly client: Client;
    release(): void;
}

interface PoolEntry {
    /** The in-flight or settled connect, awaited by every borrower of this key. */
    readonly connecting: Promise<Client>;
    /** Set once the connect resolves, so closing does not have to wait a tick. */
    client?: Client;
    lastUsed: number;
    leases: number;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export class SshPool {
    private readonly entries = new Map<string, PoolEntry>();

    public constructor(private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS) {}

    /** Borrow a live client for `key`, connecting via `connect` if none is cached
     *  or the cached one has died. */
    public async acquire(key: string, connect: () => Promise<Client>): Promise<SshLease> {
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

    /** Close and forget a connection now - a removed machine, or a credential that
     *  just changed and must not be reused for the next call. */
    public evict(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        close(entry);
    }

    /** Close and forget any unused connection idle longer than the TTL. */
    public sweep(now: number = Date.now()): void {
        for (const [key, entry] of this.entries) {
            if (entry.leases > 0 || now - entry.lastUsed <= this.idleTtlMs) continue;
            this.entries.delete(key);
            close(entry);
        }
    }

    /** Close every pooled connection (process shutdown). */
    public dispose(): void {
        for (const entry of this.entries.values()) close(entry);
        this.entries.clear();
    }

    /** How many connections are currently held. For tests and diagnostics. */
    public get size(): number {
        return this.entries.size;
    }

    private open(key: string, connect: () => Promise<Client>): PoolEntry {
        let entry: PoolEntry | undefined;
        const drop = (): void => {
            if (this.entries.get(key) === entry) this.entries.delete(key);
        };
        const connecting = connect().then((client) => {
            client.once("close", drop);
            client.once("error", drop);
            if (entry) entry.client = client;
            return client;
        });
        // A refused connect must not stay cached as a poisoned promise that every
        // later borrower awaits; the next one reconnects instead.
        connecting.catch(drop);
        entry = { connecting, lastUsed: Date.now(), leases: 0 };
        this.entries.set(key, entry);
        return entry;
    }

    private lease(entry: PoolEntry, client: Client): SshLease {
        let released = false;
        return {
            client,
            release: (): void => {
                if (released) return;
                released = true;
                this.giveBack(entry);
            }
        };
    }

    private giveBack(entry: PoolEntry): void {
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsed = Date.now();
    }
}

/** End a pooled connection, tolerating one that never connected or is already gone.
 *  A connection still handshaking is closed when it lands, not left running. */
function close(entry: PoolEntry): void {
    if (entry.client) {
        end(entry.client);
        return;
    }
    entry.connecting.then(end, () => {
        // Never connected - nothing to close.
    });
}

function end(client: Client): void {
    try {
        client.end();
    } catch {
        // Already closed - nothing to do.
    }
}
