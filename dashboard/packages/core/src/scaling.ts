/**
 * How many copies of a service run, and when that number moves by itself.
 *
 * The count is the service's own setting; autoscaling is a range around it, a
 * CPU figure to hold and, optionally, a number of requests each copy should take
 * a minute. The decision is a pure function of the last reading and a little
 * remembered state, so the loop that applies it does nothing but read, decide
 * and apply - and the deciding can be tested without a machine.
 *
 * The CPU figure is the one the rest of the dashboard shows: each container's
 * share of the whole machine, averaged over the replicas. The traffic figure is
 * the requests the edge logged for the service's addresses in the last minute,
 * shared over the copies. Either one over its target is a reason to add a copy;
 * a copy is only taken away when every signal there is says the service is
 * quiet. Scaling up is quick and scaling down is slow on purpose - a service
 * briefly short of capacity is worse than one briefly over it, and a count that
 * flaps restarts nothing but still churns the history.
 */

import { z } from "zod";

/** The most replicas one service can run. */
export const REPLICAS_MAX = 10;

/** Consecutive readings above the target before one more replica is added. */
export const AUTOSCALE_UP_AFTER = 3;

/** Consecutive readings under half the target before one is taken away. */
export const AUTOSCALE_DOWN_AFTER = 10;

/** Consecutive readings with no request at all before an idle service goes
 *  straight to its fewest copies rather than one at a time. */
export const AUTOSCALE_IDLE_AFTER = 10;

/** How long after a change the count is left alone, so the new replica's own
 *  effect on the reading is seen before the next decision. */
export const AUTOSCALE_COOLDOWN_MS = 5 * 60_000;

/** The stretch of the edge's log one traffic reading counts requests over. */
export const AUTOSCALE_TRAFFIC_WINDOW_MS = 60_000;

/** The least of that stretch the log has to cover for the reading to mean
 *  anything: a log that only just started says nothing about a minute. */
export const AUTOSCALE_TRAFFIC_MIN_SPAN_MS = 10_000;

/** The highest traffic target a copy can be given, in requests a minute. */
export const REQUESTS_PER_COPY_MAX = 100_000;

export const autoscaleSchema = z
    .object({
        min: z.number().int().min(1).max(REPLICAS_MAX),
        max: z.number().int().min(1).max(REPLICAS_MAX),
        /** Average CPU per replica to hold, as a share of the machine. */
        cpuPercent: z.number().int().min(5).max(90),
        /** Requests a minute each replica should take; null leaves traffic out of
         *  it. A setting stored before this existed has no such key, and reads as
         *  null - scaled on CPU exactly as it was. */
        requestsPerCopy: z
            .number()
            .int("Give a whole number of requests")
            .min(1, "At least 1 request a minute")
            .max(REQUESTS_PER_COPY_MAX, `At most ${REQUESTS_PER_COPY_MAX} requests a minute`)
            .nullable()
            .default(null)
    })
    .refine((value) => value.min <= value.max, {
        message: "The most replicas cannot be fewer than the fewest",
        path: ["max"]
    });
export type Autoscale = z.infer<typeof autoscaleSchema>;

export const serviceScalingSchema = z.object({
    replicas: z.number().int().min(1).max(REPLICAS_MAX),
    autoscale: autoscaleSchema.nullable()
});
export type ServiceScaling = z.infer<typeof serviceScalingSchema>;

/** The most CPU (cores) and memory (MB) one container may use; null is no limit.
 *  The same ranges the host daemon enforces. */
export const resourceLimitsSchema = z.object({
    cpus: z
        .number()
        .min(0.05, "Give at least 0.05 of a core")
        .max(256, "At most 256 cores")
        .nullable(),
    memoryMb: z
        .number()
        .int("Memory is a whole number of MB")
        .min(16, "Give at least 16 MB")
        .max(4_194_304, "At most 4 TB")
        .nullable()
});
export type ResourceLimitsInput = z.infer<typeof resourceLimitsSchema>;

