/**
 * How many copies of a service run, and when that number moves by itself.
 *
 * The count is the service's own setting; autoscaling is a range around it and a
 * CPU figure to hold. The decision is a pure function of the last reading and a
 * little remembered state, so the loop that applies it does nothing but read,
 * decide and apply - and the deciding can be tested without a machine.
 *
 * The CPU figure is the one the rest of the dashboard shows: each container's
 * share of the whole machine, averaged over the replicas. Scaling up is quick and
 * scaling down is slow on purpose - a service briefly short of capacity is worse
 * than one briefly over it, and a count that flaps restarts nothing but still
 * churns the history.
 */

import { z } from "zod";

/** The most replicas one service can run. */
export const REPLICAS_MAX = 10;

/** Consecutive readings above the target before one more replica is added. */
export const AUTOSCALE_UP_AFTER = 3;

/** Consecutive readings under half the target before one is taken away. */
export const AUTOSCALE_DOWN_AFTER = 10;

/** How long after a change the count is left alone, so the new replica's own
 *  effect on the reading is seen before the next decision. */
export const AUTOSCALE_COOLDOWN_MS = 5 * 60_000;

export const autoscaleSchema = z
    .object({
        min: z.number().int().min(1).max(REPLICAS_MAX),
        max: z.number().int().min(1).max(REPLICAS_MAX),
        /** Average CPU per replica to hold, as a share of the machine. */
        cpuPercent: z.number().int().min(5).max(90)
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

/** What the loop remembers about one service between readings. */
export interface AutoscaleState {
    readonly above: number;
    readonly below: number;
    /** When the count last moved, in epoch ms; null when it never has. */
    readonly changedAt: number | null;
}

export const AUTOSCALE_IDLE: AutoscaleState = { above: 0, below: 0, changedAt: null };

/**
 * The next replica count for one reading.
 *
 * A count outside the range is brought back into it straight away - that is the
 * operator's range changing, not the load. Otherwise it grows after
 * `AUTOSCALE_UP_AFTER` readings over the target, by as many replicas as the
 * reading says it needs (at least one, never past the most), and shrinks by one
 * after `AUTOSCALE_DOWN_AFTER` readings under half of it. Nothing moves within
 * the cooldown. A missing reading decides nothing and forgets the streaks.
 */
export function autoscaleStep(
    config: Autoscale,
    replicas: number,
    cpuPercent: number | null,
    state: AutoscaleState,
    now: number
): { replicas: number; state: AutoscaleState } {
    if (replicas < config.min || replicas > config.max) {
        const bounded = Math.min(config.max, Math.max(config.min, replicas));
        return { replicas: bounded, state: { above: 0, below: 0, changedAt: now } };
    }
    if (cpuPercent === null || !Number.isFinite(cpuPercent)) {
        return { replicas, state: { ...state, above: 0, below: 0 } };
    }
    const above = cpuPercent > config.cpuPercent ? state.above + 1 : 0;
    const below = cpuPercent < config.cpuPercent / 2 ? state.below + 1 : 0;
    const cooling = state.changedAt !== null && now - state.changedAt < AUTOSCALE_COOLDOWN_MS;
    if (!cooling && above >= AUTOSCALE_UP_AFTER && replicas < config.max) {
        const needed = Math.ceil((replicas * cpuPercent) / config.cpuPercent);
        const next = Math.min(config.max, Math.max(replicas + 1, needed));
        return { replicas: next, state: { above: 0, below: 0, changedAt: now } };
    }
    if (!cooling && below >= AUTOSCALE_DOWN_AFTER && replicas > config.min) {
        return { replicas: replicas - 1, state: { above: 0, below: 0, changedAt: now } };
    }
    return { replicas, state: { above, below, changedAt: state.changedAt } };
}
