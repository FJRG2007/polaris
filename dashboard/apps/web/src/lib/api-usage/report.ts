/**
 * Keys' usage over a window, summed in the database from the hourly rows: one
 * key's for the screen behind it, every key of an account's for the overview.
 *
 * Every read is a GROUP BY on the keys' own rows inside the window, through the
 * primary key (key first, hour second): calls over time, by route, by status,
 * by key, and who called (lib/api-usage/callers).
 * The only work left here is folding hours into days for the long windows and
 * reading percentiles off the summed latency histogram.
 */

import { prisma } from "@polaris/db";
import type { UsageRange } from "./ranges";
import { callerReport, type CallerShare } from "./callers";
import { LATENCY_BOUNDS, LATENCY_COLUMNS, hourOf, type LatencyColumn } from "./recorder";

export { USAGE_RANGES, type UsageRange } from "./ranges";

const RANGE_HOURS: Record<UsageRange, number> = {
    "24h": 24,
    "7d": 24 * 7,
    "30d": 24 * 30,
    "90d": 24 * 90
};
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A percentile read off the histogram: `over` when it fell past the last bound. */
export interface Percentile {
    ms: number;
    over: boolean;
}

export interface UsagePoint {
    t: number;
    calls: number;
    errors: number;
}

export interface RouteUsage {
    method: string;
    route: string;
    calls: number;
    errors: number;
    p50: Percentile | null;
    p95: Percentile | null;
    p99: Percentile | null;
}

/** One key's share of a report across several. */
export interface KeyShare {
    apiKeyId: string;
    calls: number;
    errors: number;
    p50: Percentile | null;
    p95: Percentile | null;
}

export interface KeyUsageReport {
    range: UsageRange;
    from: number;
    to: number;
    bucket: "hour" | "day";
    total: number;
    classes: { success: number; client: number; server: number };
    p50: Percentile | null;
    p95: Percentile | null;
    p99: Percentile | null;
    series: UsagePoint[];
    routes: RouteUsage[];
    statuses: { status: number; calls: number }[];
    /** Every key with calls in the window, busiest first; empty for one key's report. */
    keys: KeyShare[];
    /** The calling programs' families, busiest first. */
    clients: CallerShare[];
    /** The addresses called from, busiest first; masked unless the report was revealed. */
    addresses: CallerShare[];
    /** Calls with no caller recorded (made before callers were counted). */
    unrecorded: number;
}

/** The most routes and keys a report lists; the rest are summed as "other". */
export const REPORT_ROWS = 50;

type Histogram = Record<LatencyColumn, number>;

/**
 * The q-th percentile of a latency histogram, interpolated linearly inside the
 * bucket it falls in - the estimate histogram-based monitoring settled on
 * (Prometheus' histogram_quantile). Null when there were no calls.
 */
export function percentile(histogram: Histogram, q: number): Percentile | null {
    const total = LATENCY_COLUMNS.reduce((sum, column) => sum + histogram[column], 0);
    if (total === 0) return null;
    const rank = q * total;
    let seen = 0;
    for (let index = 0; index < LATENCY_COLUMNS.length; index++) {
        const count = histogram[LATENCY_COLUMNS[index]!];
        if (count > 0 && seen + count >= rank) {
            if (index >= LATENCY_BOUNDS.length)
                return { ms: LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1]!, over: true };
            const lower = index === 0 ? 0 : LATENCY_BOUNDS[index - 1]!;
            const upper = LATENCY_BOUNDS[index]!;
            return {
                ms: Math.round(lower + ((upper - lower) * (rank - seen)) / count),
                over: false
            };
        }
        seen += count;
    }
    return { ms: LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1]!, over: true };
}

function histogramOf(sums: Partial<Record<LatencyColumn, number | null>>): Histogram {
    return Object.fromEntries(
        LATENCY_COLUMNS.map((column) => [column, sums[column] ?? 0])
    ) as Histogram;
}

const SUM_LATENCY = Object.fromEntries(LATENCY_COLUMNS.map((column) => [column, true])) as Record<
    LatencyColumn,
    true
>;

/** Empty points for every bucket of the window, so a quiet hour is a zero and not a gap. */
export function emptySeries(from: number, to: number, step: number): UsagePoint[] {
    const points: UsagePoint[] = [];
    for (let t = from; t <= to; t += step) points.push({ t, calls: 0, errors: 0 });
    return points;
}

/** Fold per-hour sums into the window's buckets. */
export function foldSeries(
    rows: { hour: Date; calls: number; errors: number }[],
    from: number,
    to: number,
    step: number
): UsagePoint[] {
    const points = emptySeries(from, to, step);
    for (const row of rows) {
        const index = Math.floor((row.hour.getTime() - from) / step);
        const point = points[index];
        if (!point) continue;
        point.calls += row.calls;
        point.errors += row.errors;
    }
    return points;
}

/** A range's buckets and its first and last, the hours or days the report spans. */
function windowOf(range: UsageRange, now: Date) {
    const hours = RANGE_HOURS[range];
    const bucket: "hour" | "day" = hours > 24 * 7 ? "day" : "hour";
    const step = bucket === "day" ? DAY_MS : HOUR_MS;
    const lastHour = hourOf(now).getTime();
    const to = bucket === "day" ? Math.floor(lastHour / DAY_MS) * DAY_MS : lastHour;
    const from = to - (bucket === "day" ? hours / 24 - 1 : hours - 1) * step;
    return { bucket, step, from, to };
}

