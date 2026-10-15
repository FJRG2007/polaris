/**
 * One key's usage over a window, summed in the database from the hourly rows.
 *
 * Every read is a GROUP BY on the key's own rows inside the window, through the
 * primary key (key first, hour second): calls over time, by route, by status.
 * The only work left here is folding hours into days for the long windows and
 * reading percentiles off the summed latency histogram.
 */

import { prisma } from "@polaris/db";
import type { UsageRange } from "./ranges";
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
    series: UsagePoint[];
    routes: RouteUsage[];
    statuses: { status: number; calls: number }[];
}

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

export async function keyUsageReport(
    keyId: string,
    range: UsageRange,
    now = new Date()
): Promise<KeyUsageReport> {
    const hours = RANGE_HOURS[range];
    const bucket = hours > 24 * 7 ? "day" : "hour";
    const step = bucket === "day" ? DAY_MS : HOUR_MS;
    const lastHour = hourOf(now).getTime();
    const to = bucket === "day" ? Math.floor(lastHour / DAY_MS) * DAY_MS : lastHour;
    const from = to - (bucket === "day" ? hours / 24 - 1 : hours - 1) * step;
    const where = { apiKeyId: keyId, hour: { gte: new Date(from) } };
    const failed = { ...where, status: { gte: 400 } };

    const [byHour, errorsByHour, byRoute, errorsByRoute, byStatus] = await Promise.all([
        prisma.apiKeyCallHour.groupBy({ by: ["hour"], where, _sum: { calls: true } }),
        prisma.apiKeyCallHour.groupBy({ by: ["hour"], where: failed, _sum: { calls: true } }),
        prisma.apiKeyCallHour.groupBy({
            by: ["method", "route"],
            where,
            _sum: { calls: true, ...SUM_LATENCY },
            orderBy: { _sum: { calls: "desc" } },
            take: 50
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
        })
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
    const overall = histogramOf({});
    const routes = byRoute.map((row): RouteUsage => {
        const histogram = histogramOf(row._sum);
        for (const column of LATENCY_COLUMNS) overall[column] += histogram[column];
        return {
            method: row.method,
            route: row.route,
            calls: row._sum.calls ?? 0,
            errors: routeErrors.get(`${row.method} ${row.route}`) ?? 0,
            p50: percentile(histogram, 0.5),
            p95: percentile(histogram, 0.95)
        };
    });

    const statuses = byStatus.map((row) => ({ status: row.status, calls: row._sum.calls ?? 0 }));
    const classes = { success: 0, client: 0, server: 0 };
    for (const row of statuses) {
        if (row.status >= 500) classes.server += row.calls;
        else if (row.status >= 400) classes.client += row.calls;
        else classes.success += row.calls;
    }

    return {
        range,
        from,
        to,
        bucket,
        total: statuses.reduce((sum, row) => sum + row.calls, 0),
        classes,
        p50: percentile(overall, 0.5),
        p95: percentile(overall, 0.95),
        series,
        routes,
        statuses
    };
}
