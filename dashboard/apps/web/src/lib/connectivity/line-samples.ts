/**
 * The line, minute by minute: what one sample of the connectivity sampler says,
 * how a run of them becomes "the internet went down" and "it came back", and how
 * the stored minutes and hours are drawn as a chart.
 *
 * Pure, and safe to import from the browser: the sampler that writes rows
 * (`line-sampler.ts`) and the screen that draws them decide from here.
 *
 * One lost sample is not an outage. The line is declared down after
 * `DOWN_AFTER_SAMPLES` failed samples in a row, the same `for:` a Prometheus
 * alerting rule or a Home Assistant trigger puts between a reading and an alert,
 * and up again on the first sample that answers - a recovery is never in doubt
 * the way a single silence is.
 */

import { z } from "zod";
import { CONNECTIVITY_TRIGGER_EVENTS } from "@polaris/core";

/** Addresses asked by IP, so a dead resolver cannot make a working line look dead. */
export const LINE_TARGETS = [
    { host: "1.1.1.1", port: 443 },
    { host: "8.8.8.8", port: 443 },
    { host: "9.9.9.9", port: 443 }
] as const;

/** Asked through the box's own resolver, so a DNS-only failure shows as one. */
export const DNS_PROBE_NAME = "cloudflare.com";

/** Connect attempts per target per sample: three targets, two each, so loss has a grain of a sixth. */
export const ATTEMPTS_PER_TARGET = 2;

/** Failed samples in a row before the line is down: about two minutes at the usual pace. */
export const DOWN_AFTER_SAMPLES = 2;

export const SAMPLE_EVERY_MS = 60_000;

/** Raw minutes are kept this long; the hours keep the history. */
export const SAMPLE_RETENTION_MS = 2 * 24 * 3_600_000;
/** Hourly sums and address changes are kept this long. */
export const HOUR_RETENTION_MS = 400 * 24 * 3_600_000;

export type LineKind = "line" | "dns";

/** What one sample measured. */
export interface LineProbe {
    /** Connect attempts made, over every target. */
    readonly attempts: number;
    /** Connect times of the attempts that answered, in milliseconds. */
    readonly latencies: readonly number[];
    readonly dnsOk: boolean;
    readonly dnsMs: number | null;
    /** The public address found, or null when it was not asked or did not answer. */
    readonly publicIp: string | null;
    /** Whether the dashboard's public name resolves to `publicIp`; null when there
     *  is no name to check or it was not asked. */
    readonly outside: boolean | null;
}

/** up, or the reason it is not. */
export type Verdict = "up" | LineKind;

export function verdict(probe: LineProbe): Verdict {
    if (probe.latencies.length === 0) return "line";
    return probe.dnsOk ? "up" : "dns";
}

export function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function lossPercent(probe: LineProbe): number {
    if (probe.attempts <= 0) return 100;
    const lost = Math.max(0, probe.attempts - probe.latencies.length);
    return Math.round((lost / probe.attempts) * 1000) / 10;
}

/** What the sampler remembers between samples, stored as one setting. */
export interface LineState {
    readonly status: "up" | "down";
    /** The worst kind seen while down. */
    readonly kind: LineKind | null;
    readonly failStreak: number;
    /** When the first failed sample of the current streak was taken. */
    readonly failSince: number | null;
    readonly publicIp: string | null;
    /** The public name has pointed here at least once, so it not doing so is news. */
    readonly outsideMatched: boolean;
    /** "Unreachable from outside" was already said for the current mismatch. */
    readonly outsideAnnounced: boolean;
    readonly lastAt: number | null;
}

export const INITIAL_LINE_STATE: LineState = {
    status: "up",
    kind: null,
    failStreak: 0,
    failSince: null,
    publicIp: null,
    outsideMatched: false,
    outsideAnnounced: false,
    lastAt: null
};

export const lineStateSchema = z.object({
    status: z.enum(["up", "down"]),
    kind: z.enum(["line", "dns"]).nullable(),
    failStreak: z.number().int().min(0),
    failSince: z.number().nullable(),
    publicIp: z.string().max(64).nullable(),
    outsideMatched: z.boolean(),
    outsideAnnounced: z.boolean(),
    lastAt: z.number().nullable()
});

