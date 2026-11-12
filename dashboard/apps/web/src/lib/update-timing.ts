/**
 * How long a Polaris update takes, estimated from the ones this deployment has
 * already run - the progress bar on the Updates screen, readjusted after every
 * update the way Home Assistant's is.
 *
 * Pure: the store (`update-timing-store.ts`) keeps the history and the run in
 * progress, the screen draws what these answer.
 */

import { z } from "zod";

/** The guess before this deployment has timed an update of its own. */
export const DEFAULT_UPDATE_MS = 4 * 60_000;

/** How many past updates the estimate is drawn from. */
export const UPDATE_HISTORY_SIZE = 10;

/** Below this a "duration" is a clock that moved, not an update. */
const MIN_SAMPLE_MS = 5_000;

/** Past this a run is abandoned rather than slow, and never a sample. */
export const MAX_UPDATE_MS = 2 * 60 * 60_000;

/** How long after the updater exits the new build has to start answering. */
const LANDING_GRACE_MS = 3 * 60_000;

/** Where the bar stops while the update is still within its estimate. */
const ON_TIME_CEILING = 0.95;

/** Where it creeps toward once the update runs past it, never reaching it. */
const OVERDUE_CEILING = 0.99;

/** The update running now and the durations of the ones before it. */
export const updateTimingSchema = z.object({
    run: z
        .object({
            startedAt: z.number().finite().nonnegative(),
            from: z.string().max(200).nullable()
        })
        .nullable()
        .catch(null),
    history: z.array(z.number().finite()).max(100).catch([])
});

export type UpdateTiming = z.infer<typeof updateTimingSchema>;

/** What the screen is told about a run in progress. */
export interface UpdateRunTiming {
    /** When the update was accepted, epoch ms on the server's clock. */
    readonly startedAt: number;
    /** How long it is expected to take. */
    readonly estimateMs: number;
}

/** Read the stored row, total: anything unreadable is an empty history. */
export function parseUpdateTiming(raw: string | null): UpdateTiming {
    if (!raw) return { run: null, history: [] };
    try {
        const parsed = updateTimingSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : { run: null, history: [] };
    } catch {
        return { run: null, history: [] };
    }
}

/** Whether a measured duration is one an estimate can be drawn from. */
export function isUpdateSample(ms: number): boolean {
    return Number.isFinite(ms) && ms >= MIN_SAMPLE_MS && ms <= MAX_UPDATE_MS;
}

/** The history with one more update in it, keeping only the latest ones. */
export function recordUpdateSample(history: readonly number[], ms: number): number[] {
    if (!isUpdateSample(ms)) return history.slice(-UPDATE_HISTORY_SIZE);
    return [...history, Math.round(ms)].slice(-UPDATE_HISTORY_SIZE);
}

/**
 * The expected duration of the next update: the median of the past ones, so one
 * update that pulled a large image or waited on a slow disk does not move it much.
 */
export function estimateUpdateMs(history: readonly number[]): number {
    const samples = history.filter(isUpdateSample).sort((a, b) => a - b);
    if (samples.length === 0) return DEFAULT_UPDATE_MS;
    const middle = Math.floor(samples.length / 2);
    const median =
        samples.length % 2 === 1 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
    return Math.round(median);
}

/** Where the bar is and what it says, for an update that has not finished. */
export interface UpdateProgress {
    /** 0 to just under 1: it reaches 1 only when the update has landed. */
    readonly fraction: number;
    /** Time left by the estimate; 0 once past it. */
    readonly remainingMs: number;
    /** Running past the estimate - said as "taking longer", not a frozen bar. */
    readonly overdue: boolean;
}

/**
 * Elapsed against the estimate. Linear up to the estimate, then a slow approach
 * that keeps moving without ever claiming the update is done.
 */
export function updateProgress(elapsedMs: number, estimateMs: number): UpdateProgress {
    const estimate = estimateMs > 0 ? estimateMs : DEFAULT_UPDATE_MS;
    const elapsed = Math.max(0, elapsedMs);
    if (elapsed <= estimate) {
        return {
            fraction: (elapsed / estimate) * ON_TIME_CEILING,
            remainingMs: estimate - elapsed,
            overdue: false
        };
    }
    const past = (elapsed - estimate) / estimate;
    return {
        fraction: ON_TIME_CEILING + (OVERDUE_CEILING - ON_TIME_CEILING) * (1 - Math.exp(-past)),
        remainingMs: 0,
        overdue: true
    };
}

/** How a finished run on the host ended, as far as its log says. */
export interface RunOutcome {
    readonly exitCode: number | null;
    readonly endedAt: number;
}

/**
 * What the stored timing becomes now, or null when nothing changes.
 *
 * The update has landed once a different build is answering than the one that
 * started it - the moment it is measured to. Where either build is unknown (a
 * deployment without a build stamp) the updater's own successful exit stands in.
 * A failed run, or one older than any update could take, is dropped unmeasured.
 */
export function settleUpdateTiming(
    timing: UpdateTiming,
    build: string | null,
    outcome: RunOutcome | null,
    now: number
): UpdateTiming | null {
    const run = timing.run;
    if (!run) return null;
    const ended = outcome && outcome.exitCode !== null && outcome.endedAt >= run.startedAt;
    if (build && run.from && build !== run.from) {
        return { run: null, history: recordUpdateSample(timing.history, now - run.startedAt) };
    }
    if (ended && outcome.exitCode !== 0) return { run: null, history: timing.history };
    if (ended && (!build || !run.from)) {
        return { run: null, history: recordUpdateSample(timing.history, outcome.endedAt - run.startedAt) };
    }
    // Finished well and still the same build a while later: nothing new was
    // installed, so there is nothing to measure.
    if (ended && now - outcome.endedAt > LANDING_GRACE_MS) return { run: null, history: timing.history };
    if (now - run.startedAt > MAX_UPDATE_MS) return { run: null, history: timing.history };
    return null;
}
