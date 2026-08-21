/**
 * What a camera is looking at right now, and what it was looking at then.
 *
 * The detector already knows where everything is - it is following each thing
 * across frames, and that is what makes one arrival one event. Until now none of
 * that reached a screen: the box was drawn on the still kept with an event, so
 * the only way to see what the camera had found was to go to the list afterwards
 * and look at a photograph of it. Watching the camera showed a picture of a
 * garden and left the reader to find the person in it themselves.
 *
 * So the same boxes are published while they are being followed, and drawn over
 * the live picture. Two rules make that safe, and both are here rather than in
 * the screens that draw them:
 *
 *   - A live box is worth nothing a moment later. Somebody walking crosses a
 *     frame in a couple of seconds, so a box that outlives its frame is a
 *     rectangle over an empty path - worse than no rectangle, because it is
 *     asserting something false. Everything published carries the clock it was
 *     published at and stops being drawn shortly after.
 *   - A recording is the opposite problem: the boxes are known exactly and the
 *     question is which of them belong to the moment being watched. An event
 *     covers a span, so a clip's boxes are the ones whose span contains the
 *     playhead.
 *
 * Pure: no clock of its own and no I/O, so both rules are tests rather than
 * something anybody has to reproduce by walking past a camera.
 */

import type { RelativeBox } from "./camera-zones.js";

/** One thing a camera is following, as a screen needs it. */
export interface LiveBox {
    /** The detector's own handle on it, stable while it is being followed. Used
     *  as a key, so a box that moves is redrawn rather than remounted. */
    readonly id: string;
    /**
     * What to write on it.
     *
     * The class it was detected as - "person", "vehicle" - or, once the
     * recognizer has put a name to somebody, that name. The name is the whole
     * point of the rung above: a box saying "person" at the front door is worth
     * far less than one saying who.
     */
    readonly label: string;
    /** How sure, 0-100. */
    readonly score: number;
    readonly box: RelativeBox;
}

/** One published moment of one camera. */
export interface LiveFrame {
    /** Epoch milliseconds, stamped where it is received rather than where it was
     *  sent: a worker's clock is not this machine's, and a worker running a
     *  minute fast would have every box expire before it was ever drawn. */
    readonly at: number;
    readonly boxes: readonly LiveBox[];
}

/**
 * How long a published frame is worth drawing.
 *
 * A little over two detector frames, so an ordinary gap between them does not
 * make the box blink, and short enough that the last frame of a burst is gone
 * about as fast as the thing it was drawn around.
 */
export const LIVE_TTL_MS = 2_500;

/** What is still worth drawing, given when it is being asked. */
export function freshBoxes(
    frame: LiveFrame | null | undefined,
    now: number,
    ttlMs: number = LIVE_TTL_MS
): readonly LiveBox[] {
    if (!frame) return [];
    // A frame stamped in the future is a clock that disagrees, not a frame worth
    // holding on to for twice as long.
    const age = now - frame.at;
    if (age > ttlMs || age < -ttlMs) return [];
    return frame.boxes;
}

/**
 * One thing a camera saw during a recording, and for how long.
 *
 * Milliseconds from the start of the clip rather than wall clock, because that
 * is what a player can answer: `currentTime` is an offset into the file and
 * nothing else.
 */
export interface ClipMark {
    readonly id: string;
    readonly label: string;
    readonly score: number;
    readonly box: RelativeBox;
    readonly fromMs: number;
    /** When it stopped being there, or null for something never seen to leave -
     *  a detector that was cut off, or the movement rung, which reports an
     *  instant and has no opinion about duration. */
    readonly toMs: number | null;
}

/**
 * How long a mark with no end is drawn for.
 *
 * Something that was never seen to leave has to be given a length by somebody,
 * and the choice is between a flash nobody catches and a box that stays up for
 * the rest of the clip claiming a person is still there. A couple of seconds is
 * long enough to see while scrubbing and short enough to be honest.
 */
export const MARK_FALLBACK_MS = 2_000;

/**
 * Turn what was written down into what covers a moment of the clip.
 *
 * Bounded to the marks that are actually on screen: a night of footage is a
 * hundred events, and drawing all of them at once is a picture with a hundred
 * rectangles on it rather than a picture of what happened.
 */
export function marksAt(
    marks: readonly ClipMark[],
    atMs: number,
    fallbackMs: number = MARK_FALLBACK_MS
): readonly ClipMark[] {
    return marks.filter((mark) => {
        const to = mark.toMs ?? mark.fromMs + fallbackMs;
        return atMs >= mark.fromMs && atMs < Math.max(to, mark.fromMs + 1);
    });
}

/**
 * Build a clip's marks from events and the moment the recording started.
 *
 * Events outside the clip are dropped rather than clamped to its edges: a box
 * pinned to the first frame because it happened before the recording began is a
 * rectangle that never matches the picture under it.
 */
export function marksForClip(
    events: readonly {
        id: string;
        at: string | number | Date;
        endedAt?: string | number | Date | null;
        label?: string | null;
        kind: string;
        score?: number | null;
        box?: RelativeBox | null;
    }[],
    clipStart: string | number | Date,
    clipDurationMs: number
): ClipMark[] {
    const started = new Date(clipStart).getTime();
    if (!Number.isFinite(started)) return [];
    const marks: ClipMark[] = [];
    for (const event of events) {
        if (!event.box) continue;
        const at = new Date(event.at).getTime();
        if (!Number.isFinite(at)) continue;
        const fromMs = at - started;
        if (fromMs < 0 || (clipDurationMs > 0 && fromMs > clipDurationMs)) continue;
        const ended = event.endedAt ? new Date(event.endedAt).getTime() : NaN;
        marks.push({
            id: event.id,
            label: event.label ?? event.kind,
            score: event.score ?? 0,
            box: event.box,
            fromMs,
            toMs: Number.isFinite(ended) ? ended - started : null
        });
    }
    return marks;
}
