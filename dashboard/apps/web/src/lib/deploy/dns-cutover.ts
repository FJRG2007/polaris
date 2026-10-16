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
 * - `checking` - the pre-flight is running; nothing can be switched yet.
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
    "checking",
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

/**
 * Which edge answers a service's hostname: this machine's for a service that runs
 * here or that was pointed at Polaris, else the edge of the server it runs on. Two
 * services with the same key are reached at the same address, so moving a name
 * between them needs no DNS change.
 */
export function edgeKey(
    target: { readonly kind: string; readonly hostId: string | null },
    servedBy: string
): string {
    if (target.kind === "local" || servedBy === "polaris" || !target.hostId) return "local";
    return `host:${target.hostId}`;
}

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
    | "route-move-failed"
    | "rollback-write-failed"
    | "rollback-route-failed"
    | "propagation-timeout";

/** What the pre-flight found about the target. */
export interface PreflightChecks {
    readonly deployed: boolean;
    readonly running: boolean;
    /** How the target answered for the hostname when asked directly. `skipped` when it
     *  shares the edge with the source, where asking would reach the source; `unknown`
     *  when nothing answered from here - a router that does not loop its own public
     *  address back looks exactly like that, so it warns rather than stops. */
    readonly answers: "up" | "down" | "not-routed" | "skipped" | "unknown";
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
    answers: z.enum(["up", "down", "not-routed", "skipped", "unknown"]),
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
    return phase === "checking" || phase === "lowering" || phase === "ready" || phase === "propagating" || phase === "failed";
}

/** Whether the target's edge carries a route for the hostname while the old one still
 *  serves it: from the start, so the pre-flight can ask it, until the cutover closes. */
export function stagesRoute(mode: CutoverMode, phase: CutoverPhase): boolean {
    return (
        mode !== "edge" &&
        (phase === "checking" || canSwitch(phase) || phase === "propagating" || phase === "finishing")
    );
}

/** An open cutover, as the edge reads it. */
export interface StagedCutover {
    readonly domainId: string;
    readonly targetApplicationId: string;
    readonly phase: string;
    readonly mode: string;
}

type EdgeTarget = { readonly kind: string; readonly hostId: string | null };

/**
 * Which hostnames are routed a second time, on the edge of the service they are
 * moving to, and to which service: each open cutover whose phase stages a route,
 * whose domain is published, and whose two services sit behind different edges -
 * behind one, two routers for one name would collide, and the cutover moves the
 * route itself instead. The edge's route file is rendered from what this returns.
 */
export function stagedRoutes<
    R extends { readonly id: string; readonly servedBy: string; readonly application: { readonly target: EdgeTarget } },
    T extends { readonly target: EdgeTarget }
