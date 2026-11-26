/**
 * The page's own measure of a slow click, reported to the main process, which
 * checks it again and writes it to `perf.log` (`main/perf-log.ts`).
 *
 * Two kinds, both from the browser's performance timeline, so nothing here
 * runs on a timer or on every event: a long task (the page's thread held for
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

/** Starts watching; does nothing where the timeline is not there (a test, an old engine). */
export function watchPagePerformance(report: (report: PageReport) => void, threshold: number = 500): void {
    if (typeof PerformanceObserver === "undefined") return;
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const safely = (send: () => void) => {
        try {
            send();
        } catch {
            // Measuring must never break the page.
        }
    };
    if (supported.includes("longtask")) {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration >= threshold) safely(() => report({ kind: "longtask", duration: entry.duration }));
            }
        }).observe({ type: "longtask" });
    }
    if (supported.includes("event")) {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const found = eventReport(entry as unknown as EventEntry, threshold);
                if (found) safely(() => report(found));
            }
        }).observe({ type: "event", durationThreshold: threshold } as PerformanceObserverInit);
    }
}
