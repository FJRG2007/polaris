/**
 * Shared shape and freshness rule for the update log tail served by
 * `/api/updates/logs`. An update runs on the host and outlives the page that
 * started it, so the log file - not client state - is what tells a freshly loaded
 * settings page that an update is still in flight.
 */

export interface UpdateLogTail {
    readonly exists: boolean;
    readonly content: string;
    readonly nextOffset: number;
    /** The caller has read to the end of a finished run. */
    readonly done: boolean;
    readonly exitCode: number | null;
    /** The run has ended, however much of the log the caller has read. */
    readonly finished: boolean;
    /** Last write to the log file, epoch ms (0 when there is no log). */
    readonly updatedAt: number;
}

/** A log nobody has written to for this long is a crashed run, not a live one. */
export const STALE_LOG_MS = 10 * 60 * 1000;

/**
 * Whether an update is still running, judged from the log alone. A finished run
 * carries the updater's exit marker; a run whose log went quiet long ago is
 * treated as dead, so a leftover log never leaves the page waiting forever.
 */
export function isUpdateInFlight(tail: UpdateLogTail, now: number): boolean {
    if (!tail.exists || tail.finished) return false;
    return now - tail.updatedAt <= STALE_LOG_MS;
}
