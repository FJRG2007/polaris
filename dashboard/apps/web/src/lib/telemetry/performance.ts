/**
 * How long things take, read out of what a Sentry client sends.
 *
 * Pure on purpose: the ingest, the job that works out the percentiles, the
 * screen and the tests all decide these things the same way, and none of them
 * needs a database to do it.
 *
 * The model is Sentry's own (develop.sentry.dev/sdk/data-model/event-payloads/transaction):
 * a `transaction` envelope item is one page load, navigation or served request,
 * with its start and end in seconds, its kind in `contexts.trace.op`, the spans
 * inside it, and - from a browser - the Web Vitals in `measurements`. The browser
 * SDK sends INP on its own, as a standalone `span` item naming the route it
 * happened on. Nothing here keeps a transaction: each one becomes a value in a
 * histogram, and the percentiles are read back from the histograms.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/**
 * Fixed logarithmic buckets: bucket `i` holds values in [GROWTH^i, GROWTH^(i+1))
 * milliseconds, the first also holding everything below 1. 64 of them at 1.25
 * reach about twenty minutes, and a percentile read back from one is within
 * about 12% of the true value - the same trade DDSketch makes, and what lets two
 * histograms be added element by element.
 */
export const HISTOGRAM = { size: 64, growth: 1.25 } as const;

/** The bucket a value falls into. */
export function bucketOf(value: number): number {
    if (!Number.isFinite(value) || value < 1) return 0;
    const index = Math.floor(Math.log(value) / Math.log(HISTOGRAM.growth));
    return Math.min(HISTOGRAM.size - 1, Math.max(0, index));
}

/** A histogram holding one value. */
export function histogramOf(value: number): number[] {
    const hist = new Array<number>(HISTOGRAM.size).fill(0);
    hist[bucketOf(value)] = 1;
    return hist;
}

/** Two histograms added together. A missing or short one counts as zeros. */
export function mergeHistograms(a: readonly number[], b: readonly number[]): number[] {
    return Array.from({ length: HISTOGRAM.size }, (_, index) => (a[index] ?? 0) + (b[index] ?? 0));
}

/**
 * The value at quantile `q` (0..1) of a histogram, or null for an empty one.
 * The geometric middle of the bucket the rank lands in, which keeps the error
 * symmetric in proportion rather than always under or over.
 */
export function percentile(hist: readonly number[], q: number): number | null {
    const total = hist.reduce((sum, count) => sum + count, 0);
    if (total === 0) return null;
    const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, q)) * total));
    let seen = 0;
    for (let index = 0; index < hist.length; index++) {
        seen += hist[index] ?? 0;
        if (seen >= rank) return index === 0 ? 1 : HISTOGRAM.growth ** (index + 0.5);
    }
    return HISTOGRAM.growth ** (hist.length - 0.5);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** The measurements kept per route. CLS is unitless and kept in thousandths. */
export const PERF_METRICS = ["duration", "lcp", "fcp", "ttfb", "inp", "cls"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];

/**
 * Web Vitals' "good" thresholds (web.dev/articles/vitals), in milliseconds and,
 * for CLS, thousandths. What a route is held to when nobody said otherwise.
 */
export const VITAL_TARGETS: Readonly<Record<Exclude<PerfMetric, "duration">, number>> = {
    lcp: 2500,
    fcp: 1800,
    ttfb: 800,
    inp: 200,
    cls: 100
};

/** The measurement a route is judged by: a page load by its LCP when it
 *  reports one, anything else by how long it took. */
export function primaryMetric(op: string, hasLcp: boolean): PerfMetric {
    return op === "pageload" && hasLcp ? "lcp" : "duration";
}

/**
 * The target a route is held to when neither it nor its project names one. A
 * page is held to LCP's 2.5 s; a request, served or made, to TTFB's 800 ms,
 * because a server response is the first byte of every page that waits on it.
 */
export function defaultTarget(op: string, metric: PerfMetric): number {
    if (metric !== "duration") return VITAL_TARGETS[metric];
    if (op.startsWith("http") || op.startsWith("db") || op === "function") return VITAL_TARGETS.ttfb;
    return VITAL_TARGETS.lcp;
}

/** The target in force: the route's, else the project's, else the default. */
export function effectiveTarget(input: {
    op: string;
    metric: PerfMetric;
    routeTarget: number | null;
    projectTarget: number | null;
}): number {
    return input.routeTarget ?? input.projectTarget ?? defaultTarget(input.op, input.metric);
}

