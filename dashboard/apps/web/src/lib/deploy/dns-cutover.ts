/**
 * Moving a hostname from the service that answers it to another one, as a state
 * machine the background pass and the actions both drive.
 *
 * Pure: every decision - which phase comes next, what a rollback has to undo,
 * whether a step may run again - is a function of the stored row and what was just
 * observed, so each one is asserted without a database, a resolver or a network.
 * The service (dns-cutover-service.ts) carries out the effects these name.
 *
 * The phases, in order:
 *
 * - `preflight-failed` - the target cannot take the name yet; nothing was changed.
 * - `lowering` - the record's TTL was lowered and the old, longer one is still
 *   running out in caches; switching now is allowed, only slower to settle.
 * - `ready` - waiting for somebody to press Switch.
 * - `propagating` - switched; the public resolvers and the new service are polled.
 * - `finishing` - both agree; the route moves for good and the TTL goes back.
 * - `done`, `failed`, `rolled-back` - closed (failed stays open for a rollback).
 */

import { z } from "zod";

export const CUTOVER_PHASES = [
    "preflight-failed",
    "lowering",
    "ready",
    "propagating",
    "finishing",
    "done",
    "failed",
    "rolled-back"
] as const;
export type CutoverPhase = (typeof CUTOVER_PHASES)[number];

/**
 * How the switch is made.
 * - `edge` - both services answer behind the same edge, so DNS does not change
 *   and only the route moves.
 * - `cloudflare` - the name's zone is on a Cloudflare token Polaris holds, so
 *   Polaris writes the record itself.
 * - `manual` - the record is somewhere Polaris cannot write; the screen names the
 *   exact record and checks from here when it has changed.
 */
export type CutoverMode = "edge" | "cloudflare" | "manual";

/** The TTL a record is lowered to before the switch, in seconds. */
export const LOWERED_TTL = 60;
/** The longest the lowering waits for an old TTL to run out: one day. */
export const MAX_LOWER_WAIT_S = 86_400;
/** How long a switch may take to reach the resolvers before it is called failed. */
export const PROPAGATION_LIMIT_MS = 48 * 60 * 60 * 1000;

export type CutoverFailure =
    | "same-service"
    | "target-not-deployed"
    | "target-not-running"
    | "target-not-routed"
    | "target-down"
    | "no-address"
    | "record-write-failed"
    | "propagation-timeout";

/** What the pre-flight found about the target. */
export interface PreflightChecks {
    readonly deployed: boolean;
    readonly running: boolean;
    /** How the target answered for the hostname when asked directly. `skipped` when it
     *  shares the edge with the source, where asking would reach the source. */
    readonly answers: "up" | "down" | "not-routed" | "skipped";
    /** The code it answered with, when it answered. */
    readonly code: number | null;
    /** The address the record has to name once switched, or null when there is none. */
    readonly newValue: string | null;
    /** `ready` - a certificate already covers the name where it will be served.
     *  `on-switch` - one is issued by the target once the record points at it. */
    readonly tls: "ready" | "on-switch";
}

export const preflightChecksSchema = z.object({
    deployed: z.boolean(),
    running: z.boolean(),
    answers: z.enum(["up", "down", "not-routed", "skipped"]),
    code: z.number().int().nullable(),
    newValue: z.string().nullable(),
    tls: z.enum(["ready", "on-switch"])
});

/** The first problem that stops the cutover, or null when the target can take it. */
export function preflightProblem(mode: CutoverMode, checks: PreflightChecks): CutoverFailure | null {
    if (!checks.deployed) return "target-not-deployed";
    if (!checks.running) return "target-not-running";
    if (mode !== "edge" && checks.newValue === null) return "no-address";
    if (checks.answers === "not-routed") return "target-not-routed";
    if (checks.answers === "down") return "target-down";
    return null;
}

/** Where a new cutover starts. The lowering waits out the TTL the record had, so
 *  every cache holding the old answer has let it go by the time of the switch. */
export function initialState(
    mode: CutoverMode,
    checks: PreflightChecks,
    oldTtl: number | null,
    now: Date
): { phase: CutoverPhase; failure: CutoverFailure | null; lowerUntil: Date | null } {
    const failure = preflightProblem(mode, checks);
    if (failure) return { phase: "preflight-failed", failure, lowerUntil: null };
    if (mode === "cloudflare" && oldTtl !== null && oldTtl > LOWERED_TTL) {
        const wait = Math.min(oldTtl, MAX_LOWER_WAIT_S) * 1000;
        return { phase: "lowering", failure: null, lowerUntil: new Date(now.getTime() + wait) };
    }
    return { phase: "ready", failure: null, lowerUntil: null };
}

/** Whether the TTL is lowered on start: only where Polaris writes the record, and only
 *  when it is longer than the lowered one (an automatic TTL, 1, is already short). */
export function lowersTtl(mode: CutoverMode, oldTtl: number | null): boolean {
    return mode === "cloudflare" && oldTtl !== null && oldTtl > LOWERED_TTL;
}

