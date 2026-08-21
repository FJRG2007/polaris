/**
 * The Polaris vision worker.
 *
 * It is the part of Places that looks at pixels, and it exists so that nothing
 * else has to. The dashboard must never decode video - it is answering requests -
 * and a camera must never be opened twice, so everything here reads the relay,
 * which already holds the one connection to each camera.
 *
 * This process is only the orchestration: what to watch is asked for on a loop,
 * so a camera added or an area drawn in the dashboard is picked up without
 * restarting anything, and the model is loaded once and shared by every camera
 * on this machine. The work itself is one pipeline per camera, in `watch.ts`.
 *
 * It holds no state worth keeping and no credentials of its own beyond the key
 * Polaris minted for it.
 */

import type { LiveBox } from "@polaris/core";
import { loadModel, type LoadedModel } from "./model.js";
import { signatureOf, watchCamera, type Assignment, type Report, type Watch } from "./watch.js";

/** Where Polaris is, and the key it minted for this worker. */
const POLARIS_URL = (process.env.POLARIS_URL ?? "").replace(/\/+$/, "");
const WORKER_KEY = process.env.WORKER_KEY ?? "";

/** How often the assignment list is re-read. */
const REFRESH_MS = Number(process.env.REFRESH_MS) || 30_000;

/** The detection model, baked into the image. Overridable so a machine with a
 *  better one can be pointed at it, and absent is not fatal: a worker with no
 *  model watches for movement, which is the rung below. */
const MODEL_PATH = process.env.DETECT_MODEL ?? "/app/model/detector.onnx";

const watches = new Map<string, Watch>();

function log(message: string): void {
    console.log(`[vision] ${message}`);
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

/**
 * Tell Polaris what was seen.
 *
 * A report folded into the one before it comes back as `recorded: false`, which
 * is not a failure - it is the quiet window doing its job, and the caller uses
 * it to decide whether the expensive next step is worth taking.
 */
async function report(input: Report): Promise<boolean> {
    const response = await fetch(`${POLARIS_URL}/api/home/vision/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
            cameraId: input.cameraId,
            kind: input.kind,
            label: input.label ?? null,
            score: input.score ?? null,
            still: input.still ? input.still.toString("base64") : null,
            box: input.box ?? null,
            zones: input.zones ?? [],
            trackId: input.trackId ?? null,
            ended: input.ended ?? false
        })
    }).catch(() => null);
    if (!response?.ok) {
        log(`report refused (${response?.status ?? "no answer"})`);
        return false;
    }
    const body = (await response.json().catch(() => null)) as { recorded?: boolean } | null;
    return Boolean(body?.recorded);
}

/**
 * Say where everything a camera is following is, right now.
 *
 * Nothing is awaited and a failure is swallowed on purpose. This is what a
 * screen draws over the live picture, so it is only ever worth what the next
 * frame is about to replace: retrying one would put a rectangle on screen a
 * second after the person it was drawn around had walked out of it, and holding
 * up the pipeline for it would cost the frame that IS current.
 *
 * The one thing that is not swallowed is a run of them, because a worker that
 * has silently stopped being able to reach Polaris is worth a line in the log -
 * once, not five times a second.
 */
let liveFailures = 0;
function sendLive(cameraId: string, boxes: readonly LiveBox[]): void {
    void fetch(`${POLARIS_URL}/api/home/vision/live`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ cameraId, boxes })
    })
        .then((response) => {
            if (response.ok) {
                liveFailures = 0;
                return;
            }
            if (++liveFailures === 50) log(`live positions refused (${response.status})`);
        })
        .catch(() => {
            if (++liveFailures === 50) log("live positions are not reaching Polaris");
        });
}

/** Bring the running pipelines in line with what Polaris says they should be. */
async function reconcile(model: LoadedModel | null): Promise<void> {
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
        if (!assignment || current.signature !== signatureOf(assignment)) {
            current.stop();
            watches.delete(id);
        }
    }

    for (const [id, assignment] of wanted) {
        if (watches.has(id)) continue;
        const areas = assignment.zones?.length ?? 0;
        log(
            `watching ${assignment.cameraName} (${assignment.detector}${areas > 0 ? `, ${areas} areas` : ""})`
        );
        watches.set(
            id,
            watchCamera(
                { ...assignment, zones: assignment.zones ?? [] },
                { report, live: sendLive, model, log }
            )
        );
    }
}

async function main(): Promise<void> {
    if (!POLARIS_URL || !WORKER_KEY) {
        console.error("[vision] POLARIS_URL and WORKER_KEY are required");
        process.exit(1);
    }
    log(`starting against ${POLARIS_URL}`);

    // Loaded once, before anything is watched. A worker whose model is missing
    // or is not the one this code was written for still runs: every camera on
    // it drops to reporting movement, which is worse than it was promised and
    // far better than reporting boxes in the wrong place.
    const model = await loadModel(MODEL_PATH);
    if (!model) log("no usable model, so every camera here watches for movement only");

    await reconcile(model);
    setInterval(() => void reconcile(model), REFRESH_MS);

    const shutdown = () => {
        for (const watch of watches.values()) watch.stop();
        void model?.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

void main();
