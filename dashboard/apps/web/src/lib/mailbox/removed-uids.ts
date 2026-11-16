/**
 * Uids Polaris itself took out of a folder, so no sync pass puts them back.
 *
 * A sync pass holds a folder open on its own connection for as long as it takes
 * to fetch, store, warm bodies and refill the window - minutes on a big inbox.
 * A delete pressed meanwhile runs on another connection: the server moves the
 * message and the row goes. But the pass's session has not been told yet (a
 * server may not report an expunge in the middle of a sequence FETCH, RFC 3501
 * 7.4.1), so the window it lists still has that uid, the row for it is missing,
 * and the refill fetches it and stores it again. The inbox shows a message the
 * server no longer has, until a later pass notices - and a list read in between
 * is the copy this device paints on its next visit.
 *
 * The guard is exact because IMAP never reuses a uid: within one UIDVALIDITY a
 * uid that left a folder cannot come back to it. So a uid Polaris moved or
 * deleted out of a folder is refused by `storeMessages` for that folder, and a
 * UIDVALIDITY change, which renumbers everything, forgets the folder's list.
 *
 * Held in memory, on `globalThis` so the server actions and the sync loop share
 * one list whichever bundle loaded the module. Bounded per folder and in time:
 * the race it closes lasts one pass, and a restart starts a fresh pass.
 */

/** How long a removed uid is refused. A pass that has been stuck this long has
 *  already been replaced by another, which opened the folder afresh. */
export const REMOVED_KEEP_MS = 6 * 60 * 60 * 1000;

/** Uids kept per folder; the oldest go first past it. */
export const REMOVED_PER_FOLDER = 5000;

const REMOVED = Symbol.for("polaris.mail.removedUids");

function removed(): Map<string, Map<number, number>> {
    const held = globalThis as { [REMOVED]?: Map<string, Map<number, number>> };
    held[REMOVED] ??= new Map();
    return held[REMOVED];
}

/** Write down uids the server confirmed it moved or deleted out of a folder. */
export function rememberRemoved(
    folderId: string,
    uids: Iterable<number | bigint>,
    now: number = Date.now()
): void {
    const folders = removed();
    const kept = folders.get(folderId) ?? new Map<number, number>();
    for (const uid of uids) {
        const key = Number(uid);
        // Re-inserted so the map's order stays oldest first.
        kept.delete(key);
        kept.set(key, now + REMOVED_KEEP_MS);
    }
    while (kept.size > REMOVED_PER_FOLDER) {
        const oldest = kept.keys().next();
        if (oldest.done) break;
        kept.delete(oldest.value);
    }
    if (kept.size > 0) folders.set(folderId, kept);
}

/** The uids of this folder still refused, with the expired ones dropped. */
export function removedFrom(folderId: string, now: number = Date.now()): ReadonlySet<number> {
    const folders = removed();
    const kept = folders.get(folderId);
    if (!kept) return new Set();
    for (const [uid, until] of kept) if (until <= now) kept.delete(uid);
    if (kept.size === 0) folders.delete(folderId);
    return new Set(kept.keys());
}

/** What of a fetch may be stored: everything but the uids removed from here. */
export function withoutRemoved<T extends { uid: number }>(
    folderId: string,
    fetched: readonly T[],
    now: number = Date.now()
): T[] {
    const gone = removedFrom(folderId, now);
    return gone.size === 0 ? [...fetched] : fetched.filter((message) => !gone.has(message.uid));
}

/** Forget a folder's list, for a UIDVALIDITY change that renumbered it. */
export function forgetRemoved(folderId: string): void {
    removed().delete(folderId);
}
