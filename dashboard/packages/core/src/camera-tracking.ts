/**
 * Following one thing across frames, so that one thing that happened is one
 * event.
 *
 * A detector has no memory. Asked about ten frames of somebody walking up a
 * drive it answers "person" ten times, and a house that writes down each answer
 * ends up with ten rows, ten pictures and ten alerts for one visit. That is the
 * single biggest difference between a detector and a camera system, and this is
 * the part that makes it.
 *
 * What it does is small. Each frame, every box is matched to the nearest thing
 * of its class in the last frame; a box that matches nothing is something new; a
 * thing that goes unmatched for long enough has left. Around that sit three
 * rules that all exist because of the same problem - a detector is confident and
 * wrong several times an hour:
 *
 *   - Nothing is reported the first time it is seen. It has to survive a few
 *     frames, which almost nothing spurious does.
 *   - The picture kept is not the first frame, it is the best one: the frame
 *     where the thing was biggest, most confidently recognized, and not half out
 *     of shot. A person is identifiable in one frame of a walk-past and a smear
 *     in the rest, and the first frame is rarely the good one.
 *   - What it saw is the median of what it was scored, not the highest. A
 *     detector that says 0.9 once and 0.3 nine times did not see a person.
 *
 * All of it is pure: state in, state out, no clock and no randomness, so a whole
 * walk-past can be played frame by frame in a test.
 */

import type { RelativeBox, Zone, ZonePresence } from "./camera-zones.js";
import { advancePresence, boxArea, NO_PRESENCE, onEdge } from "./camera-zones.js";

/** The best frame of a thing so far, which is what a still gets grabbed for. */
export interface Snapshot {
    readonly score: number;
    readonly box: RelativeBox;
    /** Which frame of this object's life it was, so the caller can tell whether
     *  the picture it is holding is still the right one. */
    readonly frame: number;
}

/** One thing being followed. */
export interface TrackedObject {
    readonly id: string;
    /** The class a house calls it. Matching is per class: a person walking past
     *  a parked car must not become the car. */
    readonly label: string;
    readonly box: RelativeBox;
    /** What it was scored this frame. */
    readonly score: number;
    /** The last few scores, which is what `confidence` is taken from. */
    readonly scores: readonly number[];
    /** Frames it has been seen in, ever. */
    readonly hits: number;
    /** Frames running it has not been seen. */
    readonly missing: number;
    /** When it was first and last seen, as the caller's own milliseconds. */
    readonly firstSeen: number;
    readonly lastSeen: number;
    /** Whether the caller has been told about it. Set by the caller, carried
     *  here, so a thing is announced once however long it stays. */
    readonly reported: boolean;
    readonly best: Snapshot | null;
    readonly zones: ZonePresence;
}

export interface TrackingState {
    readonly objects: readonly TrackedObject[];
    /** Ids are minted from this rather than from a clock or a random number, so
     *  the same frames always produce the same ids. */
    readonly counter: number;
}

export const NO_TRACKING: TrackingState = { objects: [], counter: 0 };

export interface TrackingOptions {
    /** The caller's clock, passed in rather than read. */
    readonly now: number;
    /** How far, as a fraction of the frame, a thing may have moved between two
     *  frames and still be the same thing. Overlap would be the obvious test and
     *  is the wrong one: somebody walking briskly past a doorway shares no
     *  pixels at all with themselves a fifth of a second ago, and would be
     *  reported as a new person every frame. */
    readonly maxDistance?: number;
    /** Frames it must be seen in before it is worth telling anybody about. */
    readonly minHits?: number;
    /** Frames it may go unseen before it has left. A person behind a pillar is
     *  gone for a frame or two and has not left. */
    readonly maxMissing?: number;
    /** The camera's zones, advanced per object per frame. */
    readonly zones?: readonly Zone[];
    /** Frames a second, which is what a zone's loitering seconds are counted in. */
    readonly fps?: number;
}

/** What one frame changed. */
export interface TrackingUpdate {
    readonly state: TrackingState;
    /** Things that have now been seen enough times to be worth reporting and
     *  have not been reported yet. */
    readonly appeared: readonly TrackedObject[];
    /** Things that have left. A thing nobody was ever told about leaves quietly
     *  and is not in here. */
    readonly ended: readonly TrackedObject[];
}

/** One detection as the tracker takes it. */
export interface TrackInput {
    readonly label: string;
    readonly score: number;
    readonly box: RelativeBox;
}

/** The middle of the scores it has been given, which is a fairer answer than
 *  the best of them: a detector that was sure once and unsure nine times was
 *  wrong once. */
