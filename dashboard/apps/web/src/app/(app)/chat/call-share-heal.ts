/**
 * A shared screen that puts itself back together.
 *
 * The outage this answers: a sharer's connection dropped and came back, the
 * media client republished the screen on its own, and the server took that
 * second publication badly - viewers were handed a share that said it was on
 * and never delivered a frame, until the sharer stopped and shared again by
 * hand. Two halves, one per end of the call, and both decided here so they can
 * be checked without a browser:
 *
 * - the sharer puts the screen up again cleanly after a reconnection, or after
 *   a publish that failed, on a short backoff and a fixed number of tries;
 * - a viewer whose subscription has not decoded a single frame for a while
 *   lets go of it and takes it again, a few times, and only says something when
 *   that has not worked.
 */

/** How long to wait before each republish of a shared screen, in order. The
 *  first gives the client's own republish a moment to land, so the clean one
 *  replaces it rather than racing it. One entry per try. */
export const SHARE_REPUBLISH_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

/** The wait before republish attempt `attempt` (0-based), or null once the
 *  tries are spent. */
export function republishDelay(attempt: number): number | null {
    if (!Number.isInteger(attempt) || attempt < 0) return null;
    return SHARE_REPUBLISH_DELAYS_MS[attempt] ?? null;
}

/** How long a subscription may go without its first decoded frame before it is
 *  taken again. Each further try waits one more of these. */
export const SHARE_STALL_MS = 5_000;

/** Resubscriptions before a viewer is told the screen is not arriving. */
export const SHARE_RESUBSCRIBE_TRIES = 3;

/** What one viewer knows about one shared screen it is subscribed to. */
export interface ShareWatch {
    /** The publication being watched. A new one starts the watch over. */
    readonly sid: string;
    /** Frames decoded at the last reading. */
    readonly frames: number;
    /** When the count last moved, or when this receiver started. */
    readonly since: number;
    /** Whether this receiver has decoded anything at all. */
    readonly decoded: boolean;
    /** Resubscriptions spent without a frame coming through. */
    readonly tries: number;
    /** Whether the viewer has already been told it is not arriving. */
    readonly gaveUp: boolean;
}

export type ShareVerdict = "wait" | "resubscribe" | "give-up";

/**
 * What to do about one shared screen, given a fresh frame count.
 *
 * Only a receiver that has never decoded a frame is judged. A screen nobody is
 * touching legitimately sends nothing at all once its picture has settled, so
 * a count that stops after it started is a still document, not a fault - and
 * resubscribing it every few seconds would be a blink for nothing. The outage
 * this exists for is the other shape: a publication that delivers nothing from
 * the start, which a fresh subscription after the sharer's republish always is.
 *
 * `frames` is undefined when the receiver has no inbound report yet, which only
 * happens before its first packet - the same as a count of zero.
 */
export function watchShare(
    previous: ShareWatch | undefined,
    reading: { readonly sid: string; readonly frames: number | undefined; readonly at: number }
): { watch: ShareWatch; verdict: ShareVerdict } {
    const frames = reading.frames ?? 0;
    const at = reading.at;
    if (!previous || previous.sid !== reading.sid) {
        return {
            watch: {
                sid: reading.sid,
                frames,
                since: at,
                decoded: frames > 0,
                tries: 0,
                gaveUp: false
            },
            verdict: "wait"
        };
    }
    // A count that moved, either way up or onto a new receiver that already has
    // something, is pictures arriving: whatever was wrong has mended.
    if (frames > previous.frames || (frames < previous.frames && frames > 0)) {
        return {
            watch: { sid: previous.sid, frames, since: at, decoded: true, tries: 0, gaveUp: false },
            verdict: "wait"
        };
    }
    if (frames < previous.frames) {
        // Back to zero: a new receiver after a resubscription. It has to show
        // its first frame like any other, timed from now.
        return { watch: { ...previous, frames, since: at, decoded: false }, verdict: "wait" };
    }
    if (previous.decoded || previous.gaveUp) return { watch: previous, verdict: "wait" };
    if (at - previous.since < SHARE_STALL_MS * (previous.tries + 1)) {
        return { watch: previous, verdict: "wait" };
    }
    if (previous.tries >= SHARE_RESUBSCRIBE_TRIES) {
        return { watch: { ...previous, gaveUp: true }, verdict: "give-up" };
    }
    return {
        watch: { ...previous, since: at, tries: previous.tries + 1 },
        verdict: "resubscribe"
    };
}