// ---------------------------------------------------------------------------
// Slower than it should be
// ---------------------------------------------------------------------------

/** Fewer transactions than this in a day say nothing about a route. */
export const MIN_SAMPLES = 20;
/** And a baseline needs at least this many behind it. */
export const MIN_BASELINE = 50;
/** How much slower than its own history counts as a regression: half again,
 *  and at least this many milliseconds, so 4 ms against 2 ms is not news. */
export const REGRESSION_RATIO = 1.5;
export const REGRESSION_FLOOR_MS = 100;

export type SlowReason = "target" | "regression" | "inp";

export interface RouteStats {
    readonly count: number;
    readonly p75: number | null;
    readonly baselineP75: number | null;
    readonly baselineCount: number;
    readonly target: number;
    /** INP's p75 and how many interactions, for a page load. */
    readonly inpP75?: number | null;
    readonly inpCount?: number;
}

/**
 * Why a route is slow, or null when it is not. Over its target first, since
 * that is the line somebody drew; then slower than its own last week; then a
 * page whose clicks answer slowly.
 */
export function slowReason(stats: RouteStats): SlowReason | null {
    if (stats.count >= MIN_SAMPLES && stats.p75 !== null) {
        if (stats.p75 > stats.target) return "target";
        if (
            stats.baselineP75 !== null &&
            stats.baselineCount >= MIN_BASELINE &&
            stats.p75 > stats.baselineP75 * REGRESSION_RATIO &&
            stats.p75 - stats.baselineP75 >= REGRESSION_FLOOR_MS
        ) {
            return "regression";
        }
    }
    if ((stats.inpCount ?? 0) >= MIN_SAMPLES && (stats.inpP75 ?? 0) > VITAL_TARGETS.inp) return "inp";
    return null;
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

const MAX_NAME = 200;
const MAX_SPANS = 200;

/** A string cut to a length rather than refused for it. */
const text = (max: number) => z.string().transform((value) => value.slice(0, max));
/** Seconds since the epoch, as every SDK sends them; an ISO string is accepted too. */
const seconds = z.union([
    z.number().finite(),
    z
        .string()
        .transform((value) => Date.parse(value) / 1000)
        .pipe(z.number().finite())
]);

const measurementsSchema = z
    .record(z.string(), z.object({ value: z.number().finite(), unit: z.string().optional() }).passthrough())
    .catch({});

const spanSchema = z.object({
    span_id: text(32).optional(),
    parent_span_id: text(32).nullish(),
    op: text(64).optional(),
    description: text(300).optional(),
    status: text(40).optional(),
    start_timestamp: seconds,
    timestamp: seconds
});

export const transactionSchema = z.object({
    type: z.literal("transaction"),
    event_id: text(64).optional(),
    transaction: text(2000).pipe(z.string().min(1)),
    start_timestamp: seconds,
    timestamp: seconds,
    release: text(200).optional().catch(undefined),
    environment: text(200).optional().catch(undefined),
    platform: text(40).optional().catch(undefined),
    contexts: z
        .object({
            trace: z
                .object({ op: text(64).optional(), status: text(40).optional(), span_id: text(32).optional() })
                .optional()
        })
        .optional()
        .catch(undefined),
    transaction_info: z.object({ source: text(20).optional() }).optional().catch(undefined),
    request: z.object({ url: text(2000).optional(), method: text(16).optional() }).optional().catch(undefined),
    measurements: measurementsSchema.optional(),
    spans: z.array(z.unknown()).max(5000).optional().catch(undefined)
});

/** The browser SDK's INP report: a span of its own, naming the route. */
export const inpSpanSchema = z.object({
    op: text(64).optional(),
    description: text(300).optional(),
    start_timestamp: seconds,
    data: z.object({ transaction: text(2000).optional() }).passthrough().optional().catch(undefined),
    measurements: z.object({ inp: z.object({ value: z.number().finite().nonnegative() }) })
});

export interface SpanRow {
    readonly id: string;
    readonly parentId: string | null;
    readonly op: string;
    readonly description: string;
    /** From the start of the transaction, in milliseconds. */
    readonly offsetMs: number;
    readonly durationMs: number;
    readonly status: string | null;
}

/** One transaction, as the store writes it. */
export interface PerfReading {
    readonly name: string;
    readonly op: string;
    readonly eventId: string | null;
    readonly durationMs: number;
    /** Each measurement this transaction carried, in its stored unit. */
    readonly values: Readonly<Partial<Record<PerfMetric, number>>>;
    readonly release: string | null;
    readonly environment: string | null;
    readonly url: string | null;
    readonly method: string | null;
    readonly spans: readonly SpanRow[];
    readonly at: Date;
}

const SEGMENT_ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]{24,})$/i;