export function isOpen(phase: CutoverPhase): boolean {
    return phase !== "done" && phase !== "rolled-back" && phase !== "preflight-failed";
}

export function canSwitch(phase: CutoverPhase): boolean {
    return phase === "lowering" || phase === "ready";
}

export function canRollback(phase: CutoverPhase): boolean {
    return phase === "lowering" || phase === "ready" || phase === "propagating" || phase === "failed";
}

/** Whether the target's edge carries a route for the hostname while the old one still
 *  serves it: from the start, so the pre-flight can ask it, until the cutover closes. */
export function stagesRoute(mode: CutoverMode, phase: CutoverPhase): boolean {
    return mode !== "edge" && (canSwitch(phase) || phase === "propagating" || phase === "finishing");
}

export interface CutoverRow {
    readonly phase: CutoverPhase;
    readonly mode: CutoverMode;
    readonly lowerUntil: Date | null;
    readonly switchedAt: Date | null;
    readonly oldTtl: number | null;
}

/** What one poll found once switched. */
export interface PropagationObservation {
    /** Every public resolver that answered gives the new value. */
    readonly dnsSettled: boolean;
    /** The hostname answers from the new service. */
    readonly targetUp: boolean;
}

/** One background pass over an open cutover: the phase it moves to, or the same one.
 *  Running it twice on the same row and observation gives the same answer. */
export function tick(
    row: CutoverRow,
    observation: PropagationObservation | null,
    now: Date
): { phase: CutoverPhase; failure: CutoverFailure | null } {
    switch (row.phase) {
        case "lowering":
            return {
                phase: row.lowerUntil && now.getTime() >= row.lowerUntil.getTime() ? "ready" : "lowering",
                failure: null
            };
        case "propagating": {
            if (observation && observation.dnsSettled && observation.targetUp) {
                return { phase: "finishing", failure: null };
            }
            const since = row.switchedAt?.getTime() ?? now.getTime();
            if (now.getTime() - since > PROPAGATION_LIMIT_MS) {
                return { phase: "failed", failure: "propagation-timeout" };
            }
            return { phase: "propagating", failure: null };
        }
        default:
            return { phase: row.phase, failure: null };
    }
}

export type CutoverEffect =
    /** Write the record to the new value (Cloudflare). */
    | "write-record"
    /** Put the record's old values and TTL back (Cloudflare). */
    | "restore-record"
    /** Put the record's old TTL back, keeping its new value (Cloudflare). */
    | "restore-ttl"
    /** Hand the domain to the target service. */
    | "move-route"
    /** Hand the domain back to the source service. */
    | "move-route-back"
    /** Rewrite every edge's routes from the records. */
    | "republish";

/** What pressing Switch does. Empty when the phase does not allow it, so a second
 *  press - or a retry after a timeout - changes nothing. */
export function switchEffects(row: Pick<CutoverRow, "phase" | "mode">): CutoverEffect[] {
    if (!canSwitch(row.phase)) return [];
    if (row.mode === "edge") return ["move-route", "republish"];
    if (row.mode === "cloudflare") return ["write-record"];
    return [];
}

/** What a rollback undoes, from where the cutover got to. Empty once closed. */
export function rollbackEffects(row: Pick<CutoverRow, "phase" | "mode" | "switchedAt" | "oldTtl">): CutoverEffect[] {
    if (!canRollback(row.phase)) return [];
    const effects: CutoverEffect[] = [];
    if (row.mode === "edge") {
        if (row.switchedAt) effects.push("move-route-back");
    } else if (row.mode === "cloudflare" && (row.switchedAt || lowersTtl(row.mode, row.oldTtl))) {
        effects.push("restore-record");
    }
    // The staged route on the target's edge goes with the next publish either way.
    effects.push("republish");
    return effects;
}

/** What finishing does once both the resolvers and the new service agree. */
export function finishEffects(row: Pick<CutoverRow, "phase" | "mode" | "oldTtl">): CutoverEffect[] {
    if (row.phase !== "finishing") return [];
    if (row.mode === "edge") return [];
    const effects: CutoverEffect[] = ["move-route"];
    if (lowersTtl(row.mode, row.oldTtl)) effects.push("restore-ttl");
    effects.push("republish");
    return effects;
}

/** The record somebody changes by hand, as the screen shows it. */
export interface ManualRecord {
    readonly type: "A";
    readonly name: string;
    readonly value: string;
    readonly ttl: number;
}

export function manualRecord(hostname: string, value: string, ttl: number = LOWERED_TTL): ManualRecord {
    return { type: "A", name: hostname, value, ttl };
}

/** A stored JSON list of strings, read total: anything else is an empty list. */
export function readList(value: string | null | undefined): string[] {
    try {
        const parsed: unknown = JSON.parse(value ?? "[]");
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

export function readPhase(value: string): CutoverPhase {
    return (CUTOVER_PHASES as readonly string[]).includes(value) ? (value as CutoverPhase) : "failed";
}

export function readMode(value: string): CutoverMode {
    return value === "edge" || value === "cloudflare" ? value : "manual";
}
