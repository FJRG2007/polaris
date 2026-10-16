/**
 * The rollout rules, as pure functions: which server goes in which wave, what an
 * updated server has to show before it counts, and when a wave is done or the
 * whole rollout has to stop. Everything that touches a database or a server is
 * in `service.ts`; this file only decides, so every rule is a plain test.
 */

export type TargetState = "pending" | "updating" | "verifying" | "healthy" | "failed" | "skipped";

/** Why a server is left out of a rollout, or why it failed one. */
export type TargetReason =
    | "no-agent"
    | "pinned"
    | "current"
    | "timeout"
    | "heartbeat"
    | "version"
    | "refused";

/** Canary one server, then a tenth, half, and everyone. */
export const DEFAULT_WAVES: readonly number[] = [1, 10, 50, 100];
export const DEFAULT_HEALTH_MINUTES = 10;
/** The longest an update may take before the server is counted as failed. */
export const UPDATE_TIMEOUT_MS = 30 * 60_000;
/** A heartbeat older than this means the server stopped answering. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
export const MAX_WAVES = 8;

export interface PlanServer {
    readonly id: string;
    /** What the agent reports; null for a server that runs none. */
    readonly version: string | null;
    readonly pinnedVersion: string | null;
}

export interface PlannedTarget {
    readonly serverId: string;
    readonly wave: number;
    readonly state: "pending" | "skipped";
    readonly fromVersion: string | null;
    readonly reason: TargetReason | null;
}

/**
 * Read a stored wave list, falling back to the default for anything malformed.
 * The first entry is a server count (the canary); every later one is the
 * cumulative percentage of servers reached once that wave is done.
 */
export function parseWaves(raw: unknown): number[] {
    let value = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return [...DEFAULT_WAVES];
        }
    }
    return validWaves(value) ? [...value] : [...DEFAULT_WAVES];
}

export function validWaves(value: unknown): value is number[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WAVES) return false;
    if (!value.every((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 100)) {
        return false;
    }
    for (let index = 2; index < value.length; index++) {
        if (value[index] <= value[index - 1]) return false;
    }
    return value.length === 1 || value[value.length - 1] === 100;
}

/** How many servers have been reached once each wave is done (cumulative). */
export function waveSizes(total: number, waves: readonly number[]): number[] {
    if (total <= 0) return [];
    const sizes: number[] = [];
    let reached = 0;
    waves.forEach((entry, index) => {
        const want = index === 0 ? Math.min(entry, total) : Math.ceil((total * entry) / 100);
        const next = Math.min(total, Math.max(reached, want));
        if (next > reached) sizes.push(next);
        reached = next;
    });
    if (reached < total) sizes.push(total);
    return sizes;
}

/**
 * Put every server in a wave or say why it is left out. Servers that run no
 * agent, that are pinned to another version, or that already run this one are
 * skipped; the rest are ordered by id so a re-plan puts them back in the same
 * waves.
 */
export function planRollout(
    servers: readonly PlanServer[],
    version: string,
    waves: readonly number[]
): PlannedTarget[] {
    const skipped: PlannedTarget[] = [];
    const eligible: PlanServer[] = [];
    for (const server of servers) {
        const reason: TargetReason | null =
            server.version === null
                ? "no-agent"
                : server.pinnedVersion !== null && server.pinnedVersion !== version
                  ? "pinned"
                  : server.version === version
                    ? "current"
                    : null;
        if (reason) {
            skipped.push({
                serverId: server.id,
                wave: -1,
                state: "skipped",
                fromVersion: server.version,
                reason
            });
        } else eligible.push(server);
    }
    eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sizes = waveSizes(eligible.length, waves);
    const planned: PlannedTarget[] = eligible.map((server, index) => ({
        serverId: server.id,
        wave: sizes.findIndex((size) => index < size),
        state: "pending",
        fromVersion: server.version,
        reason: null
    }));
    return [...planned, ...skipped];
}

/** The version most eligible servers run now: what a rollback returns to. */
export function previousVersion(servers: readonly PlanServer[], version: string): string | null {
    const counts = new Map<string, number>();
    for (const server of servers) {
        if (server.version && server.version !== version) {
            counts.set(server.version, (counts.get(server.version) ?? 0) + 1);
        }
    }
    let best: string | null = null;
    for (const [candidate, count] of counts) {
        if (best === null || count > (counts.get(best) ?? 0)) best = candidate;
    }
    return best;
}

export interface TargetSnapshot {
    readonly state: TargetState;
    readonly startedAt: Date | null;
    readonly healthySince: Date | null;
}

export interface Observation {
    readonly version: string | null;
    readonly heartbeatAt: Date | null;
}

export interface GateConfig {
    readonly version: string;
    readonly healthMs: number;
    readonly updateTimeoutMs?: number;
    readonly heartbeatStaleMs?: number;
}

export interface TargetStep {
    readonly state: TargetState;
    readonly healthySince: Date | null;
    readonly reason: TargetReason | null;
}

/**
 * Move one updating or verifying server along. It counts as healthy only once
 * it reports the rollout's version and has kept answering for the whole health
 * window; losing the heartbeat or the version on the way fails it, and so does
 * never reporting the version at all.
 */
export function stepTarget(
    target: TargetSnapshot,
    observed: Observation,
    now: Date,
    config: GateConfig
): TargetStep {
    const same: TargetStep = {
        state: target.state,
        healthySince: target.healthySince,
        reason: null
    };
    const staleAfter = config.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
    const fresh =
        observed.heartbeatAt !== null &&
        now.getTime() - observed.heartbeatAt.getTime() <= staleAfter;
    if (target.state === "updating") {
        if (observed.version === config.version && fresh) {
            return { state: "verifying", healthySince: now, reason: null };
        }
        const started = target.startedAt?.getTime() ?? now.getTime();
        if (now.getTime() - started > (config.updateTimeoutMs ?? UPDATE_TIMEOUT_MS)) {
            return { state: "failed", healthySince: null, reason: "timeout" };
        }
        return same;
    }
    if (target.state === "verifying") {
        if (!fresh) return { state: "failed", healthySince: null, reason: "heartbeat" };
        if (observed.version !== config.version) {
            return { state: "failed", healthySince: null, reason: "version" };
        }
        const since = target.healthySince ?? now;
        if (now.getTime() - since.getTime() >= config.healthMs) {
            return { state: "healthy", healthySince: since, reason: null };
        }
        return { state: "verifying", healthySince: since, reason: null };
    }
    return same;
}

/** A wave is done when every server in it is healthy or was skipped, and the
 *  rollout halts the moment any one of them fails. */
export function waveVerdict(states: readonly TargetState[]): "advance" | "halt" | "wait" {
    if (states.includes("failed")) return "halt";
    return states.every((state) => state === "healthy" || state === "skipped")
        ? "advance"
        : "wait";
}

/** Servers a rollback leaves pinned to the previous version: the ones it reached. */
export function rollbackPins(
    targets: readonly { serverId: string; state: TargetState }[]
): string[] {
    return targets
        .filter((target) => ["updating", "verifying", "healthy", "failed"].includes(target.state))
        .map((target) => target.serverId);
}
