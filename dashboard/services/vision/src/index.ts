/**
 * The Polaris vision worker.
 *
 * It is the part of Home that looks at pixels, and it exists so that nothing
 * else has to. The dashboard must never decode video - it is answering requests -
 * and a camera must never be opened twice, so this reads the SMALL stream from
 * the relay, which already holds the one connection to the camera.
 *
 * The economy of it is the ladder, and every rung gates the next:
 *
 *   1. ffmpeg decodes the small stream to tiny grayscale frames, a couple a
 *      second. This is the only thing running while nothing is happening, and it
 *      is a few percent of one core per camera.
 *   2. Frames are compared. Below the camera's sensitivity, nothing happens.
 *   3. Movement, and the camera asked for no more, is reported and that is it.
 *   4. Otherwise one full-size frame is grabbed and sent to the recognizer, which
 *      is the expensive part and runs seconds a day rather than continuously.
 *
 * It holds no state worth keeping and no credentials of its own beyond the key
 * Polaris minted for it. What to watch is asked for on a loop, so a camera added
 * or changed in the dashboard is picked up without restarting anything.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Where Polaris is, and the key it minted for this worker. */
const POLARIS_URL = (process.env.POLARIS_URL ?? "").replace(/\/+$/, "");
const WORKER_KEY = process.env.WORKER_KEY ?? "";

/** How often the assignment list is re-read. */
const REFRESH_MS = Number(process.env.REFRESH_MS) || 30_000;

/** The size frames are compared at. Small on purpose: at 160x90 a frame is 14400
 *  bytes, a comparison is one pass over that, and it is more than enough to see
 *  that a person walked into a garden. */
const WIDTH = 160;
const HEIGHT = 90;
const FRAME_BYTES = WIDTH * HEIGHT;

/** Frames a second. Two is enough to catch somebody walking past and is a
 *  fraction of the work of decoding everything. */
const FPS = 2;

/** How different one pixel has to be to count as changed. Below this is sensor
 *  noise, which at night is most of the picture. */
const PIXEL_THRESHOLD = 24;

interface Assignment {
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
    faces: { baseUrl: string; apiKey: string; threshold: number } | null;
}

interface Watch {
    assignment: Assignment;
    process: ChildProcessWithoutNullStreams;
    /** What was signed up for, so a change restarts the pipe. */
    signature: string;
}

const watches = new Map<string, Watch>();

function log(message: string): void {
    console.log(`[vision] ${message}`);
}

/** Whether the camera's window says it should be looking. Local time, because
 *  the hours were set by somebody living in it. */