/** The stored column, or null when it is unset or no longer valid. */
export function parseAutoscale(raw: string | null | undefined): Autoscale | null {
    if (!raw) return null;
    try {
        const parsed = autoscaleSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Why a service's traffic cannot be counted, or null when it can: the edge whose
 *  log is read is the one on the machine Polaris runs on. */
export function trafficRefusal(app: { target: { kind: string } }): string | null {
    if (app.target.kind === "local") return null;
    return "Requests are counted on the machine Polaris runs on, so a service on another server scales on CPU alone.";
}

/**
 * Requests a minute, from when each one arrived.
 *
 * Counted over the last `AUTOSCALE_TRAFFIC_WINDOW_MS`, or over as much of it as
 * the log holds when its window starts later - a log busy enough to hold less
 * than a minute in the part that is read - and scaled to a minute. Null when the
 * log holds nothing at all (not mounted, not written yet) or too little of the
 * minute to judge by: that is not knowing, which is not the same as no traffic.
 */
export function requestRate(times: readonly number[], windowStart: number | null, now: number): number | null {
    if (windowStart === null) return null;
    const from = Math.max(windowStart, now - AUTOSCALE_TRAFFIC_WINDOW_MS);
    const span = now - from;
    if (span < AUTOSCALE_TRAFFIC_MIN_SPAN_MS) return null;
    let count = 0;
    for (const at of times) if (at >= from && at <= now) count += 1;
    return (count * 60_000) / span;
}

/** What one reading holds. */
export interface AutoscaleReading {
    /** Average CPU per replica, as a share of the machine; null when no replica
     *  answered. */
    readonly cpuPercent: number | null;
    /** Requests a minute across every replica; null when they cannot be counted. */
    readonly requestsPerMinute: number | null;
}

/**
 * What moved the count: the range it was brought back into, the signal that was
 * over its target (or both), the signals that were quiet (or both), or a stretch
 * with no request at all.
 */
export const AUTOSCALE_SIGNALS = ["range", "cpu", "traffic", "both", "idle"] as const;
export type AutoscaleSignal = (typeof AUTOSCALE_SIGNALS)[number];

/** A change the autoscaler made is written into the service's history under this
 *  action, followed by its signal: `autoscaled-traffic`. */
export const AUTOSCALED_ACTION_PREFIX = "autoscaled-";

/** What the loop remembers about one service between readings. */
export interface AutoscaleState {
    readonly above: number;
    readonly below: number;
    /** Consecutive readings in which not one request arrived. */
    readonly quiet: number;
    /** When the count last moved, in epoch ms; null when it never has. */
    readonly changedAt: number | null;
}

export const AUTOSCALE_IDLE: AutoscaleState = { above: 0, below: 0, quiet: 0, changedAt: null };

/**
 * The next replica count for one reading, and what decided it.
 *
 * A count outside the range is brought back into it straight away - that is the
 * operator's range changing, not the load. Otherwise it grows after
 * `AUTOSCALE_UP_AFTER` readings in which either signal is over its target, by as
 * many replicas as the busier one says it needs (at least one, never past the
 * most), and shrinks by one after `AUTOSCALE_DOWN_AFTER` readings in which every
 * signal is under half of its target. When those quiet readings also had no
 * request at all for `AUTOSCALE_IDLE_AFTER` of them, it goes straight to the
 * fewest instead. Nothing moves within the cooldown.
 *
 * Traffic only counts when the setting has a traffic target and the reading has
 * a count; a signal with nothing to say sits the reading out, and a reading with
 * neither decides nothing and forgets the streaks. A setting with no traffic
 * target is therefore decided on CPU exactly as it was before traffic existed.
 */
export function autoscaleStep(
    config: Autoscale,
    replicas: number,
    reading: AutoscaleReading,
    state: AutoscaleState,
    now: number
): { replicas: number; state: AutoscaleState; signal: AutoscaleSignal | null } {
    const moved = (next: number, signal: AutoscaleSignal) => ({
        replicas: next,
        state: { above: 0, below: 0, quiet: 0, changedAt: now },
        signal
    });
    if (replicas < config.min || replicas > config.max) {
        return moved(Math.min(config.max, Math.max(config.min, replicas)), "range");
    }
    const cpu = reading.cpuPercent !== null && Number.isFinite(reading.cpuPercent) ? reading.cpuPercent : null;
    const traffic =
        config.requestsPerCopy !== null &&
        reading.requestsPerMinute !== null &&
        Number.isFinite(reading.requestsPerMinute) &&
        reading.requestsPerMinute >= 0
            ? reading.requestsPerMinute
            : null;
    if (cpu === null && traffic === null) {
        return { replicas, state: { ...state, above: 0, below: 0, quiet: 0 }, signal: null };
    }
    const perCopy = traffic === null ? null : traffic / replicas;
    const cpuHigh = cpu !== null && cpu > config.cpuPercent;
    const trafficHigh = perCopy !== null && config.requestsPerCopy !== null && perCopy > config.requestsPerCopy;
    const cpuLow = cpu === null || cpu < config.cpuPercent / 2;
    const trafficLow = perCopy === null || config.requestsPerCopy === null || perCopy < config.requestsPerCopy / 2;

    const above = cpuHigh || trafficHigh ? state.above + 1 : 0;
    const below = cpuLow && trafficLow ? state.below + 1 : 0;
    const quiet = traffic === 0 ? state.quiet + 1 : 0;
    const cooling = state.changedAt !== null && now - state.changedAt < AUTOSCALE_COOLDOWN_MS;
    if (!cooling && above >= AUTOSCALE_UP_AFTER && replicas < config.max) {
        const byCpu = cpuHigh && cpu !== null ? Math.ceil((replicas * cpu) / config.cpuPercent) : 0;
        const byTraffic =
            trafficHigh && traffic !== null && config.requestsPerCopy !== null
                ? Math.ceil(traffic / config.requestsPerCopy)
                : 0;
        const next = Math.min(config.max, Math.max(replicas + 1, byCpu, byTraffic));
        return moved(next, cpuHigh && trafficHigh ? "both" : trafficHigh ? "traffic" : "cpu");
    }
    if (!cooling && quiet >= AUTOSCALE_IDLE_AFTER && below >= AUTOSCALE_IDLE_AFTER && replicas > config.min) {
        return moved(config.min, "idle");
    }
    if (!cooling && below >= AUTOSCALE_DOWN_AFTER && replicas > config.min) {
        return moved(replicas - 1, cpu !== null && traffic !== null ? "both" : traffic !== null ? "traffic" : "cpu");
    }
    return { replicas, state: { above, below, quiet, changedAt: state.changedAt }, signal: null };
}
