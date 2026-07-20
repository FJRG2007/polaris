/**
 * A small pool of open SSH clients keyed by an arbitrary key (typically a host
 * id). Reusing one authenticated connection across many operations (deploy
 * commands, log follows, a terminal) avoids a fresh TCP + auth handshake per
 * call. A dead connection (close/error) is evicted transparently, so the next
 * `acquire` reconnects; idle connections are reaped past a TTL.
 *
 * Credentials are never cached here - the caller's `connect` factory re-reads and
 * decrypts them on each real connect, so a rotated credential takes effect on the
 * next reconnect without a process restart.
 */

import type { Client } from "ssh2";

interface PoolEntry {
    client: Client;
    lastUsed: number;
    alive: boolean;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;

export class SshPool {
    private readonly entries = new Map<string, PoolEntry>();

    public constructor(private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS) {}

    /** Return a live client for `key`, connecting via `connect` if none is cached
     *  or the cached one has died. */
    public async acquire(key: string, connect: () => Promise<Client>): Promise<Client> {
        this.sweep();
        const existing = this.entries.get(key);
        if (existing?.alive) {
            existing.lastUsed = Date.now();
            return existing.client;
        }
        const client = await connect();
        const entry: PoolEntry = { client, lastUsed: Date.now(), alive: true };
        const drop = (): void => {
            entry.alive = false;
            if (this.entries.get(key) === entry) this.entries.delete(key);
        };
        client.once("close", drop);
        client.once("error", drop);
        this.entries.set(key, entry);
        return client;
    }

    /** Close and forget any connection idle longer than the TTL. */
    public sweep(now: number = Date.now()): void {
        for (const [key, entry] of this.entries) {
            if (now - entry.lastUsed <= this.idleTtlMs) continue;
            entry.alive = false;
            this.entries.delete(key);
            try {
                entry.client.end();
            } catch {
                // Already closed - nothing to do.
            }
        }
    }

    /** Close every pooled connection (process shutdown). */
    public dispose(): void {
        for (const entry of this.entries.values()) {
            try {
                entry.client.end();
            } catch {
                // Ignore - best-effort teardown.
            }
        }
        this.entries.clear();
    }
}