export function parseLineState(value: string | null): LineState {
    if (!value) return INITIAL_LINE_STATE;
    try {
        const parsed = lineStateSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : INITIAL_LINE_STATE;
    } catch {
        return INITIAL_LINE_STATE;
    }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export const CONNECTIVITY_EVENTS = CONNECTIVITY_TRIGGER_EVENTS;
export type ConnectivityEventName = (typeof CONNECTIVITY_EVENTS)[number];

/** What each event carries, to a notification and to an automation as `trigger.*`. */
export const connectivityPayloadSchemas = {
    down: z.object({
        event: z.literal("down"),
        kind: z.enum(["line", "dns"]),
        since: z.string().datetime()
    }),
    up: z.object({
        event: z.literal("up"),
        kind: z.enum(["line", "dns"]),
        since: z.string().datetime(),
        at: z.string().datetime(),
        durationSeconds: z.number().int().min(0)
    }),
    ipChanged: z.object({
        event: z.literal("ipChanged"),
        previous: z.string().max(64),
        current: z.string().max(64),
        at: z.string().datetime()
    }),
    unreachable: z.object({
        event: z.literal("unreachable"),
        publicIp: z.string().max(64).nullable(),
        at: z.string().datetime()
    })
} as const;

export type ConnectivityEvent = {
    [K in ConnectivityEventName]: z.infer<(typeof connectivityPayloadSchemas)[K]>;
}[ConnectivityEventName];

/** Which kind is worse: a dead line hides a dead resolver. */
function worse(a: LineKind | null, b: LineKind): LineKind {
    return a === "line" || b === "line" ? "line" : "dns";
}

/**
 * Fold one sample into the state, and say what it means. At most one each of
 * down/up per transition, an address change when the address differs from the
 * last one known (a first sighting is not a change), and "unreachable from
 * outside" once per mismatch, only for a name that had pointed here before - one
 * behind a proxy never pointed at the box and is never reported.
 */
export function advanceLine(
    state: LineState,
    probe: LineProbe,
    now: number
): { state: LineState; events: ConnectivityEvent[] } {
    const events: ConnectivityEvent[] = [];
    const seen = verdict(probe);
    const iso = new Date(now).toISOString();
    let next: LineState = { ...state, lastAt: now };

    if (seen === "up") {
        if (state.status === "down" && state.failSince !== null) {
            events.push({
                event: "up",
                kind: state.kind ?? "line",
                since: new Date(state.failSince).toISOString(),
                at: iso,
                durationSeconds: Math.max(0, Math.round((now - state.failSince) / 1000))
            });
        }
        next = { ...next, status: "up", kind: null, failStreak: 0, failSince: null };
    } else {
        const failSince = state.failSince ?? now;
        const failStreak = state.failStreak + 1;
        const kind = worse(state.status === "down" ? state.kind : null, seen);
        if (state.status === "up" && failStreak >= DOWN_AFTER_SAMPLES) {
            events.push({ event: "down", kind, since: new Date(failSince).toISOString() });
            next = { ...next, status: "down", kind, failStreak, failSince };
        } else {
            next = {
                ...next,
                kind: state.status === "down" ? kind : state.kind,
                failStreak,
                failSince
            };
        }
    }

    if (probe.publicIp) {
        if (state.publicIp && state.publicIp !== probe.publicIp) {
            events.push({
                event: "ipChanged",
                previous: state.publicIp,
                current: probe.publicIp,
                at: iso
            });
        }
        next = { ...next, publicIp: probe.publicIp };
    }

    if (seen === "up" && probe.outside !== null) {
        if (probe.outside) next = { ...next, outsideMatched: true, outsideAnnounced: false };
        else if (state.outsideMatched && !state.outsideAnnounced) {
            events.push({ event: "unreachable", publicIp: next.publicIp, at: iso });
            next = { ...next, outsideAnnounced: true };
        }
    }
    return { state: next, events };
}

/* -------------------------------------------------------------------------- */
/* Charts                                                                      */
/* -------------------------------------------------------------------------- */

export const LINE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type LineRange = (typeof LINE_RANGES)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_SPEC: Record<LineRange, { readonly spanMs: number; readonly stepMs: number }> = {
    "24h": { spanMs: DAY_MS, stepMs: 10 * 60_000 },
    "7d": { spanMs: 7 * DAY_MS, stepMs: HOUR_MS },
    "30d": { spanMs: 30 * DAY_MS, stepMs: 6 * HOUR_MS },
    "90d": { spanMs: 90 * DAY_MS, stepMs: DAY_MS }
};

export function isLineRange(value: unknown): value is LineRange {
    return typeof value === "string" && (LINE_RANGES as readonly string[]).includes(value);
}

/** A run of samples added up: an hour row, or any number of them. */
export interface SampleSum {
    readonly samples: number;
    readonly upSamples: number;
    readonly dnsFailSamples: number;
    readonly latencySum: number;
    readonly latencyCount: number;
    readonly latencyMax: number | null;
    readonly lossSum: number;
}

export const EMPTY_SUM: SampleSum = {
    samples: 0,
    upSamples: 0,
    dnsFailSamples: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyMax: null,
    lossSum: 0
};

/** One stored minute as a sum of one. */
export function sumOfSample(sample: {
    up: boolean;
    dnsOk: boolean;
    latencyMs: number | null;
    lossPct: number;
}): SampleSum {
    return {
        samples: 1,
        upSamples: sample.up ? 1 : 0,
        dnsFailSamples: sample.up && !sample.dnsOk ? 1 : 0,
        latencySum: sample.latencyMs ?? 0,
        latencyCount: sample.latencyMs === null ? 0 : 1,
        latencyMax: sample.latencyMs,
        lossSum: sample.lossPct
    };
}

export function addSums(a: SampleSum, b: SampleSum): SampleSum {
    return {
        samples: a.samples + b.samples,
        upSamples: a.upSamples + b.upSamples,
        dnsFailSamples: a.dnsFailSamples + b.dnsFailSamples,
        latencySum: a.latencySum + b.latencySum,
        latencyCount: a.latencyCount + b.latencyCount,
        latencyMax:
            a.latencyMax === null
                ? b.latencyMax
                : b.latencyMax === null
                  ? a.latencyMax
                  : Math.max(a.latencyMax, b.latencyMax),
        lossSum: a.lossSum + b.lossSum
    };
}

/** One point of the line's charts. Null where nothing was measured: a gap, not a zero. */
export interface LinePoint {
    readonly t: number;
    readonly latencyMs: number | null;
    readonly lossPct: number | null;
    readonly upPct: number | null;
}

function pointOf(t: number, sum: SampleSum): LinePoint {
    if (sum.samples === 0) return { t, latencyMs: null, lossPct: null, upPct: null };
    return {
        t,
        latencyMs: sum.latencyCount === 0 ? null : Math.round((sum.latencySum / sum.latencyCount) * 10) / 10,
        lossPct: Math.round((sum.lossSum / sum.samples) * 10) / 10,
        upPct: Math.round(((sum.upSamples - sum.dnsFailSamples) / sum.samples) * 1000) / 10
    };
}

/**
 * Cut `[to - span, to)` into steps and add every timed sum into its step. The
 * steps line up on multiples of the step (UTC), so the same range read twice a
 * minute apart draws the same buckets.
 */
export function lineSeries(
    sums: readonly { readonly at: number; readonly sum: SampleSum }[],
    range: LineRange,
    to: number
): LinePoint[] {
    const { spanMs, stepMs } = RANGE_SPEC[range];
    const end = Math.ceil(to / stepMs) * stepMs;
    const start = end - spanMs;
    const count = Math.round(spanMs / stepMs);
    const steps: SampleSum[] = Array.from({ length: count }, () => EMPTY_SUM);
    for (const { at, sum } of sums) {
        if (at < start || at >= end) continue;
        const index = Math.floor((at - start) / stepMs);
        steps[index] = addSums(steps[index]!, sum);
    }
    return steps.map((sum, index) => pointOf(start + index * stepMs, sum));
}

/** The whole range as one number each, for the chart headers. */
export function lineTotals(sums: readonly { readonly sum: SampleSum }[]): LinePoint & {
    readonly samples: number;
    readonly latencyMaxMs: number | null;
} {
    const total = sums.reduce((acc, entry) => addSums(acc, entry.sum), EMPTY_SUM);
    return { ...pointOf(0, total), samples: total.samples, latencyMaxMs: total.latencyMax };
}

/** The start of the UTC hour a time falls in. */
export function hourOf(at: number): number {
    return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/* -------------------------------------------------------------------------- */
/* What the screen is sent                                                     */
/* -------------------------------------------------------------------------- */

export interface PublicIpChangeView {
    readonly at: string;
    readonly previous: string | null;
    readonly current: string;
}

export interface LineReport {
    readonly range: LineRange;
    readonly from: number;
    readonly to: number;
    readonly points: readonly LinePoint[];
    readonly totals: ReturnType<typeof lineTotals>;
    /** The line as the sampler last left it; null before its first pass. */
    readonly now: {
        readonly at: string;
        readonly up: boolean;
        readonly kind: LineKind | null;
        readonly since: string | null;
        readonly publicIp: string | null;
    } | null;
    /** Newest first. Absent from a shared view, which does not name this network. */
    readonly ipChanges?: readonly PublicIpChangeView[];
}

/** The report with its addresses taken out, for a view that must not name this network. */
export function sharedLineReport(report: LineReport): LineReport {
    const { ipChanges: _ipChanges, ...rest } = report;
    return { ...rest, now: rest.now ? { ...rest.now, publicIp: null } : null };
}
