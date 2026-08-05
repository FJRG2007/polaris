"use client";

/**
 * The last answer Drive got for a folder, so walking back into it paints at once,
 * and the keys every other Drive read caches under.
 *
 * A remote listing is the one thing in Drive that is never free: it crosses SSH or
 * SMB to a machine that has to read a directory. Coming back to a folder you were
 * in ten seconds ago should not pay for that again, and moving the cursor over a
 * folder you are about to open is a good moment to pay for it early - which is what
 * every desktop file manager does and what makes them feel instant.
 *
 * The cache is a short-lived snapshot, not a source of truth: what it holds is
 * painted immediately and then replaced by the answer from the server, and any
 * write to a connection drops the lot rather than trying to work out which folder
 * it changed.
 *
 * Every Drive read that caches names its key here, next to the invalidation that
 * has to cover it - a screen that minted its own key would keep painting a deleted
 * file after the write that removed it.
 */

import type { DriveEntry } from "./types";
import { dropSnapshots, readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

/**
 * How old a listing may be and still be painted while the live one is fetched.
 * Short: a folder somebody else is also writing to should not look settled for
 * long, and the fetch behind it is already on its way.
 */
const TTL_MS = 30_000;

const KEY_PREFIX = "drive.list:";
const ACTIVITY_PREFIX = "drive.activity:";
const RECENT_PREFIX = "drive.recent:";

/** Every prefix a Drive read caches under, and so everything a write invalidates. */
const DRIVE_KEY_PREFIXES = [KEY_PREFIX, ACTIVITY_PREFIX, RECENT_PREFIX];

/** Folders whose prefetch is in flight, so a cursor crossing a row twice asks once. */
const inFlight = new Set<string>();

function key(connectionId: string, path: string): string {
    return `${KEY_PREFIX}${connectionId}:${path}`;
}

/** Key for a file's cached activity feed. */
export function activityKey(connectionId: string, path: string): string {
    return `${ACTIVITY_PREFIX}${connectionId}:${path}`;
}

/** Key for a connection's cached recent-files answer, one per lens. */
export function recentKey(connectionId: string, lens: string): string {
    return `${RECENT_PREFIX}${connectionId}:${lens}`;
}

/** The cached listing of a folder, or null when there is none worth painting. */
export function readListing(connectionId: string, path: string): DriveEntry[] | null {
    return readSnapshot<DriveEntry[]>(key(connectionId, path), TTL_MS)?.value ?? null;
}

export function writeListing(connectionId: string, path: string, entries: DriveEntry[]): void {
    writeSnapshot(key(connectionId, path), entries);
}

/** Forget every cached Drive read - listings, activity feeds and recent files.
 *  Called after any write, since a move or a copy can change a folder other than
 *  the one being looked at (including on another connection), and a delete drops a
 *  file the other two would otherwise keep listing. */
export function dropDriveSnapshots(): void {
    for (const prefix of DRIVE_KEY_PREFIXES) dropSnapshots(prefix);
}

/**
 * Fetch a folder's listing into the cache before it is asked for, on the hint that
 * somebody is about to open it (a cursor over the row, a focused link).
 *
 * Deliberately quiet: a prefetch that fails, is locked or needs a share name simply
 * does not cache anything, and the real navigation reports whatever is wrong.
 */
export function prefetchListing(connectionId: string, path: string): void {
    if (!connectionId || readListing(connectionId, path)) return;
    const id = key(connectionId, path);
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const query = new URLSearchParams({ c: connectionId });
    if (path) query.set("p", path);
    void fetch(`/api/drive/list?${query.toString()}`)
        .then(async (response) => {
            const body = (await response.json()) as { entries?: DriveEntry[] };
            if (response.ok && Array.isArray(body.entries))
                writeListing(connectionId, path, body.entries);
        })
        .catch(() => {
            // Nothing to report: this listing was never asked for out loud.
        })
        .finally(() => inFlight.delete(id));
}
