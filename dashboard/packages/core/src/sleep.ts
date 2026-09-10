/**
 * Sleep mode: a service nobody has visited for a while is stopped, and the next
 * request starts it again.
 *
 * The decision is pure, so what puts somebody's service to sleep can be asserted
 * without an edge or a clock. The one rule it is careful about is not knowing: the
 * edge's log is read as a tail, so a service with no request in it has either been
 * idle for the whole window or had its last visit before the window starts - and
 * only the first of those is a reason to stop it.
 */

import { z } from "zod";

export const SLEEP_AFTER_MIN_MINUTES = 5;
export const SLEEP_AFTER_MAX_MINUTES = 24 * 60;

export const serviceSleepSchema = z
    .number()
    .int("Give a whole number of minutes")
    .min(SLEEP_AFTER_MIN_MINUTES, `At least ${SLEEP_AFTER_MIN_MINUTES} minutes`)
    .max(SLEEP_AFTER_MAX_MINUTES, "At most a day")
    .nullable();

/** What Polaris's own reachability probe sends, so its visits never count. */
export const HEALTH_PROBE_USER_AGENT = "polaris-health-probe";

/**
 * Whether a request in the edge log is somebody using the service: not Polaris's
 * own probe, and not one the firewall turned away - a scanner refused at the door
 * must not keep a service awake, or wake it.
 */
export function countsAsVisit(entry: { status: number; userAgent: string | null }): boolean {
    if (entry.userAgent === HEALTH_PROBE_USER_AGENT) return false;
    return entry.status !== 401 && entry.status !== 403 && entry.status !== 429;
}

/** Why a service cannot sleep, or null when it can: only one copy, and only on the
 *  machine whose edge log says who visited. */
export function sleepRefusal(app: {
    replicas: number;
    autoscale: string | null;
    target: { kind: string };
}): string | null {
    if (app.target.kind !== "local")
        return "Only a service on the machine Polaris runs on can sleep.";
    if (app.replicas > 1 || app.autoscale)
        return "A service that sleeps runs one copy; turn off the extra copies first.";
    return null;
}

export interface SleepFacts {
    /** Minutes of no visits before it sleeps; null is never. */
    readonly sleepAfterMinutes: number | null;
    /** When it was put to sleep, in epoch ms; null while awake. */
    readonly asleepSince: number | null;
    /** The latest visit the log holds for it, in epoch ms. */
    readonly lastVisit: number | null;
    /** The oldest request the log window holds at all, in epoch ms. */
    readonly windowStart: number | null;
    /** Since when it has been running without being asked to sleep, in epoch ms. */
    readonly awakeSince: number;
    readonly now: number;
}

/**
 * Put to sleep, wake, or leave it. A sleeping service wakes on any visit after it
 * went to sleep, or when sleeping is turned off; an awake one sleeps only once the
 * whole idle stretch is known to be idle.
 */
export function sleepDecision(facts: SleepFacts): "sleep" | "wake" | "stay" {
    if (facts.asleepSince !== null) {
        if (facts.sleepAfterMinutes === null) return "wake";
        return facts.lastVisit !== null && facts.lastVisit > facts.asleepSince ? "wake" : "stay";
    }
    if (facts.sleepAfterMinutes === null) return "stay";
    const idleFor = facts.sleepAfterMinutes * 60_000;
    const idleSince = Math.max(facts.lastVisit ?? 0, facts.awakeSince);
    if (facts.now - idleSince < idleFor) return "stay";
    // No visit in the window: idle only if the window reaches back past the stretch.
    if (
        facts.lastVisit === null &&
        (facts.windowStart === null || facts.windowStart > facts.now - idleFor)
    ) {
        return "stay";
    }
    return "sleep";
}
