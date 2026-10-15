/**
 * Uptime arithmetic: one day's bar from the checks' daily rollups, a
 * component's current state from its checks' last results, and the page's from
 * its components. Pure.
 */

/** How many days of bars a page shows. */
export const HISTORY_DAYS = 90;

/** How long single results are kept before only the day's rollup is left. */
export const SAMPLE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How long daily rollups are kept: the bars plus a margin. */
export const DAY_RETENTION_DAYS = HISTORY_DAYS + 10;

export type DayTone = "none" | "ok" | "degraded" | "down";
export type ComponentState = "operational" | "degraded" | "down" | "maintenance" | "unknown";

export interface DayRollup {
    readonly day: string;
    readonly total: number;
    readonly up: number;
}

export interface DayBar {
    readonly day: string;
    readonly tone: DayTone;
    /** Share of runs that were up, 0 to 1; null when nothing ran that day. */
    readonly ratio: number | null;
}

/** The UTC day an instant falls on, as `YYYY-MM-DD`. */
export function dayKey(at: Date): string {
    return at.toISOString().slice(0, 10);
}

/** The UTC midnight of an instant, as the `StatusDay.day` column stores it. */
export function dayStart(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** How a day reads from its share of up runs. */
export function dayTone(ratio: number | null): DayTone {
    if (ratio === null) return "none";
    if (ratio >= 0.999) return "ok";
    if (ratio >= 0.95) return "degraded";
    return "down";
}

/**
 * The last `days` bars, oldest first, ending today. Rollups of several checks on
 * the same day are summed, so a component's bar weighs each run equally.
 */
export function dayBars(rollups: readonly DayRollup[], now: Date, days = HISTORY_DAYS): DayBar[] {
    const sums = new Map<string, { total: number; up: number }>();
    for (const row of rollups) {
        const sum = sums.get(row.day) ?? { total: 0, up: 0 };
        sum.total += row.total;
        sum.up += row.up;
        sums.set(row.day, sum);
    }
    const today = dayStart(now).getTime();
    const bars: DayBar[] = [];
    for (let back = days - 1; back >= 0; back--) {
        const key = dayKey(new Date(today - back * 86_400_000));
        const sum = sums.get(key);
        const ratio = sum && sum.total > 0 ? sum.up / sum.total : null;
        bars.push({ day: key, tone: dayTone(ratio), ratio });
    }
    return bars;
}

/** Uptime over the bars as a percentage with two decimals, or null with no data. */
export function uptimePercent(rollups: readonly DayRollup[]): number | null {
    let total = 0;
    let up = 0;
    for (const row of rollups) {
        total += row.total;
        up += row.up;
    }
    if (total === 0) return null;
    return Math.floor((up / total) * 10_000) / 100;
}

/** A component's state now, from its checks' last results and whether a
 *  maintenance window covers it. */
export function componentState(
    lastStatuses: readonly (string | null)[],
    inMaintenance: boolean
): ComponentState {
    if (inMaintenance) return "maintenance";
    const known = lastStatuses.filter((status): status is string => status !== null);
    if (known.length === 0) return "unknown";
    const down = known.filter((status) => status === "down").length;
    if (down === 0) return "operational";
    return down === known.length ? "down" : "degraded";
}

const SEVERITY: Readonly<Record<ComponentState, number>> = {
    unknown: 0,
    operational: 1,
    maintenance: 2,
    degraded: 3,
    down: 4
};

/** The page's headline: its worst component. */
export function pageState(states: readonly ComponentState[]): ComponentState {
    let worst: ComponentState = "unknown";
    for (const state of states) if (SEVERITY[state] > SEVERITY[worst]) worst = state;
    return worst;
}

/** Folds one run into a day's rollup, the way the runner's upsert does. */
export function foldRun(
    day: { total: number; up: number; latencySum: number },
    ok: boolean,
    latencyMs: number | null
): { total: number; up: number; latencySum: number } {
    return {
        total: day.total + 1,
        up: day.up + (ok ? 1 : 0),
        latencySum: day.latencySum + (ok && latencyMs !== null ? latencyMs : 0)
    };
}
