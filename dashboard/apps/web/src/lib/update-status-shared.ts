/**
 * The newest update status this page has seen, shared by everything on it that
 * shows one.
 *
 * The badge in the top bar and the Updates screen used to ask the server each
 * on their own clock - the badge every six hours, the screen every five
 * minutes - so the badge could say an update was waiting while the screen it
 * links to still said there was nothing, until somebody pressed Check. Every
 * answer either of them gets now lands here, and both draw the newest one.
 *
 * The server answers from a cache and refreshes it in the background once it is
 * older than ten minutes, so the first answer after a quiet spell is the old
 * one. `isStale` says so, and whoever asked asks again a few seconds later to
 * pick up the refreshed answer instead of keeping the old one for minutes.
 */

import type { UpdateStatus } from "@/lib/update-service";

/** How old an answer is before the server refreshes it (`CACHE_TTL_MS` in
 *  `update-service`). */
const SERVER_TTL_MS = 10 * 60_000;

/** How long after a stale answer to ask again: the server's own refresh is one
 *  registry or GitHub read. */
export const STALE_RETRY_MS = 5_000;

let latest: UpdateStatus | null = null;
const listeners = new Set<(status: UpdateStatus) => void>();

function checkedAt(status: UpdateStatus): number {
    const at = Date.parse(status.checkedAt);
    return Number.isNaN(at) ? 0 : at;
}

/** Note an answer. Kept, and announced, only when it is newer than the last one. */
export function noteUpdateStatus(status: UpdateStatus): void {
    if (latest && checkedAt(status) < checkedAt(latest)) return;
    if (latest && checkedAt(status) === checkedAt(latest) && latest.phase === status.phase) return;
    latest = status;
    for (const listener of listeners) listener(status);
}

/** The newest answer this page has seen, or null for none yet. */
export function latestUpdateStatus(): UpdateStatus | null {
    return latest;
}

/** Hear every newer answer. Answers the way to stop. */
export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/** Whether the server answered from a cache it is refreshing right now. */
export function isStale(status: UpdateStatus, now = Date.now()): boolean {
    return now - checkedAt(status) >= SERVER_TTL_MS;
}

/** Forget everything. Exists for tests. */
export function resetSharedUpdateStatus(): void {
    latest = null;
    listeners.clear();
}