export function confidenceOf(object: TrackedObject): number {
    if (object.scores.length === 0) return 0;
    const sorted = [...object.scores].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/**
 * Whether this frame is a better picture of the thing than the one being held.
 *
 * In order: a thing half out of shot is never a better picture than one fully in
 * it, however confident the detector was about the half it could see. Otherwise
 * a clearly better score wins, and failing that a clearly bigger box does -
 * bigger means closer, and closer is the frame somebody can actually recognize a
 * face in. The margins are there so the held picture is not replaced every frame
 * by noise.
 */
export function isBetterSnapshot(current: Snapshot | null, candidate: { score: number; box: RelativeBox }): boolean {
    if (!current) return true;
    const candidateOnEdge = onEdge(candidate.box);
    const currentOnEdge = onEdge(current.box);
    if (candidateOnEdge && !currentOnEdge) return false;
    if (!candidateOnEdge && currentOnEdge) return true;
    if (candidate.score > current.score + 0.05) return true;
    return boxArea(candidate.box) > boxArea(current.box) * 1.1;
}

/** The middle of a box, which is what one frame's things are matched to the
 *  next frame's by. */
function centroid(box: RelativeBox): { x: number; y: number } {
    return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
}

function distance(a: RelativeBox, b: RelativeBox): number {
    const first = centroid(a);
    const second = centroid(b);
    return Math.hypot(first.x - second.x, first.y - second.y);
}

/**
 * Advance the tracker by one frame.
 *
 * Matching is greedy on distance rather than optimal: the closest pair is taken,
 * then the closest of what is left, and so on. An optimal assignment is the
 * textbook answer and needs a solver; at the handful of things a home camera
 * sees at once the two agree, and the one that needs no solver is the one that
 * runs on a home server.
 */
export function trackFrame(
    state: TrackingState,
    detections: readonly TrackInput[],
    options: TrackingOptions
): TrackingUpdate {
    const maxDistance = options.maxDistance ?? 0.25;
    const minHits = options.minHits ?? 3;
    const maxMissing = options.maxMissing ?? 5;
    const zones = options.zones ?? [];
    const fps = options.fps ?? 5;

    const pairs: { objectIndex: number; detectionIndex: number; apart: number }[] = [];
    state.objects.forEach((object, objectIndex) => {
        detections.forEach((detection, detectionIndex) => {
            // Per class, because a person walking in front of a parked car must
            // not become the car.
            if (detection.label !== object.label) return;
            const apart = distance(object.box, detection.box);
            if (apart <= maxDistance) pairs.push({ objectIndex, detectionIndex, apart });
        });
    });
    pairs.sort((a, b) => a.apart - b.apart);

    const takenObjects = new Set<number>();
    const takenDetections = new Set<number>();
    const matched = new Map<number, number>();
    for (const pair of pairs) {
        if (takenObjects.has(pair.objectIndex) || takenDetections.has(pair.detectionIndex)) continue;
        takenObjects.add(pair.objectIndex);
        takenDetections.add(pair.detectionIndex);
        matched.set(pair.objectIndex, pair.detectionIndex);
    }

    const objects: TrackedObject[] = [];
    const appeared: TrackedObject[] = [];
    const ended: TrackedObject[] = [];

    state.objects.forEach((object, objectIndex) => {
        const detectionIndex = matched.get(objectIndex);
        if (detectionIndex === undefined) {
            const missing = object.missing + 1;
            if (missing > maxMissing) {
                // Only worth announcing the end of something somebody was told
                // the start of.
                if (object.reported) ended.push(object);
                return;
            }
            objects.push({ ...object, missing });
            return;
        }

        const detection = detections[detectionIndex]!;
        const hits = object.hits + 1;
        const scores = [...object.scores, detection.score].slice(-10);
        const candidate = { score: detection.score, box: detection.box };
        const updated: TrackedObject = {
            ...object,
            box: detection.box,
            score: detection.score,
            scores,
            hits,
            missing: 0,
            lastSeen: options.now,
            best: isBetterSnapshot(object.best, candidate)
                ? { score: detection.score, box: detection.box, frame: hits }
                : object.best,
            zones: advancePresence(object.zones, zones, detection.box, object.label, fps)
        };
        objects.push(updated);
        if (!updated.reported && hits >= minHits) appeared.push(updated);
    });

    let counter = state.counter;
    detections.forEach((detection, detectionIndex) => {
        if (takenDetections.has(detectionIndex)) return;
        counter += 1;
        objects.push({
            id: `${options.now}-${counter}`,
            label: detection.label,
            box: detection.box,
            score: detection.score,
            scores: [detection.score],
            hits: 1,
            missing: 0,
            firstSeen: options.now,
            lastSeen: options.now,
            reported: false,
            best: { score: detection.score, box: detection.box, frame: 1 },
            zones: advancePresence(NO_PRESENCE, zones, detection.box, detection.label, fps)
        });
    });

    return { state: { objects, counter }, appeared, ended };
}

/** Mark things as told-about, which is the caller's half of the bargain: the
 *  tracker decides what is worth reporting, the caller decides whether it
 *  managed to. */
export function markReported(state: TrackingState, ids: readonly string[]): TrackingState {
    const reported = new Set(ids);
    return {
        ...state,
        objects: state.objects.map((object) => (reported.has(object.id) ? { ...object, reported: true } : object))
    };
}
