/**
 * Identical reads in flight share one answer.
 *
 * When a thousand requests ask for the same key at the same moment, the first
 * one runs the work and the other 999 wait on its promise, so the database sees
 * one query. With `ttlMs` the settled answer is also reused for that long, so a
 * burst that arrives just after it still costs nothing.
 *
 * The shape follows Go's `golang.org/x/sync/singleflight` (`Do` and `Forget`)
 * and the per-key promise cache of graphql/dataloader: a failure is never kept,
 * so the next ask tries again, and `forget` after a write means no ask that
 * starts after the write joins a read that started before it.
 *
 * Per process: there is no shared cache between Polaris processes, and none is
 * needed for this - each one asks the database at most once per key at a time.
 *
 * The shared value is the same object for every caller: treat it as read-only.
 * For work that should stop once every caller has given up, see
 * `createSharedFlight` in `concurrency-gate.ts`.
 */

export interface CoalesceOptions {
    /** How long a settled answer is reused. 0, the default: only while in flight. */
    readonly ttlMs?: number;
    /** At most this many keys held at once. Past it, settled ones go oldest first,
     *  and with every place taken by a read still in flight the work runs unshared. */
    readonly maxKeys?: number;
}

export interface Coalescer<V> {
    /** The answer for `key`: the one in flight or still fresh, else `work`'s. */
    run(key: string, work: () => Promise<V>): Promise<V>;
    /** Drop `key` (every key, with none), so the next ask runs the work again.
     *  A read already in flight still answers its callers but is not kept. */
    forget(key?: string): void;
    /** How many keys are held, in flight or settled. */
    readonly size: number;
}

interface Entry<V> {
    readonly answer: Promise<V>;
    /** When it settled, or null while it is in flight. */
    settledAt: number | null;
}

const DEFAULT_MAX_KEYS = 10_000;

export function coalescer<V>(options: CoalesceOptions = {}): Coalescer<V> {
    const ttlMs = Math.max(0, options.ttlMs ?? 0);
    const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
    const entries = new Map<string, Entry<V>>();

    const fresh = (entry: Entry<V>, now: number): boolean =>
        entry.settledAt === null || now - entry.settledAt < ttlMs;

    // Settled answers go first, expired or not, oldest first: a read in flight
    // has callers waiting on it and is never the one dropped.
    const makeRoom = (): void => {
        for (const [key, entry] of entries) {
            if (entries.size < maxKeys) return;
            if (entry.settledAt !== null) entries.delete(key);
        }
    };

    return {
        run(key, work) {
            const now = Date.now();
            const held = entries.get(key);
            if (held && fresh(held, now)) return held.answer;
            if (held) entries.delete(key);
            if (entries.size >= maxKeys) makeRoom();
            let answer: Promise<V>;
            try {
                answer = work();
            } catch (caught) {
                answer = Promise.reject(caught);
            }
            if (entries.size >= maxKeys) return answer;
            const entry: Entry<V> = { answer, settledAt: null };
            entries.set(key, entry);
            answer.then(
                () => {
                    if (entries.get(key) !== entry) return;
                    if (ttlMs > 0) entry.settledAt = Date.now();
                    else entries.delete(key);
                },
                () => {
                    if (entries.get(key) === entry) entries.delete(key);
                }
            );
            return answer;
        },
        forget(key) {
            if (key === undefined) entries.clear();
            else entries.delete(key);
        },
        get size() {
            return entries.size;
        }
    };
}
