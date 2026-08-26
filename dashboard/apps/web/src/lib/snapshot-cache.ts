/**
 * The last answer to a read, kept in sessionStorage so a revisit paints before the
 * request leaves. One module so every screen that caches a read agrees on the
 * namespace, the age check and what to do when storage is unavailable (nothing:
 * the screen still works, it just fetches).
 *
 * sessionStorage rather than localStorage: a snapshot is a shortcut for this tab's
 * session, not state worth carrying into the next one. Keys are namespaced so one
 * cannot be read as another's shape.
 *
 * And a snapshot belongs to the build that wrote it. A tab lives across an update
 * - sessionStorage survives the reload that takes it onto the new build - so
 * without this it paints yesterday's payload into today's component, and a field
 * the new one reads is simply not there. That is not a bad request or a failed
 * fetch: it is a crash on the first paint, before anything has been asked for,
 * and it looks like the screen itself is broken. So each snapshot carries its
 * build and is refused by any other, at the cost of one uncached paint after an
 * update.
 */

const PREFIX = "polaris.live.";

export interface Snapshot<T> {
    /** When it was written, for a caller that shows how old a reading is. */
    readonly at: number;
    /** The build that wrote it. Null on a deployment that carries no stamp - a
     *  source build, a dev run - where there is nothing to compare and the
     *  shape is whatever was just built. Absent on one written before snapshots
     *  carried this, which is exactly the kind that has to go. */
    readonly build?: string | null;
    readonly value: T;
}

/** What is being served to this tab, told once by the shell. Held here rather
 *  than read where it is needed: this is consulted during render, before any
 *  effect has run, because the poisoned paint is the first one. */
let servedBuild: string | null = null;
let buildKnown = false;

/**
 * Tell the store which build this document came from.
 *
 * Called during the shell's render, above the page, so it is settled before a
 * screen asks for its kept reading. Until it is called nothing is refused - a
 * surface outside the app shell keeps the behaviour it always had rather than
 * losing its cache to a question nobody answered.
 */
export function rememberSnapshotBuild(stamp: string | null): void {
    if (buildKnown) return;
    buildKnown = true;
    servedBuild = stamp;
}

/** The snapshot for `key` if it exists and is younger than `maxAgeMs`. */
export function readSnapshot<T>(key: string, maxAgeMs: number): Snapshot<T> | null {
    if (typeof sessionStorage === "undefined") return null;
    try {
        const raw = sessionStorage.getItem(`${PREFIX}${key}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Snapshot<T>;
        if (typeof parsed?.at !== "number" || Date.now() - parsed.at > maxAgeMs) return null;
        // Written by a build that is no longer the one running: its shape is not
        // this code's to read.
        if (buildKnown && servedBuild !== null && parsed.build !== servedBuild) return null;
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
        sessionStorage.setItem(
            `${PREFIX}${key}`,
            JSON.stringify({ at: Date.now(), build: servedBuild, value })
        );
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
