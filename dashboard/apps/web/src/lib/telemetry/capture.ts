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

import * as os from "node:os";
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
            context: null,
            // Nothing to read: a Node stack carries a file and a line and not
            // the line itself. What would fill these is a source map, which is
            // the difference between a frame that says `48572.js:1` and one
            // that names a file somebody wrote.
            pre: [],
            post: []
        });
    }
    // A stack is written innermost-first and every client sends it the other way
    // round, so this reverses it rather than teaching the reader two orders.
    return frames.reverse().slice(-40);
}

/**
 * Where this is running, in the shape every other reporter sends it.
 *
 * Read fresh each time rather than once at startup: memory is the field that
 * moves, and a crash that happened with 200 MB free is a different crash from
 * the same line with 4 GB free. Everything else is constant and costs nothing
 * to read again.
 *
 * Deliberately the same group names Sentry's own clients use - `runtime`, `os`,
 * `device`, `app` - so Polaris' own events sit in the same screen, under the
 * same headings, as the events from an application that reports here. A project
 * that displayed its own reports differently from everybody else's would be a
 * second thing to learn to read.
 */
function hereContexts(): core.ContextGroup[] {
    const memory = process.memoryUsage?.().rss;
    return [
        {
            name: "runtime",
            fields: [
                { key: "name", value: "node" },
                { key: "version", value: process.version }
            ]
        },
        {
            name: "os",
            fields: [
                { key: "name", value: os.type() },
                { key: "version", value: os.release() },
                { key: "arch", value: os.arch() }
            ]
        },
        {
            name: "device",
            fields: [
                { key: "processor_count", value: String(os.cpus()?.length ?? 0) },
                { key: "memory_size", value: String(os.totalmem()) },
                { key: "free_memory", value: String(os.freemem()) },
                { key: "boot_time", value: new Date(Date.now() - os.uptime() * 1000).toISOString() }
            ]
        },
        {
            name: "app",
            fields: [
                { key: "app_memory", value: memory === undefined ? "" : String(memory) },
                {
                    key: "app_start_time",
                    value: new Date(Date.now() - process.uptime() * 1000).toISOString()
                },
                { key: "build", value: buildStamp() ?? "" }
            ].filter((field) => field.value !== "")
        }
    ];
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
            // The container this ran in. Left null, every one of Polaris' own
            // events looked like it came from the same nowhere, which on a
            // deployment with more than one of anything is the first question.
            environment: process.env.NODE_ENV === "production" ? "production" : "development",
            serverName: os.hostname() || null,
            transaction: where.transaction ?? null,
            url: null,
            method: null,
            user: null,
            tags: { ...where.tags, source: "polaris" },
            frames,
            breadcrumbs: [],
            // The same facts Polaris asks every other reporter for. Without
            // them its own events were the thinnest thing on the screen - a
            // sentence, one minified frame, and no way to tell which machine,
            // which build or which runtime - on the one project where nobody
            // can go and add an SDK to find out.
            contexts: hereContexts(),
            request: null,
            sdk: { name: "polaris", version: buildStamp() ?? "" },
            ip: null,
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

/** Set while an error is being written down, so a failure inside the writing
 *  cannot report itself and start again. */
let reporting = false;

/**
 * The failure Polaris HANDLED, which is nearly all of them.
 *
 * The two hooks above catch a process falling over, and a process that falls
 * over is the rare case. What actually happens is caught, logged with
 * `console.error`, and carried on from - the noise model that would not load,
 * the route that could not be published, the storage that was away, the
 * notification rules that could not be resolved. Every one of those is Polaris
 * telling somebody what went wrong, into a container log the person running it
 * is never going to open. The Telemetry screen said "and what Polaris reports
 * about itself" and showed none of it.
 *
 * So the error console is the seam. One place, rather than a call added to two
 * hundred catch blocks that the two hundred and first would then be missing -
 * and it catches the ones written before this existed, which is the whole point.
 *
 * An `Error` among the arguments is used as the error, because it carries the
 * stack that makes the grouping worth anything; otherwise the line itself is the
 * message. The prefix Polaris writes - "polaris:", "avatars:", "mcp:" - becomes
 * the transaction, so the list reads as a list of places rather than a wall of
 * identical titles.
 *
 * The original console call always happens first and always happens: this adds a
 * reader, it does not replace the one that exists.
 */
export function watchLoggedFailures(): void {
    const original = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
        original(...args);
        // A failure inside the capture reaches this again, and a report that
        // reports itself is how one bad minute becomes a full disk.
        if (reporting) return;
        reporting = true;
        try {
            const error = args.find((arg): arg is Error => arg instanceof Error);
            const said = args
                .filter((arg) => !(arg instanceof Error))
                .map((arg) => (typeof arg === "string" ? arg : safeText(arg)))
                .join(" ")
                .trim();
            // Nothing said and nothing thrown is a console call with no content
            // to group on, and an issue with no title helps nobody.
            if (!error && !said) return;
            void captureInternal(error ?? said, {
                transaction: placeOf(said),
                tags: { via: "console" }
            });
        } finally {
            reporting = false;
        }
    };
}

/** Where a logged line came from, from the prefix Polaris writes in front of
 *  them. "console.error" for a line that carries none, which is honest about
 *  knowing nothing rather than inventing a place. */
function placeOf(said: string): string {
    const prefix = /^([a-z][a-z0-9 -]{0,30}):/i.exec(said);
    return prefix?.[1]?.trim() || "console.error";
}

/** Whatever this is, as one line, without throwing on something circular - which
 *  is a real thing to be handed by a logger. */
function safeText(value: unknown): string {
    try {
        return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    } catch {
        return String(value);
    }
}
