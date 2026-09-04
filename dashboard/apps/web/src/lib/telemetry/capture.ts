/**
 * Polaris reporting its own crashes.
 *
 * The dashboard is the one application on the box that nobody else is watching:
 * a deployed service has an operator who notices it stopped, and Polaris has the
 * operator. So it reports into a project of its own, made on first need, and it
 * does it in process rather than over HTTP - posting to itself would mean a
 * request that fails exactly when the thing being reported is that requests are
 * failing.
 *
 * An exception is turned into the same `CapturedEvent` an SDK would have sent,
 * through the same reader, so a crash in the dashboard groups by the same rule
 * and reads on the same screen as a crash in a deployed application. There is no
 * second shape and no second code path.
 *
 * Nothing here throws. It runs inside exception handlers, where throwing would
 * replace the crash being reported with a crash in the reporting.
 */

import * as core from "@polaris/core";
import { captureEvent } from "./store";
import { buildStamp } from "@/lib/build-stamp";
import { systemProject } from "./project-service";

/** How many of the same fault to accept in a row before going quiet for a
 *  while. A dashboard in a crash loop must not spend its remaining capacity
 *  writing down that it is in a crash loop. */
const BURST = 20;
const BURST_WINDOW_MS = 60_000;

let seen = 0;
let windowOpenedAt = 0;

function withinBurst(now: number): boolean {
    if (now - windowOpenedAt > BURST_WINDOW_MS) {
        windowOpenedAt = now;
        seen = 0;
    }
    seen += 1;
    return seen <= BURST;
}

/**
 * A stack, as the reader expects one: innermost last, and the application's own
 * frames marked.
 *
 * "Its own" is decided by the path, because that is all a Node stack carries: a
 * frame inside node_modules or inside Node itself is somebody else's, and every
 * other frame is this build. Getting this wrong costs nothing but a worse
 * culprit line, and getting it right is what makes the grouping stable.
 */
function framesOf(error: Error): core.StackFrame[] {
    const lines = (error.stack ?? "").split("\n").slice(1);
    const frames: core.StackFrame[] = [];
    for (const line of lines) {
        const match = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
        if (!match) continue;
        const file = match[2] ?? "";
        frames.push({
            file,
            function: match[1] ?? "<anonymous>",
            line: Number.parseInt(match[3] ?? "0", 10) || null,
            column: Number.parseInt(match[4] ?? "0", 10) || null,
            inApp: !/node_modules|^node:|^internal[\\/]/.test(file),
            context: null
        });
    }
    // A stack is written innermost-first and every client sends it the other way
    // round, so this reverses it rather than teaching the reader two orders.
    return frames.reverse().slice(-40);
}

/**
 * Record something that went wrong inside Polaris.
 *
 * `where` is what the event is tagged with - the request path, the job name, the
 * handler that caught it - and is what makes a list of the dashboard's own
 * failures readable rather than a wall of identical titles.
 */
export async function captureInternal(
    caught: unknown,
    where: { transaction?: string | null; level?: core.TelemetryLevel; tags?: Record<string, string> } = {}
): Promise<void> {
    try {
        if (!withinBurst(Date.now())) return;

        const project = await systemProject();
        // Before the first account exists there is nothing to own the project
        // and nobody to read it. The next failure after that opens it.
        if (!project) return;

        const error =
            caught instanceof Error
                ? caught
                : new Error(typeof caught === "string" ? caught : JSON.stringify(caught ?? "unknown"));

        const frames = framesOf(error);
        const read: Parameters<typeof core.fingerprintOf>[0] = {
            type: error.name || "Error",
            value: error.message || "Unknown error",
            culprit: where.transaction ?? "",
            frames
        };

        await captureEvent(project, {
            eventId: null,
            level: where.level ?? "error",
            type: read.type,
            value: read.value,
            culprit:
                frames.find((frame) => frame.inApp)?.function ??
                where.transaction ??
                "",
            platform: "node",
            release: buildStamp(),
            environment: process.env.NODE_ENV === "production" ? "production" : "development",
            serverName: null,
            transaction: where.transaction ?? null,
            url: null,
            method: null,
            user: null,
            tags: { ...where.tags, source: "polaris" },
            frames,
            breadcrumbs: [],
            at: new Date(),
            fingerprint: core.fingerprintOf(read)
        });
    } catch {
        // The thing being reported already happened. Failing to write it down is
        // not worth a second failure on top.
    }
}

/**
 * Catch what the process itself reports, which is where the failures nobody
 * else sees turn up.
 *
 * Installed beside the handlers that keep the server alive rather than instead
 * of them: the console line is what somebody reading container logs looks for,
 * and this is what somebody who was not watching finds afterwards.
 */
export function watchProcessFailures(): void {
    process.on("uncaughtException", (error) => {
        void captureInternal(error, { level: "fatal", transaction: "uncaughtException" });
    });
    process.on("unhandledRejection", (reason) => {
        void captureInternal(reason, { level: "error", transaction: "unhandledRejection" });
    });
}