>(rows: readonly R[], staged: readonly StagedCutover[], targets: ReadonlyMap<string, T>): { row: R; target: T }[] {
    const routed: { row: R; target: T }[] = [];
    for (const entry of staged) {
        if (!stagesRoute(readMode(entry.mode), readPhase(entry.phase))) continue;
        const row = rows.find((candidate) => candidate.id === entry.domainId);
        const target = targets.get(entry.targetApplicationId);
        if (!row || !target) continue;
        if (edgeKey(row.application.target, row.servedBy) === edgeKey(target.target, row.servedBy)) continue;
        routed.push({ row, target });
    }
    return routed;
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

/** What a rollback undoes, from where the cutover got to. Empty once closed.
 *  `touched` is a switch that began changing things and did not finish, which leaves
 *  `switchedAt` empty but still has to be undone. */
export function rollbackEffects(
    row: Pick<CutoverRow, "phase" | "mode" | "switchedAt" | "oldTtl"> & { readonly touched?: boolean }
): CutoverEffect[] {
    if (!canRollback(row.phase)) return [];
    const effects: CutoverEffect[] = [];
    const switched = row.switchedAt !== null || row.touched === true;
    if (row.mode === "edge") {
        if (switched) effects.push("move-route-back");
    } else if (row.mode === "cloudflare" && (switched || lowersTtl(row.mode, row.oldTtl))) {
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

const FAILURES: readonly CutoverFailure[] = [
    "same-service",
    "target-not-deployed",
    "target-not-running",
    "target-not-routed",
    "target-down",
    "no-address",
    "record-write-failed",
    "route-move-failed",
    "rollback-write-failed",
    "rollback-route-failed",
    "propagation-timeout"
];

export function readFailure(value: string | null): CutoverFailure | null {
    return value !== null && (FAILURES as readonly string[]).includes(value) ? (value as CutoverFailure) : null;
}

/** One public resolver's answer, as the screen lists it. */
export interface ResolverView {
    readonly label: string;
    readonly status: string;
    readonly values: string[];
    readonly agrees: boolean | null;
}

/** A cutover as the screen draws it: dates as ISO strings, every stored JSON read total. */
export interface CutoverView {
    readonly id: string;
    readonly hostname: string;
    readonly phase: CutoverPhase;
    readonly mode: CutoverMode;
    readonly failure: CutoverFailure | null;
    readonly sourceName: string;
    readonly targetName: string;
    readonly targetApplicationId: string;
    readonly newValue: string | null;
    readonly oldValues: string[];
    readonly oldTtl: number | null;
    readonly lowerUntil: string | null;
    readonly switchedAt: string | null;
    readonly finishedAt: string | null;
    readonly checkedAt: string | null;
    readonly preflight: PreflightChecks | null;
    readonly resolvers: ResolverView[];
    readonly targetStatus: { readonly status: "up" | "down"; readonly code: number | null } | null;
    readonly canSwitch: boolean;
    readonly canRollback: boolean;
}

const resolverSchema = z.object({
    label: z.string(),
    status: z.string(),
    values: z.array(z.string()),
    agrees: z.boolean().nullable()
});

const storedChecksSchema = z.object({
    preflight: preflightChecksSchema.optional().catch(undefined),
    propagation: z.object({ resolvers: z.array(resolverSchema) }).optional().catch(undefined),
    target: z
        .object({ status: z.enum(["up", "down"]), code: z.number().int().nullable() })
        .optional()
        .catch(undefined),
    checkedAt: z.string().optional().catch(undefined)
});

function readStoredChecks(value: string): z.infer<typeof storedChecksSchema> {
    try {
        const parsed = storedChecksSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** The screen's view of a stored cutover. */
export function cutoverView(
    row: {
        readonly id: string;
        readonly hostname: string;
        readonly phase: string;
        readonly mode: string;
        readonly failure: string | null;
        readonly targetApplicationId: string;
        readonly newValue: string | null;
        readonly oldValues: string;
        readonly oldTtl: number | null;
        readonly checks: string;
        readonly lowerUntil: Date | null;
        readonly switchedAt: Date | null;
        readonly finishedAt: Date | null;
    },
    names: { readonly source: string; readonly target: string }
): CutoverView {
    const phase = readPhase(row.phase);
    const checks = readStoredChecks(row.checks);
    return {
        id: row.id,
        hostname: row.hostname,
        phase,
        mode: readMode(row.mode),
        failure: readFailure(row.failure),
        sourceName: names.source,
        targetName: names.target,
        targetApplicationId: row.targetApplicationId,
        newValue: row.newValue,
        oldValues: readList(row.oldValues),
        oldTtl: row.oldTtl,
        lowerUntil: row.lowerUntil?.toISOString() ?? null,
        switchedAt: row.switchedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        checkedAt: checks.checkedAt ?? null,
        preflight: checks.preflight ?? null,
        resolvers: checks.propagation?.resolvers ?? [],
        targetStatus: checks.target ?? null,
        canSwitch: canSwitch(phase),
        canRollback: canRollback(phase)
    };
}

/** How long a screen waits between asking an open cutover to look again. */
export const SCREEN_CHECK_GAP_MS = 15_000;

/** Whether a screen's visit should run a check now rather than wait for the pass:
 *  only while something is being waited on, and not more often than the gap. */
export function screenShouldCheck(phase: CutoverPhase, checkedAt: Date | null, now: Date): boolean {
    if (phase !== "lowering" && phase !== "propagating" && phase !== "finishing") return false;
    return checkedAt === null || now.getTime() - checkedAt.getTime() >= SCREEN_CHECK_GAP_MS;
}
