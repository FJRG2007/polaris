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
    /** The log's full size, so a caller can seek to its end in one more read. */
    readonly size: number;
    /** The caller has read to the end of a finished run. */
    readonly done: boolean;
    /** The code the run reported, or null when it reported none - which means the
     *  outcome is unknown, not that it succeeded and not that it died. */
    readonly exitCode: number | null;
    /** The run has ended, however much of the log the caller has read. */
    readonly finished: boolean;
    /** Last write to the log file, epoch ms (0 when there is no log). */
    readonly updatedAt: number;
    /** The host's clock when it read the log, epoch ms. */
    readonly now: number;
}

/** A log nobody has written to for this long is a crashed run, not a live one. */
export const STALE_LOG_MS = 10 * 60 * 1000;

/** How long a finished run stays on the settings card after it ended. */
export const RECENT_RUN_MS = 30 * 60 * 1000;

/**
 * Whether an update is still running, judged from the log alone. A finished run
 * carries the updater's exit marker; a run whose log went quiet long ago is
 * treated as dead, so a leftover log never leaves the page waiting forever.
 */
export function isUpdateInFlight(tail: UpdateLogTail, now: number): boolean {
    if (!tail.exists || tail.finished) return false;
    return now - tail.updatedAt <= STALE_LOG_MS;
}

/**
 * Whether the log belongs to a run worth showing on a page that did not start
 * it. An update outlives the tab that triggered it - the web container restarts
 * mid-run - so after a reload the card would otherwise be idle and offer the
 * same update again, with no sign that one just ran.
 *
 * A run reached this way may have reported no code, and that is not the same as
 * having died: a build whose current step is quiet for longer than STALE_LOG_MS
 * lands here while still running. The caller shows the outcome as unrecorded
 * rather than deciding which of the two it was.
 */
export function isRecentRun(tail: UpdateLogTail, now: number): boolean {
    return tail.exists && now - tail.updatedAt <= RECENT_RUN_MS;
}
