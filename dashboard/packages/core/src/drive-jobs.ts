/**
 * Long work in Drive, and how far along it is.
 *
 * Moving seven thousand files to the bin is minutes of work, and the screen that
 * started it used to say "Working in the background" and nothing else - no count,
 * no bar, no idea whether it was halfway or stuck. A spinner with no number
 * beside it is indistinguishable from a hang, which is why people press the
 * button again.
 *
 * So a job says what it is doing out of how much, and this works out the rest:
 * the fraction, the sentence, and how long it looks like it has left. All of it
 * pure, because it is read on every poll and asserted in a test rather than
 * eyeballed once against a folder somebody happened to have.
 */

/** What a job is doing to the paths it was given. */
export const DRIVE_JOB_KINDS = ["trash", "delete", "restore"] as const;

export type DriveJobKind = (typeof DRIVE_JOB_KINDS)[number];

/**
 * Where a job is.
 *
 * `queued` and `running` are the same thing to a reader - it is happening - and
 * different to a worker, which is the only reason both exist. `finished` covers
 * a job that had failures in it: what failed is a count and a sentence on the
 * job, not a state of its own, because a run where six files of seven thousand
 * would not move is a run that did its job.
 */
export const DRIVE_JOB_STATES = ["queued", "running", "finished", "cancelled"] as const;

export type DriveJobState = (typeof DRIVE_JOB_STATES)[number];

export interface DriveJobProgress {
    readonly total: number;
    readonly done: number;
    readonly failed: number;
    readonly state: DriveJobState;
    /** When the worker first picked it up, or null while it is still queued. */
    readonly startedAt: string | null;
}

/** How much of it is behind us, 0 to 1. A job with nothing in it is finished by
 *  definition rather than divided by zero. */
export function driveJobFraction(job: Pick<DriveJobProgress, "total" | "done">): number {
    if (job.total <= 0) return 1;
    return Math.min(1, Math.max(0, job.done / job.total));
}

/**
 * How long it looks like it has left, in milliseconds, or null.
 *
 * Null rather than a guess whenever a guess would be a lie: before anything has
 * finished there is no rate to extrapolate from, and in the first couple of
 * seconds the rate is whatever the first file happened to cost. A number that
 * swings from "12 minutes" to "40 seconds" and back is worse than no number,
 * because people plan around it.
 */
export function driveJobRemainingMs(
    job: Pick<DriveJobProgress, "total" | "done" | "startedAt">,
    now: number
): number | null {
    if (!job.startedAt || job.done <= 0 || job.done >= job.total) return null;
    const elapsed = now - new Date(job.startedAt).getTime();
    if (!Number.isFinite(elapsed) || elapsed < SETTLE_MS) return null;
    const perItem = elapsed / job.done;
    return Math.round(perItem * (job.total - job.done));
}

/** How long a job runs before its rate is worth believing. Under this, one slow
 *  first file decides the whole estimate. */
const SETTLE_MS = 3000;

/**
 * The remaining time, as somebody reads it.
 *
 * Rounded hard on purpose: nobody wants "4 minutes 37 seconds left" on a bar
 * they are not watching, and pretending to that precision invites somebody to
 * check it. Under a minute is "less than a minute" rather than a countdown of
 * seconds, which would be the only part of this that ever looked wrong.
 */
export function driveJobEta(remainingMs: number | null): string | null {
    if (remainingMs === null || remainingMs < 0) return null;
    const minutes = Math.round(remainingMs / 60_000);
    if (minutes <= 0) return "less than a minute left";
    if (minutes === 1) return "about a minute left";
    if (minutes < 60) return `about ${minutes} minutes left`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? "about an hour left" : `about ${hours} hours left`;
}

/**
 * What the panel says under the label.
 *
 * The count first, because that is the question - and the failures only when
 * there are some, so an ordinary run is not decorated with a zero that invites
 * somebody to wonder what it means.
 */
export function driveJobSummary(job: DriveJobProgress, now: number): string {
    if (job.state === "cancelled") return `Stopped after ${job.done} of ${job.total}`;
    if (job.state === "finished") {
        return job.failed > 0
            ? `${job.done} of ${job.total} done, ${job.failed} could not be`
            : `${job.done} done`;
    }
    const parts = [`${job.done} of ${job.total}`];
    if (job.failed > 0) parts.push(`${job.failed} failed`);
    const eta = driveJobEta(driveJobRemainingMs(job, now));
    if (eta) parts.push(eta);
    return parts.join(" - ");
}