/**
 * The name a route is grouped under. A name the SDK parameterized itself
 * (`source: route`) is kept as it is; a raw URL has its query dropped and its
 * ids replaced, so `/orders/1234` and `/orders/1235` are one route instead of a
 * row per order - the one thing that would make this table grow without bound.
 */
export function routeName(name: string, source: string | undefined): string {
    const trimmed = name.trim();
    if (source && source !== "url") return trimmed.slice(0, MAX_NAME);
    const [head = ""] = trimmed.split(/[?#]/);
    const parts = head.split(" ");
    const path = parts.pop() ?? "";
    const normalized = path
        .split("/")
        .map((segment) => (SEGMENT_ID.test(segment) ? "*" : segment))
        .join("/");
    return [...parts, normalized].join(" ").slice(0, MAX_NAME) || "/";
}

const MEASUREMENT_KEYS: Readonly<Record<string, PerfMetric>> = {
    lcp: "lcp",
    fcp: "fcp",
    ttfb: "ttfb",
    inp: "inp",
    cls: "cls"
};

/** A measurement in its stored unit: milliseconds, and CLS in thousandths. */
function storedValue(metric: PerfMetric, value: number): number {
    return metric === "cls" ? value * 1000 : value;
}

/** Read a transaction item, or null when it is not one. */
export function readTransaction(payload: unknown): PerfReading | null {
    const parsed = transactionSchema.safeParse(payload);
    if (!parsed.success) return null;
    const event = parsed.data;
    const durationMs = (event.timestamp - event.start_timestamp) * 1000;
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) return null;

    const values: Partial<Record<PerfMetric, number>> = { duration: durationMs };
    for (const [key, measurement] of Object.entries(event.measurements ?? {})) {
        const metric = MEASUREMENT_KEYS[key];
        if (metric && measurement.value >= 0) values[metric] = storedValue(metric, measurement.value);
    }

    const spans: SpanRow[] = [];
    for (const raw of event.spans ?? []) {
        const span = spanSchema.safeParse(raw);
        if (!span.success) continue;
        const offsetMs = (span.data.start_timestamp - event.start_timestamp) * 1000;
        const length = (span.data.timestamp - span.data.start_timestamp) * 1000;
        if (!Number.isFinite(offsetMs) || !Number.isFinite(length) || length < 0) continue;
        spans.push({
            id: span.data.span_id ?? String(spans.length),
            parentId: span.data.parent_span_id ?? null,
            op: span.data.op ?? "",
            description: span.data.description ?? "",
            offsetMs: Math.max(0, offsetMs),
            durationMs: length,
            status: span.data.status ?? null
        });
    }
    // The slowest ones are what a person reads; drawn in start order.
    const kept = spans
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, MAX_SPANS)
        .sort((a, b) => a.offsetMs - b.offsetMs);

    return {
        name: routeName(event.transaction, event.transaction_info?.source),
        op: event.contexts?.trace?.op || "default",
        eventId: event.event_id ?? null,
        durationMs,
        values,
        release: event.release || null,
        environment: event.environment || null,
        url: event.request?.url || null,
        method: event.request?.method || null,
        spans: kept,
        at: new Date(event.timestamp * 1000)
    };
}

/** Read the browser SDK's standalone INP span, or null when it is not one. */
export function readInpSpan(payload: unknown): { name: string; value: number; at: Date } | null {
    const parsed = inpSpanSchema.safeParse(payload);
    if (!parsed.success) return null;
    const name = parsed.data.data?.transaction;
    if (!name) return null;
    return {
        name: routeName(name, "route"),
        value: parsed.data.measurements.inp.value,
        at: new Date(parsed.data.start_timestamp * 1000)
    };
}

/** A duration for a person to read: "850 ms", "3.2 s". */
export function formatMs(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "-";
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

/** A value of a metric in its own unit: CLS as a score, the rest as time. */
export function formatMetric(metric: PerfMetric, value: number | null | undefined): string {
    if (metric !== "cls") return formatMs(value);
    if (value === null || value === undefined || !Number.isFinite(value)) return "-";
    return (value / 1000).toFixed(2);
}