function withinHours(assignment: Assignment, hour: number): boolean {
    if (!assignment.hours) return true;
    const { from, to } = assignment.hours;
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Ask Polaris what to watch. */
async function fetchAssignments(): Promise<Assignment[]> {
    const response = await fetch(`${POLARIS_URL}/api/home/vision/assignments`, {
        headers: { authorization: `Bearer ${WORKER_KEY}` }
    });
    if (!response.ok) throw new Error(`assignments: ${response.status}`);
    const body = (await response.json()) as { assignments?: Assignment[] };
    return body.assignments ?? [];
}

/** Tell Polaris what was seen. A report folded into the one before it comes back
 *  as `recorded: false`, which is not a failure - it is the quiet window doing
 *  its job. */
async function report(input: {
    cameraId: string;
    kind: string;
    label?: string | null;
    score?: number | null;
    still?: Buffer | null;
}): Promise<boolean> {
    const response = await fetch(`${POLARIS_URL}/api/home/vision/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
            cameraId: input.cameraId,
            kind: input.kind,
            label: input.label ?? null,
            score: input.score ?? null,
            still: input.still ? input.still.toString("base64") : null
        })
    });
    if (!response.ok) {
        log(`report refused (${response.status})`);
        return false;
    }
    const body = (await response.json()) as { recorded?: boolean };
    return Boolean(body.recorded);
}

/**
 * One full-size frame, for the rungs that need to see detail.
 *
 * A second, short-lived ffmpeg rather than a second stream: it takes a frame and
 * exits, which costs a connection to the relay for under a second and nothing at
 * all the rest of the time. The relay is what holds the camera, so this never
 * touches it.
 */
function grabFrame(assignment: Assignment): Promise<Buffer | null> {
    return new Promise((resolve) => {
        const child = spawn("ffmpeg", [
            "-headers",
            `Authorization: ${assignment.authorization}\r\n`,
            "-i",
            assignment.streamUrl,
            "-frames:v",
            "1",
            "-f",
            "mjpeg",
            "-"
        ], { windowsHide: true });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", () => resolve(null));
        child.on("close", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null));
        // A frame that has not arrived in ten seconds is a camera that is not
        // going to send one.
        setTimeout(() => {
            child.kill("SIGKILL");
            resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
        }, 10_000).unref();
    });
}

/** Ask the recognizer who is in a frame. Returns the best match above the
 *  camera's threshold, or null - and null means "somebody, and not one of yours",
 *  which is the answer that matters at three in the morning. */
async function recognize(assignment: Assignment, frame: Buffer): Promise<{ name: string; score: number } | null> {
    if (!assignment.faces) return null;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), "frame.jpg");
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
    const score = Math.round(best.similarity * 100);
    return score >= assignment.faces.threshold ? { name: best.subject, score } : null;
}

/** Whether the recognizer can see a face at all - which, for a house, is the
 *  practical answer to "is there a person there". */
async function anyFace(assignment: Assignment, frame: Buffer): Promise<boolean> {
    if (!assignment.faces) return false;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), "frame.jpg");
    const response = await fetch(`${assignment.faces.baseUrl}/api/v1/detection/detect?limit=1`, {
        method: "POST",
        headers: { "x-api-key": assignment.faces.apiKey },
        body: form
    }).catch(() => null);
    if (!response?.ok) return false;
    const body = (await response.json().catch(() => null)) as { result?: unknown[] } | null;
    return Array.isArray(body?.result) && body.result.length > 0;
}

/**
 * What to do about movement, which is the only thing this worker detects by
 * itself.
 *
 * Everything past reporting it costs money, so each step is only taken when the
 * step before it said something. The order is deliberate: the cheapest question
 * that can end the chain is asked first.
 */
async function escalate(assignment: Assignment): Promise<void> {
    if (assignment.detector === "motion") {
        await report({ cameraId: assignment.cameraId, kind: "motion" });
        return;
    }

    const frame = await grabFrame(assignment);
    if (!frame) {
        // Movement was real even if the frame was not; a report with no picture
        // beats silence.
        await report({ cameraId: assignment.cameraId, kind: "motion" });
        return;
    }

    if (assignment.detector === "faces") {
        const who = await recognize(assignment, frame);
        if (who) {
            await report({ cameraId: assignment.cameraId, kind: "face", label: who.name, score: who.score, still: frame });
            return;
        }
    }

    // Either the camera only asked about objects, or it asked who and nobody
    // matched. Both end the same way: somebody was there.
    if (await anyFace(assignment, frame)) {
        await report({
            cameraId: assignment.cameraId,
            kind: "person",
            label: assignment.detector === "faces" ? "Stranger" : null,
            still: frame
        });
        return;
    }
    await report({ cameraId: assignment.cameraId, kind: "motion", still: frame });
}

/**
 * Watch one camera until the pipe dies or the assignment changes.
 *
 * ffmpeg writes raw grayscale frames on stdout, back to back with no framing, so
 * the bytes are gathered into frame-sized pieces and each is compared with the
 * one before. That is the whole motion detector: no library, no model, and it
 * runs on anything.
 */
function watch(assignment: Assignment): Watch {
    const child = spawn("ffmpeg", [
        "-headers",
        `Authorization: ${assignment.authorization}\r\n`,
        "-i",
        assignment.streamUrl,
        "-an",
        "-vf",
        `fps=${FPS},scale=${WIDTH}:${HEIGHT},format=gray`,
        "-f",
        "rawvideo",
        "-"
    ], { windowsHide: true });

    let pending = Buffer.alloc(0);
    let previous: Buffer | null = null;
    let lastFired = 0;
    let busy = false;
    /**
     * How many frames in a row have been moving.
     *
     * One frame over the threshold is a moth crossing the lens, a gust in a
     * hedge, or the wall shaking as a lorry goes past - all of them over before
     * the next frame. Something that is still moving a second later is something
     * that happened. This is the same idea as the settle window the camera's own
     * alerts get, measured in frames because that is what this rung has.
     */
    let movingFrames = 0;

    child.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        while (pending.length >= FRAME_BYTES) {
            const frame = pending.subarray(0, FRAME_BYTES);
            pending = pending.subarray(FRAME_BYTES);
            const last = previous;
            // Copied, because the buffer above is a view onto bytes that are
            // about to be reused.
            previous = Buffer.from(frame);
            if (!last || busy) continue;

            // The share of the picture that changed, as a percentage. Sensitivity
            // is the other way round - 100 is the most sensitive - so a high
            // setting means a small change is enough.
            let changed = 0;
            for (let index = 0; index < FRAME_BYTES; index += 1) {
                if (Math.abs((frame[index] ?? 0) - (last[index] ?? 0)) > PIXEL_THRESHOLD) changed += 1;
            }
            const percent = (changed / FRAME_BYTES) * 100;
            const needed = Math.max(0.2, (101 - assignment.sensitivity) / 10);
            if (percent < needed) {
                movingFrames = 0;
                continue;
            }
            movingFrames += 1;
            // Zero settle means "the instant anything moves", which is what a
            // doorway waiting for a courier wants; anything else waits for the
            // movement to still be there.
            if (movingFrames < Math.max(1, Math.ceil(assignment.settleSeconds * FPS))) continue;

            const now = Date.now();
            if (now - lastFired < assignment.minGapSeconds * 1000) continue;
            if (!withinHours(assignment, new Date().getHours())) continue;
            lastFired = now;
            movingFrames = 0;

            busy = true;
            void escalate(assignment)
                .catch((error) => log(`${assignment.cameraName}: ${String(error)}`))
                .finally(() => {
                    busy = false;
                });
        }
    });

    // ffmpeg is chatty on stderr even when it is fine; only a death is worth a
    // line, and the reconciler brings it back.
    child.stderr.resume();
    child.on("close", (code) => log(`${assignment.cameraName}: stream ended (${code})`));
    child.on("error", (error) => log(`${assignment.cameraName}: ${error.message}`));

    return { assignment, process: child, signature: signatureOf(assignment) };
}

function signatureOf(assignment: Assignment): string {
    return [
        assignment.streamUrl,
        assignment.authorization,
        assignment.sensitivity,
        assignment.minGapSeconds,
        assignment.detector,
        assignment.faces?.baseUrl ?? "",
        assignment.hours ? `${assignment.hours.from}-${assignment.hours.to}` : ""
    ].join("|");
}

/** Bring the running pipes in line with what Polaris says they should be. */
async function reconcile(): Promise<void> {
    let assignments: Assignment[];
    try {
        assignments = await fetchAssignments();
    } catch (error) {
        log(`could not read assignments: ${String(error)}`);
        return;
    }
    const wanted = new Map(assignments.map((assignment) => [assignment.cameraId, assignment]));

    for (const [id, current] of watches) {
        const assignment = wanted.get(id);
        if (!assignment || current.signature !== signatureOf(assignment) || current.process.exitCode !== null) {
            current.process.kill("SIGKILL");
            watches.delete(id);
        }
    }

    for (const [id, assignment] of wanted) {
        if (watches.has(id)) continue;
        log(`watching ${assignment.cameraName} (${assignment.detector})`);
        watches.set(id, watch(assignment));
    }
}

async function main(): Promise<void> {
    if (!POLARIS_URL || !WORKER_KEY) {
        console.error("[vision] POLARIS_URL and WORKER_KEY are required");
        process.exit(1);
    }
    log(`starting against ${POLARIS_URL}`);
    await reconcile();
    setInterval(() => void reconcile(), REFRESH_MS);

    const shutdown = () => {
        for (const watch of watches.values()) watch.process.kill("SIGTERM");
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

void main();
