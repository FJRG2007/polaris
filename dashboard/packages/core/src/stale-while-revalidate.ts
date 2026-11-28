/**
 * A read a screen waits on, served from the last answer while a fresh one is
 * fetched behind it.
 *
 * The rule this exists for (`docs/bugs/platform-settings-waited-on-github.md`):
 * a cache with a lifetime that BLOCKS on expiry is fast in testing and slow for
 * whoever lands on the expiry, which is every few minutes for a busy screen and
 * always the first visit after an update. So:
 *
 * - **A held answer is returned at once**, fresh or not. Past `freshMs` the read
 *   also starts one refresh in the background; the caller does not wait for it.
 * - **Concurrent callers share one refresh** per key (singleflight, as Go's
 *   `x/sync/singleflight` and graphql/dataloader do): a thousand viewers landing
 *   on an expired key cost the upstream one call.
 * - **A failed refresh keeps the held answer** and is tried again after
 *   `retryMs`, so an upstream outage or rate limit never empties a screen that
 *   already knew the answer.
 * - **Only a key with nothing held waits**, and never past `waitMs`: past it the
 *   caller gets `undefined` (its own "not known yet" state) while the refresh
 *   carries on and fills the key for the next read.
 *
 * Per process and in memory. `maxKeys` bounds it; past that the oldest settled
 * keys go first. Values are shared between callers: treat them as read-only.
 * Never use it for money, permissions or anything a stale answer would make
 * wrong - this is for lookups where the last answer is still the useful one.
 */

export interface SwrOptions<V> {
    /** How long an answer is served without starting a refresh. */
    readonly freshMs: number;
    /** How soon a failed refresh is tried again. Defaults to `freshMs`, capped at 30s. */
    readonly retryMs?: number;
    /** How long a read with nothing held waits for the first answer. Default 5s. */
    readonly waitMs?: number;
    /** At most this many keys held. Default 1000. */
    readonly maxKeys?: number;
    /** Freshness for one particular answer, overriding `freshMs` - an answer
     *  that is only partly known can ask to be refreshed sooner. */
    readonly freshFor?: (value: V) => number;
    /** The clock, for tests. */
    readonly now?: () => number;
}

/** What a read saw: the value (undefined while none was ever answered in time),
 *  when it was answered, and whether a refresh is due or running. */
export interface SwrRead<V> {
    readonly value: V | undefined;
    readonly at: number | null;
    readonly stale: boolean;
}

/** Fetch the answer for a key. `previous` is the held one, for a conditional
 *  request (`If-None-Match`) or a merge. Throwing keeps `previous`. */
export type SwrLoad<V> = (previous: V | undefined) => Promise<V>;

export interface SwrCache<V> {
    /** The held answer now (refreshing in the background when due), or the first
     *  one within `waitMs` when nothing is held. */
    read(key: string, load: SwrLoad<V>): Promise<SwrRead<V>>;
    /** `read(...).value`. */
    get(key: string, load: SwrLoad<V>): Promise<V | undefined>;
    /** What is held, without loading anything. */
    peek(key: string): SwrRead<V>;
    /** A fresh answer, waited for - what "check now" asks. Joins a refresh already
     *  running. Rejects when the load fails; the held answer stays. */
    refresh(key: string, load: SwrLoad<V>): Promise<V>;
    /** Replace the held answer, as a write that knows the new value does. */
    set(key: string, value: V): void;
    /** Drop one key, or every key. A refresh in flight still answers its callers. */
    forget(key?: string): void;
    readonly size: number;
}

interface Entry<V> {
    value: V | undefined;
    held: boolean;
    at: number | null;
    /** When a refresh is due. */
    dueAt: number;
    running: Promise<V> | null;
}

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_MAX_KEYS = 1000;
const MAX_DEFAULT_RETRY_MS = 30_000;

export function staleWhileRevalidate<V>(options: SwrOptions<V>): SwrCache<V> {
    const freshMs = Math.max(0, options.freshMs);
    const retryMs = Math.max(0, options.retryMs ?? Math.min(freshMs, MAX_DEFAULT_RETRY_MS));
    const waitMs = Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
    const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
    const now = options.now ?? (() => Date.now());
    const entries = new Map<string, Entry<V>>();

    const makeRoom = (): void => {
        for (const [key, entry] of entries) {
            if (entries.size < maxKeys) return;
            if (!entry.running) entries.delete(key);
        }
    };

    const entryFor = (key: string): Entry<V> => {
        let entry = entries.get(key);
        if (!entry) {
            if (entries.size >= maxKeys) makeRoom();
            entry = { value: undefined, held: false, at: null, dueAt: 0, running: null };
            entries.set(key, entry);
        }
        return entry;
    };

    const start = (entry: Entry<V>, load: SwrLoad<V>): Promise<V> => {
        if (entry.running) return entry.running;
        let attempt: Promise<V>;
        try {
            attempt = load(entry.held ? entry.value : undefined);
        } catch (caught) {
            attempt = Promise.reject(caught);
        }
        const running = attempt.then(
            (value) => {
                const at = now();
                entry.value = value;
                entry.held = true;
                entry.at = at;
                entry.dueAt = at + Math.max(0, options.freshFor?.(value) ?? freshMs);
                return value;
            },
            (error: unknown) => {
                entry.dueAt = now() + retryMs;
                throw error;
            }
        );
        entry.running = running;
        // Cleared on either outcome; the rejection itself is the caller's to see
        // (or nobody's, for a background refresh - hence the catch on the copy).
        running.then(
            () => (entry.running === running ? (entry.running = null) : null),
            () => (entry.running === running ? (entry.running = null) : null)
        );
        return running;
    };

    const snapshot = (entry: Entry<V> | undefined): SwrRead<V> =>
        entry && entry.held
            ? { value: entry.value, at: entry.at, stale: entry.running !== null || now() >= entry.dueAt }
            : { value: undefined, at: null, stale: true };

    const read = async (key: string, load: SwrLoad<V>): Promise<SwrRead<V>> => {
        const entry = entryFor(key);
        if (entry.held) {
            if (now() >= entry.dueAt && !entry.running) {
                start(entry, load).catch(() => undefined);
            }
            return snapshot(entry);
        }
        if (now() < entry.dueAt && !entry.running) {
            // The first load failed recently: say "not known" instead of asking
            // again on every read.
            return snapshot(entry);
        }
        const running = start(entry, load);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
            (timer as { unref?: () => void }).unref?.();
        });
        try {
            await Promise.race([running.then(() => undefined), timedOut]);
        } catch {
            // Failed: nothing held, so nothing to serve.
        } finally {
            clearTimeout(timer);
        }
        return snapshot(entry);
    };

    return {
        read,
        async get(key, load) {
            return (await read(key, load)).value;
        },
        peek(key) {
            return snapshot(entries.get(key));
        },
        refresh(key, load) {
            return start(entryFor(key), load);
        },
        set(key, value) {
            const entry = entryFor(key);
            const at = now();
            entry.value = value;
            entry.held = true;
            entry.at = at;
            entry.dueAt = at + Math.max(0, options.freshFor?.(value) ?? freshMs);
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
