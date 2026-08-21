/**
 * One camera, from pixels to a line in somebody's list.
 *
 * The shape is a ladder and every rung gates the next, which is the only reason
 * a house of cameras is affordable at all:
 *
 *   1. A run of small grey frames, a couple a second, compared against a slowly
 *      updated average of the scene. This is the only thing running while
 *      nothing is happening, and it is a few percent of one core.
 *   2. Movement that lasts, in a part of the picture the owner cares about. A
 *      gust, a moth and a lorry going past are all over before this.
 *   3. Only then, a second look: full-colour frames at a useful rate, through
 *      the detection model, for as long as something is actually there. This is
 *      the expensive part and it runs seconds a day.
 *   4. What the model saw is followed across those frames, so one arrival is one
 *      event with one picture - the best frame of it - rather than one an
 *      instant.
 *   5. And if the camera was told to, the person it found is put to a name.
 *
 * Nothing here decides policy. What to watch, how sensitive, which classes, what
 * areas: all of it arrives in the assignment, and Polaris is what decides it.
 */

import type { LoadedModel } from "./model.js";
import { encodeJpeg, openDetectFrames, openMotionFrames, probeSize, type FrameStream, type StreamSource } from "./frames.js";
import {
    buildMotionMask,
    detectMotion,
    groundPoint,
    letterboxFor,
    markReported,
    newMotionState,
    NO_TRACKING,
    pointInPolygon,
    readDetections,
    trackFrame,
    zonesAllow,
    type MotionState,
    type RelativeBox,
    type TrackedObject,
    type TrackingState,
    type Zone
} from "@polaris/core";

/** What one camera's worker is told to do. The server's own shape, verbatim. */
export interface Assignment {
    cameraId: string;
    cameraName: string;
    streamUrl: string;
    authorization: string;
    sensitivity: number;
    minGapSeconds: number;
    settleSeconds: number;
    detector: "motion" | "objects" | "faces";
    classes: string[];
    hours: { from: number; to: number } | null;
    zones: Zone[];
    faces: { baseUrl: string; apiKey: string; threshold: number } | null;
}

/** What the worker sends back. */
export interface Report {
    cameraId: string;
    kind: string;
    label?: string | null;
    score?: number | null;
    still?: Buffer | null;
    box?: [number, number, number, number] | null;
    zones?: string[];
    trackId?: string | null;
    ended?: boolean;
}

export interface WatchDeps {
    report(report: Report): Promise<boolean>;
    model: LoadedModel | null;
    log(message: string): void;
}

/** The width the movement watcher works at. Small on purpose: at this size a
 *  frame is a few kilobytes, a comparison is one pass over it, and it is more
 *  than enough to see that somebody walked into a garden. */
const MOTION_WIDTH = 160;

/**
 * The height it works at.
 *
 * Fixed rather than taken from the camera's own shape, so it is the same
 * comparison whatever is pointed at it - and the picture is squashed into it
 * rather than cropped. That distortion costs nothing here: movement has no
 * shape rules, and everything this stage produces is a fraction of the frame,
 * which is the same fraction whether the frame was squashed or not.
 */
const MOTION_HEIGHT = 90;

/** Frames a second for movement. Two is enough to catch somebody walking past
 *  and is a fraction of the work of decoding everything. */
const MOTION_FPS = 2;

/** Frames a second while something is happening. Five is what the field settled
 *  on: enough that somebody walking briskly is still recognizably themselves
 *  from one frame to the next, which is what following them depends on. */
const DETECT_FPS = 5;

/** The longest one burst may run, however busy the view is. A camera pointed at
 *  a party must not become a detector running continuously. */
const BURST_MAX_FRAMES = DETECT_FPS * 30;

/** Frames of nothing at all before a burst gives up. */
const BURST_IDLE_FRAMES = DETECT_FPS * 2;

/** How many frames are held in memory as candidate pictures. Each is half a
 *  megabyte, and a house camera never has this many things in it at once. */
const MAX_HELD_FRAMES = 6;

/** How often an event already reported may be improved with a better picture. */
const IMPROVE_GAP_MS = 3000;

export interface Watch {
    readonly signature: string;
    stop(): void;
}

