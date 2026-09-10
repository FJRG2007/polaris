/**
 * Telling open charts that the collector wrote new samples.
 *
 * A chart used to poll its window on a timer paced against the collector, so a
 * new point appeared anywhere up to a whole poll after it existed, and a screen
 * with six charts open asked six times a minute whether anything had changed.
 * The collector already knows the moment it writes, and which subjects it wrote
 * for, so it says so here and a chart re-reads exactly then.
 *
 * In-process, like the task bus (`lib/tasks/live.ts`) and for the same reasons:
 * the collector runs in the same server as the routes that stream to browsers.
 * What travels is which subjects have new samples, never the samples - the
 * chart re-reads through the history route and its access checks.
 */

import type { MetricSubjectType } from "./metrics-shared";

/** One tick's worth of new samples. */
export interface MetricTick {
    /** "app:<id>", "host:<id>", "volume:<id>", "storage:<id>". */
    readonly subjects: ReadonlySet<string>;
    readonly at: number;
}

type Listener = (tick: MetricTick) => void;

/** Held on globalThis: the collector is started from instrumentation, which is
 *  bundled apart from the routes, and a module-scoped Set would be two Sets. */
const REGISTRY = Symbol.for("polaris.metrics.live");

interface Registry {
    listeners: Set<Listener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { listeners: new Set() };
    return holder[REGISTRY];
}

export function subjectKey(type: MetricSubjectType, id: string): string {
    return `${type}:${id}`;
}

/** Announce new samples. Never throws: a listener that fails is one dead browser
 *  connection, and it must not cost the collector its tick. */
export function publishMetricTick(
    rows: readonly { subjectType: string; subjectId: string }[],
    at = Date.now()
): void {
    const { listeners } = registry();
    if (listeners.size === 0 || rows.length === 0) return;
    const tick: MetricTick = {
        subjects: new Set(rows.map((row) => `${row.subjectType}:${row.subjectId}`)),
        at
    };
    for (const listener of listeners) {
        try {
            listener(tick);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeMetricTicks(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * A server-sent stream that says `tick` whenever any of `subjects` has new
 * samples, with a heartbeat so a proxy does not close it while nothing is
 * happening. Shared by every chart's stream route; each one only works out
 * which subjects it may watch.
 */
export function metricTickStream(request: Request, subjects: readonly string[]): Response {
    const watched = new Set(subjects);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    function stop(): void {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (beat) clearInterval(beat);
        beat = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (chunk: string): void => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    stop();
                }
            };
            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });
            // Said once on open, so the chart knows it can stop polling.
            send("event: ready\ndata: {}\n\n");
            unsubscribe = subscribeMetricTicks((tick) => {
                for (const subject of watched) {
                    if (tick.subjects.has(subject)) {
                        send(`event: tick\ndata: ${JSON.stringify({ at: tick.at })}\n\n`);
                        return;
                    }
                }
            });
            beat = setInterval(() => send(":\n\n"), 15_000);
        },
        cancel() {
            stop();
        }
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no"
        }
    });
}
