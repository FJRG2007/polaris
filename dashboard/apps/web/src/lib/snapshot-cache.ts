/**
 * The last answer to a read, kept in sessionStorage so a revisit paints before the
 * request leaves. One module so every screen that caches a read agrees on the
 * namespace, the age check and what to do when storage is unavailable (nothing:
 * the screen still works, it just fetches).
 *
 * sessionStorage rather than localStorage: a snapshot is a shortcut for this tab's
 * session, not state worth carrying into the next one. Keys are namespaced so one
 * cannot be read as another's shape.
 */

const PREFIX = "polaris.live.";

export interface Snapshot<T> {
    /** When it was written, for a caller that shows how old a reading is. */
    readonly at: number;
    readonly value: T;
}

/** The snapshot for `key` if it exists and is younger than `maxAgeMs`. */
export function readSnapshot<T>(key: string, maxAgeMs: number): Snapshot<T> | null {
    if (typeof sessionStorage === "undefined") return null;
    try {
        const raw = sessionStorage.getItem(`${PREFIX}${key}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Snapshot<T>;
        if (typeof parsed?.at !== "number" || Date.now() - parsed.at > maxAgeMs) return null;
        return parsed;
    } catch {
        // A snapshot that will not parse is not worth recovering; the fetch that
        // follows replaces it either way.
        return null;
    }
}

export function writeSnapshot<T>(key: string, value: T): void {
    if (typeof sessionStorage === "undefined") return;
    try {
        sessionStorage.setItem(`${PREFIX}${key}`, JSON.stringify({ at: Date.now(), value }));
    } catch {
        // Storage full or blocked: the screen still works, it just will not paint
        // from cache next time.
    }
}

/** Forget every snapshot whose key starts with `keyPrefix` - what a write does to
 *  the reads it invalidates. */
export function dropSnapshots(keyPrefix: string): void {
    if (typeof sessionStorage === "undefined") return;
    try {
        const full = `${PREFIX}${keyPrefix}`;
        const doomed: string[] = [];
        for (let index = 0; index < sessionStorage.length; index += 1) {
            const key = sessionStorage.key(index);
            if (key?.startsWith(full)) doomed.push(key);
        }
        for (const key of doomed) sessionStorage.removeItem(key);
    } catch {
        // Blocked storage holds no snapshots to drop.
    }
}
