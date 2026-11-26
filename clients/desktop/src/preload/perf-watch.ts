/**
 * The page's own measure of a slow click, reported to the main process, which
 * checks it again and writes it to `perf.log` (`main/perf-log.ts`).
 *
 * Two kinds, both from the page's performance timeline (observed in the page's
 * own world, `observerSource`), so nothing here runs on a timer or on every event: a long task (the page's thread held for
 * `threshold` or more), and an input whose answer took that long to show. An
 * input says where its time went - waiting for the thread (`delay`), in the
 * handlers (`processing`), and the rest waiting for the frame to be drawn -
 * which is what tells a busy page from a starved graphics card. Only the
 * event's name (`click`) and numbers leave: never a target, text or address.
 * Kept free of zod so the preload stays light.
 */

/** What is reported; `main/perf-log.ts` holds the schema it is checked by. */
export interface PageReport {
    readonly kind: "longtask" | "event";
    readonly duration: number;
    readonly name?: string;
    readonly delay?: number;
    readonly processing?: number;
}

/** The fields of a `PerformanceEventTiming` read here. */
interface EventEntry {
    readonly name: string;
    readonly duration: number;
    readonly startTime: number;
    readonly processingStart?: number;
    readonly processingEnd?: number;
}

/** An event entry as its report, or null when it was quick. */
export function eventReport(entry: EventEntry, threshold: number): PageReport | null {
    if (!(entry.duration >= threshold)) return null;
    const name = /^[a-z]{1,32}$/.test(entry.name) ? entry.name : undefined;
    const timed = entry.processingStart !== undefined && entry.processingEnd !== undefined && entry.processingStart > 0;
    return {
        kind: "event",
        duration: entry.duration,
        ...(name ? { name } : {}),
        ...(timed ? { delay: Math.max(0, entry.processingStart! - entry.startTime), processing: Math.max(0, entry.processingEnd! - entry.processingStart!) } : {})
    };
}

/** The page's global the observer reports through; it takes only what `pageEntry` reads. */
export const PERFORMANCE_GLOBAL = "polarisPerformance";

/**
 * The observer, run in the page's own world. A preload's world is not the
 * page's, and whether a performance observer made in an isolated world is
 * handed the page's long tasks and input timings is not something Chromium or
 * Electron documents, so it is made where they certainly arrive and hands each
 * entry, as plain numbers, to the preload's `PERFORMANCE_GLOBAL`. A string, not
 * a function's source, so a bundler cannot rename what it refers to.
 */
export function observerSource(threshold: number): string {
    return `(function () {
    var api = window[${JSON.stringify(PERFORMANCE_GLOBAL)}];
    if (!api || typeof PerformanceObserver === "undefined") return;
    var supported = PerformanceObserver.supportedEntryTypes || [];
    function watch(type, options) {
        if (supported.indexOf(type) === -1) return;
        try {
            new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    try {
                        api.report({ type: type, name: String(entry.name), duration: entry.duration, startTime: entry.startTime, processingStart: entry.processingStart, processingEnd: entry.processingEnd });
                    } catch (error) {}
                });
            }).observe(options);
        } catch (error) {}
    }
    watch("longtask", { type: "longtask" });
    watch("event", { type: "event", durationThreshold: ${Math.max(16, Math.round(threshold))} });
})();`;
}

/** One entry the page's world handed over, as its report, or null when it is quick or malformed. */
export function pageEntry(raw: unknown, threshold: number): PageReport | null {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const duration = number(entry.duration);
    const startTime = number(entry.startTime);
    if (duration === undefined || startTime === undefined) return null;
    if (entry.type === "longtask") return duration >= threshold ? { kind: "longtask", duration } : null;
    if (entry.type !== "event") return null;
    return eventReport(
        {
            name: typeof entry.name === "string" ? entry.name : "",
            duration,
            startTime,
            processingStart: number(entry.processingStart),
            processingEnd: number(entry.processingEnd)
        },
        threshold
    );
}

/** What watching needs of Electron, passed in so the tests need none. */
export interface MainWorld {
    expose(name: string, api: { report(raw: unknown): void; }): void;
    run(source: string): Promise<unknown>;
}

/** Starts watching; where the page has no timeline (an old engine) the observer does nothing. */
export function watchPagePerformance(report: (report: PageReport) => void, world: MainWorld, threshold: number = 500): void {
    try {
        world.expose(PERFORMANCE_GLOBAL, {
            report: (raw: unknown) => {
                const found = pageEntry(raw, threshold);
                if (found) report(found);
            }
        });
        // Measuring must never break the page.
        void world.run(observerSource(threshold)).catch(() => undefined);
    } catch {
        // Nothing to watch.
    }
}
