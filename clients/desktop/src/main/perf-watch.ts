/**
 * What fills `perf.log` (`perf-log.ts`): the main process's own delay, the
 * processes Chromium runs going away or hanging, the page's slow inputs, the
 * errors a page logs and a preload that failed, and whether a game was in
 * front, so a slow click or a page that went blank can be read against them.
 * Started once the app is ready.
 */

import { app } from "electron";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { checkLoop, LOOP_CHECK_MS, PerfLog, writePageReport, writeRendererError, type PerfValue } from "./perf-log";

let log: PerfLog | null = null;

/** Adds a line when the log is running; before it is, nothing. */
export function perfEvent(event: string, fields: Readonly<Record<string, PerfValue>> = {}): void {
    void log?.write(event, fields);
}

/** The page's report (`preload/perf-watch.ts`), checked and written. */
export function recordPageReport(raw: unknown): void {
    if (log) writePageReport(log, raw);
}

/** Starts the log; `accelerated` is whether this run uses the graphics card. */
export function startPerfWatch(accelerated: boolean): void {
    if (log) return;
    const current = new PerfLog(join(app.getPath("userData"), "logs", "perf.log"));
    log = current;
    const gpu = ((): Record<string, PerfValue> => {
        try {
            const status = app.getGPUFeatureStatus();
            return { compositing: status.gpu_compositing, raster: status.rasterization };
        } catch {
            return {};
        }
    })();
    void current.write("start", { version: app.getVersion(), accelerated, ...gpu });

    // Resolution in milliseconds; the histogram is read and reset every look.
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const active = () => (typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : []);
    setInterval(() => checkLoop(histogram, current, active), LOOP_CHECK_MS).unref();

    app.on("child-process-gone", (_event, details) => {
        void current.write("child-gone", { type: details.type, reason: details.reason, code: details.exitCode, ...(details.name ? { name: details.name } : {}) });
    });
    app.on("render-process-gone", (_event, contents, details) => {
        void current.write("render-gone", { type: contents.getType(), reason: details.reason, code: details.exitCode });
    });
    app.on("web-contents-created", (_event, contents) => {
        let since = 0;
        contents.on("unresponsive", () => {
            since = Date.now();
            void current.write("unresponsive", { type: contents.getType() });
        });
        // Windows only: the search, notices and Polaris pages. A page that
        // breaks says why in its console, and nothing else keeps that.
        if (contents.getType() === "window") {
            contents.on("console-message", (details) => void writeRendererError(current, details, contents.getType()));
        }
        contents.on("preload-error", (_event, preloadPath, error) => {
            void current.write("preload-error", { preload: preloadPath.slice(Math.max(preloadPath.lastIndexOf("/"), preloadPath.lastIndexOf("\\")) + 1), name: error?.name ?? "Error" });
        });
        contents.on("responsive", () => {
            if (!since) return;
            void current.write("responsive", { type: contents.getType(), ms: Date.now() - since });
            since = 0;
        });
    });
}
