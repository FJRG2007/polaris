/**
 * What each camera's pipeline has been doing, as the worker last reported it.
 *
 * The detection ladder is silent by design. A burst that runs and finds nothing
 * writes nothing; so does a burst that never ran; so does a camera whose model
 * never loaded. Every one of those states looks identical from a screen - no
 * events - and the only way anybody has been able to tell them apart is a
 * terminal, a container and a process listing. The operator has none of those
 * and is not supposed to need them.
 *
 * So the worker publishes four moments per camera and they are held here. Held
 * rather than stored for the same reason the live positions are: this is a
 * status line, it is replaced every half minute, and a row per camera per
 * half-minute is a table that grows forever to answer a question nobody asks
 * about yesterday.
 *
 * It follows that a restart of the dashboard empties it, and a screen read in
 * that first half minute says "not reported yet" rather than inventing
 * something. That is the honest answer and it is short-lived.
 *
 * Server-only.
 */

/** What one camera's pipeline has been doing. The worker's own shape. */
export interface CameraActivity {
    /** Whether its stream is open right now. */
    readonly watching: boolean;
    /** Epoch ms of the last movement that counted, the last close look, and the
     *  last thing that look found. Null for one that has not happened yet. */
    readonly motionAt: number | null;
    readonly lookedAt: number | null;
    readonly foundAt: number | null;
    readonly found: string | null;
    /** Why it is on a lower rung than it was set to, when it is. */
    readonly limitedTo: string | null;
    /** When the worker said all this, stamped here - a worker's clock is not
     *  this machine's, and the screen prints ages. */
    readonly at: number;
}

/**
 * How long a report is worth showing.
 *
 * Comfortably more than the half minute between them, so an ordinary late one
 * does not blank the screen, and short enough that a worker somebody switched
 * off stops claiming to be watching a camera.
 */
export const ACTIVITY_TTL_MS = 100_000;

const reports = new Map<string, CameraActivity>();

/** A ceiling, for the same reason the live positions have one: the key comes
 *  from a request, and a worker with a wrong id must not grow this one made-up
 *  camera at a time. */
const MAX_CAMERAS = 512;

export function publishActivity(cameraId: string, activity: Omit<CameraActivity, "at">): void {
    const at = Date.now();
    if (!reports.has(cameraId) && reports.size >= MAX_CAMERAS) {
        for (const [id, report] of reports) {
            if (at - report.at > ACTIVITY_TTL_MS) reports.delete(id);
        }
        if (reports.size >= MAX_CAMERAS) return;
    }
    reports.set(cameraId, { ...activity, at });
}

/** What this camera's worker last said, or null when nothing has said anything
 *  recently enough to be worth printing. */
export function cameraActivity(cameraId: string): CameraActivity | null {
    const report = reports.get(cameraId);
    if (!report) return null;
    const age = Date.now() - report.at;
    return age > ACTIVITY_TTL_MS || age < -ACTIVITY_TTL_MS ? null : report;
}