/** Where a range's report starts, in ms: the same window the report reads. */
export function windowStart(range: UsageRange, now = new Date()): number {
    return windowOf(range, now).from;
}

export function keyUsageReport(
    keyId: string,
    range: UsageRange,
    now = new Date(),
    reveal = false
): Promise<KeyUsageReport> {
    return usageReport([keyId], range, { now, reveal });
}

/**
 * Several keys' usage summed as one, with each key's share unless `shares` is
 * off (one key's own screen). The keys are the caller's to choose - an
 * account's own - and the list is bounded by what one account holds.
 */
export async function usageReport(
    keyIds: readonly string[],
    range: UsageRange,
    options: { now?: Date; shares?: boolean; reveal?: boolean } = {}
): Promise<KeyUsageReport> {
    const { bucket, step, from, to } = windowOf(range, options.now ?? new Date());
    const where = {
        apiKeyId: keyIds.length === 1 ? keyIds[0]! : { in: [...keyIds] },
        hour: { gte: new Date(from) }
    };
    const failed = { ...where, status: { gte: 400 } };
    const several = options.shares ?? keyIds.length > 1;

    const [byHour, errorsByHour, byRoute, errorsByRoute, byStatus, all, byKey, errorsByKey, callers] =
        await Promise.all([
            prisma.apiKeyCallHour.groupBy({ by: ["hour"], where, _sum: { calls: true } }),
            prisma.apiKeyCallHour.groupBy({ by: ["hour"], where: failed, _sum: { calls: true } }),
            prisma.apiKeyCallHour.groupBy({
                by: ["method", "route"],
                where,
                _sum: { calls: true, ...SUM_LATENCY },
                orderBy: { _sum: { calls: "desc" } },
                take: REPORT_ROWS
            }),
            prisma.apiKeyCallHour.groupBy({
                by: ["method", "route"],
                where: failed,
                _sum: { calls: true }
            }),
            prisma.apiKeyCallHour.groupBy({
                by: ["status"],
                where,
                _sum: { calls: true },
                orderBy: { status: "asc" }
            }),
            // The whole window's latency, routes past the listed ones included.
            prisma.apiKeyCallHour.aggregate({ where, _sum: SUM_LATENCY }),
            several
                ? prisma.apiKeyCallHour.groupBy({
                      by: ["apiKeyId"],
                      where,
                      _sum: { calls: true, ...SUM_LATENCY },
                      orderBy: { _sum: { calls: "desc" } },
                      take: REPORT_ROWS
                  })
                : Promise.resolve([]),
            several
                ? prisma.apiKeyCallHour.groupBy({
                      by: ["apiKeyId"],
                      where: failed,
                      _sum: { calls: true }
                  })
                : Promise.resolve([]),
            callerReport(keyIds, new Date(from), { reveal: options.reveal })
        ]);

    const errorsAt = new Map(errorsByHour.map((row) => [row.hour.getTime(), row._sum.calls ?? 0]));
    const series = foldSeries(
        byHour.map((row) => ({
            hour: row.hour,
            calls: row._sum.calls ?? 0,
            errors: errorsAt.get(row.hour.getTime()) ?? 0
        })),
        from,
        to,
        step
    );

    const routeErrors = new Map(
        errorsByRoute.map((row) => [`${row.method} ${row.route}`, row._sum.calls ?? 0])
    );
    const overall = histogramOf(all._sum);
    const routes = byRoute.map((row): RouteUsage => {
        const histogram = histogramOf(row._sum);
        return {
            method: row.method,
            route: row.route,
            calls: row._sum.calls ?? 0,
            errors: routeErrors.get(`${row.method} ${row.route}`) ?? 0,
            p50: percentile(histogram, 0.5),
            p95: percentile(histogram, 0.95),
            p99: percentile(histogram, 0.99)
        };
    });

    const keyErrors = new Map(errorsByKey.map((row) => [row.apiKeyId, row._sum.calls ?? 0]));
    const statuses = byStatus.map((row) => ({ status: row.status, calls: row._sum.calls ?? 0 }));
    const classes = { success: 0, client: 0, server: 0 };
    for (const row of statuses) {
        if (row.status >= 500) classes.server += row.calls;
        else if (row.status >= 400) classes.client += row.calls;
        else classes.success += row.calls;
    }

    const total = statuses.reduce((sum, row) => sum + row.calls, 0);
    return {
        range,
        from,
        to,
        bucket,
        total,
        classes,
        p50: percentile(overall, 0.5),
        p95: percentile(overall, 0.95),
        p99: percentile(overall, 0.99),
        series,
        routes,
        statuses,
        keys: byKey.map((row): KeyShare => {
            const histogram = histogramOf(row._sum);
            return {
                apiKeyId: row.apiKeyId,
                calls: row._sum.calls ?? 0,
                errors: keyErrors.get(row.apiKeyId) ?? 0,
                p50: percentile(histogram, 0.5),
                p95: percentile(histogram, 0.95)
            };
        }),
        clients: callers.clients,
        addresses: callers.addresses,
        unrecorded: Math.max(0, total - callers.recorded)
    };
}