/** Whether the camera's window says it should be looking. Local time, because
 *  the hours were set by somebody living in it. */
function withinHours(assignment: Assignment, hour: number): boolean {
    if (!assignment.hours) return true;
    const { from, to } = assignment.hours;
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * Whether movement here is in a part of the picture worth looking at.
 *
 * The ignored areas are already gone - they were masked out of the pixels
 * before anything was compared - so this is only the other half of the rule: if
 * the owner drew any watched areas at all, movement has to be in one of them.
 *
 * A watched area's class filter is deliberately not applied. Movement has no
 * class, and an area that says "vehicles" is still saying "this part of the
 * picture is the part that matters" - which is the question being asked here.
 */
function movementIn(zones: readonly Zone[], box: RelativeBox): string[] {
    const point = groundPoint(box);
    return zones
        .filter((zone) => zone.kind === "watch" && zone.enabled && pointInPolygon(point, zone.points))
        .map((zone) => zone.name);
}

/** Whether movement here is worth acting on at all: anywhere, if nothing was
 *  drawn, and otherwise only inside something that was. */
function movementCounts(zones: readonly Zone[], box: RelativeBox): boolean {
    if (!zones.some((zone) => zone.kind === "watch" && zone.enabled)) return true;
    return movementIn(zones, box).length > 0;
}

/** The smallest box that covers all of them, which is what a camera on the
 *  movement rung reports as where it happened. */
function union(boxes: readonly RelativeBox[]): RelativeBox | null {
    if (boxes.length === 0) return null;
    return boxes.reduce((wide, box) => ({
        x1: Math.min(wide.x1, box.x1),
        y1: Math.min(wide.y1, box.y1),
        x2: Math.max(wide.x2, box.x2),
        y2: Math.max(wide.y2, box.y2)
    }));
}

export function watchCamera(assignment: Assignment, deps: WatchDeps): Watch {
    const source: StreamSource = { url: assignment.streamUrl, authorization: assignment.authorization };
    let stopped = false;
    let motionStream: FrameStream | null = null;
    let burst: FrameStream | null = null;
    let busy = false;
    let lastFired = 0;
    let movingFrames = 0;

    /** The size of the camera's own picture, which every box is divided by.
     *  Null until it has been asked for, and null forever if it would not
     *  answer - in which case this camera watches for movement and no more,
     *  because a guessed size puts every box in the wrong place. */
    let picture: { width: number; height: number } | null = null;

    let motionState: MotionState = newMotionState(MOTION_WIDTH, MOTION_HEIGHT);
    const mask = buildMotionMask(assignment.zones, MOTION_WIDTH, MOTION_HEIGHT);

    /**
     * Look properly, for as long as something is there.
     *
     * One ffmpeg for the whole burst rather than one a frame: opening a stream
     * costs a connection and a keyframe, which is most of a second, and paying
     * that five times a second would cost more than the model does.
     */
    async function look(): Promise<void> {
        if (!deps.model || !picture) {
            // Told to look and unable to. Movement was real, so it is reported
            // as movement - which is the rung below and better than silence.
            await deps.report({ cameraId: assignment.cameraId, kind: "motion" });
            return;
        }
        // Bound to consts for the whole burst. Both are read from inside
        // callbacks that outlive the check above, and the model must not change
        // under a burst that is already using its square.
        const model = deps.model;
        const shot = picture;

        const letterbox = letterboxFor(shot.width, shot.height, model.size);
        const frames = openDetectFrames(source, shot.width, shot.height, model.size, DETECT_FPS);
        burst = frames;

        let tracking: TrackingState = NO_TRACKING;
        let seen = 0;
        let idle = 0;
        /** The frame each thing looked best in, kept so its picture can be made
         *  from the exact frame the detector liked rather than from whatever the
         *  camera is showing by the time anybody asks. */
        const held = new Map<string, { frame: Uint8Array; at: number }>();
        const improved = new Map<string, number>();
        let running = false;

        await new Promise<void>((resolve) => {
            const finish = () => {
                frames.stop();
                if (burst === frames) burst = null;
                resolve();
            };
            frames.onClosed(() => resolve());

            frames.onFrame((frame) => {
                // Frames keep arriving while the model is busy with the last
                // one. Dropping them is right: catching up would mean running
                // the model on a backlog of frames describing a moment that has
                // already passed.
                if (running || stopped) return;
                running = true;
                seen += 1;

                void (async () => {
                    try {
                        const output = await model.run(frame);
                        const found = readDetections({
                            output,
                            modelSize: model.size,
                            sourceWidth: shot.width,
                            sourceHeight: shot.height,
                            classes: assignment.classes
                        }).filter((detection) => zonesAllow(assignment.zones, detection.box, detection.houseClass));

                        const update = trackFrame(
                            tracking,
                            found.map((detection) => ({
                                label: detection.houseClass,
                                score: detection.score,
                                box: detection.box
                            })),
                            { now: Date.now(), zones: assignment.zones, fps: DETECT_FPS }
                        );
                        tracking = update.state;

                        for (const object of tracking.objects) {
                            if (object.best?.frame !== object.hits) continue;
                            if (!held.has(object.id) && held.size >= MAX_HELD_FRAMES) continue;
                            held.set(object.id, { frame, at: Date.now() });
                        }

                        for (const object of update.appeared) {
                            const told = await announce(object, "start");
                            if (told) tracking = markReported(tracking, [object.id]);
                        }

                        // A better picture of something already reported is
                        // worth sending: the frame it was first recognized in is
                        // rarely the frame somebody can recognize it in.
                        for (const object of tracking.objects) {
                            if (!object.reported || object.best?.frame !== object.hits) continue;
                            const last = improved.get(object.id) ?? 0;
                            if (Date.now() - last < IMPROVE_GAP_MS) continue;
                            improved.set(object.id, Date.now());
                            await announce(object, "improve");
                        }

                        for (const object of update.ended) {
                            held.delete(object.id);
                            improved.delete(object.id);
                            await deps.report({
                                cameraId: assignment.cameraId,
                                kind: object.label,
                                trackId: object.id,
                                ended: true
                            });
                        }

                        idle = tracking.objects.length === 0 ? idle + 1 : 0;
                        if (seen >= BURST_MAX_FRAMES || idle >= BURST_IDLE_FRAMES) finish();
                    } catch (error) {
                        deps.log(`${assignment.cameraName}: ${String(error)}`);
                        finish();
                    } finally {
                        running = false;
                    }
                })();
            });

            /** Turn one tracked thing into a report, with the best picture of it
             *  there has been. */
            async function announce(object: TrackedObject, reason: "start" | "improve"): Promise<boolean> {
                const kept = held.get(object.id);
                const box = object.best?.box ?? object.box;
                let still: Buffer | null = null;
                if (kept) {
                    // The picture is cropped back to where the camera's frame
                    // actually sits in the model's square, so the black bars
                    // ffmpeg added are not what somebody is shown.
                    still = await encodeJpeg(kept.frame, model.size, {
                        x: 0,
                        y: 0,
                        width: letterbox.width,
                        height: letterbox.height
                    });
                }

                let label: string | null = null;
                let score = Math.round(object.score * 100);
                if (assignment.faces && object.label === "person" && kept) {
                    const who = await recognize(kept.frame, box);
                    if (who) {
                        label = who.name;
                        score = who.score;
                    } else if (reason === "start") {
                        // Somebody, and not one of yours - which is the answer
                        // that matters at three in the morning.
                        label = "Stranger";
                    }
                }

                return deps.report({
                    cameraId: assignment.cameraId,
                    kind: label && label !== "Stranger" ? "face" : object.label,
                    label,
                    score,
                    still,
                    box: [box.x1, box.y1, box.x2, box.y2],
                    zones: [...object.zones.entered],
                    trackId: object.id
                });
            }

            /** Cut one person out of the frame and ask who they are. Cropped
             *  rather than sent whole: the recognizer is being asked about a
             *  face, and sending it the whole garden costs it every other face
             *  in the picture. */
            async function recognize(frame: Uint8Array, box: RelativeBox): Promise<{ name: string; score: number } | null> {
                if (!assignment.faces) return null;
                const scale = letterbox.scale;
                const crop = {
                    x: box.x1 * shot.width * scale,
                    y: box.y1 * shot.height * scale,
                    width: (box.x2 - box.x1) * shot.width * scale,
                    height: (box.y2 - box.y1) * shot.height * scale
                };
                const jpeg = await encodeJpeg(frame, model.size, crop);
                if (!jpeg) return null;
                const form = new FormData();
                form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "face.jpg");
                const response = await fetch(
                    `${assignment.faces.baseUrl}/api/v1/recognition/recognize?limit=1&prediction_count=1`,
                    { method: "POST", headers: { "x-api-key": assignment.faces.apiKey }, body: form }
                ).catch(() => null);
                if (!response?.ok) return null;
                const body = (await response.json().catch(() => null)) as {
                    result?: { subjects?: { subject: string; similarity: number }[] }[];
                } | null;
                const best = body?.result?.[0]?.subjects?.[0];
                if (!best) return null;
                const percent = Math.round(best.similarity * 100);
                return percent >= assignment.faces.threshold ? { name: best.subject, score: percent } : null;
            }
        });

        if (burst === frames) burst = null;
    }

    /** Movement, and what the camera was told to do about it. */
    function onMotion(boxes: readonly RelativeBox[]): void {
        const counted = boxes.filter((box) => movementCounts(assignment.zones, box));
        if (counted.length === 0) {
            movingFrames = 0;
            return;
        }
        movingFrames += 1;
        // Zero settle means "the instant anything moves", which is what a
        // doorway waiting for a courier wants; anything else waits for the
        // movement to still be there.
        if (movingFrames < Math.max(1, Math.ceil(assignment.settleSeconds * MOTION_FPS))) return;

        const now = Date.now();
        if (now - lastFired < assignment.minGapSeconds * 1000) return;
        if (!withinHours(assignment, new Date().getHours())) return;
        lastFired = now;
        movingFrames = 0;

        if (assignment.detector === "motion") {
            const where = union(counted);
            void deps.report({
                cameraId: assignment.cameraId,
                kind: "motion",
                box: where ? [where.x1, where.y1, where.x2, where.y2] : null,
                zones: where ? movementIn(assignment.zones, where) : []
            });
            return;
        }

        busy = true;
        void look()
            .catch((error) => deps.log(`${assignment.cameraName}: ${String(error)}`))
            .finally(() => {
                busy = false;
            });
    }

    function start(): void {
        if (stopped) return;
        const stream = openMotionFrames(source, MOTION_WIDTH, MOTION_HEIGHT, MOTION_FPS);
        motionStream = stream;
        stream.onFrame((frame) => {
            if (busy || stopped) return;
            const result = detectMotion(motionState, frame, {
                width: MOTION_WIDTH,
                height: MOTION_HEIGHT,
                // Sensitivity runs the other way round - 100 is the most
                // sensitive - so a high setting is a small threshold.
                threshold: Math.max(4, Math.round((101 - assignment.sensitivity) / 2)),
                mask
            });
            motionState = result.state;
            onMotion(result.boxes);
        });
        stream.onClosed((code) => deps.log(`${assignment.cameraName}: stream ended (${code ?? "error"})`));
    }

    // The picture's size is asked for once, and watching starts either way: a
    // camera that will not say how big it is still gets watched for movement.
    void probeSize(source).then((size) => {
        if (stopped) return;
        picture = size;
        if (!size && assignment.detector !== "motion") {
            deps.log(`${assignment.cameraName}: could not read the picture's size, so movement only`);
        }
        start();
    });

    return {
        signature: signatureOf(assignment),
        stop() {
            stopped = true;
            motionStream?.stop();
            burst?.stop();
        }
    };
}

/** What this watch was signed up for, so a change in Polaris restarts it. */
export function signatureOf(assignment: Assignment): string {
    return JSON.stringify([
        assignment.streamUrl,
        assignment.authorization,
        assignment.sensitivity,
        assignment.minGapSeconds,
        assignment.settleSeconds,
        assignment.detector,
        assignment.classes,
        assignment.hours,
        assignment.faces?.baseUrl ?? "",
        assignment.zones.map((zone) => [zone.id, zone.kind, zone.enabled, zone.objects, zone.inertia, zone.loiterSeconds, zone.points])
    ]);
}
