/**
 * Where the timings of a project's pages and requests are kept, and how a slow
 * one becomes an issue.
 *
 * Nothing here is a row per transaction. A transaction adds one value to an
 * hourly histogram of its route per measurement it carried, which is one upsert
 * whatever the traffic; the hours older than two days are folded into days, and
 * the days are kept a year, as the daily issue counts are. The only transactions
 * kept whole are a few slow ones per route, for somebody to read the spans of,
 * and those go with the project's retention.
 *
 * A slow route is reported through `captureEvent`, as one more event of an issue
 * of its own: assigning it, resolving it, ignoring it and alerting on it are the
 * same buttons and rules as for a crash, because they are the same thing - work
 * somebody has to pick up.
 */

import type * as core from "@polaris/core";
import { Prisma, prisma } from "@polaris/db";
import * as perf from "@/lib/telemetry/performance";
import { captureEvent, type IngestProject } from "@/lib/telemetry/store";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Hourly buckets older than this are folded into their day. */
const HOURS_KEPT_MS = 2 * DAY;
/** How far back "usual" looks, beyond the last day. */
const BASELINE_MS = 7 * DAY;
/** How many slow transactions each route keeps whole. */
export const SAMPLES_PER_ROUTE = 20;
/** Routes one pass of the job looks at, and how many passes it may make. */
const BATCH = 200;
const MAX_BATCHES = 5;
/** A slow route is told to its issue at most this often. */
const FLAG_EVERY_MS = HOUR;

interface BucketWrite {
    readonly routeId: string;
    readonly metric: string;
    readonly grain: number;
    readonly at: Date;
    readonly count: number;
    readonly sum: number;
    readonly hist: readonly number[];
}

/**
 * Add histograms to their buckets in one statement. Two writers at once add
 * rather than overwrite, element by element, which is what makes an ingest under
 * load and the job folding hours into days safe to run side by side.
 */
async function addBuckets(
    rows: readonly BucketWrite[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(
        (row) =>
            Prisma.sql`(gen_random_uuid(), ${row.routeId}::uuid, ${row.metric}, ${row.grain}, ${row.at}, ${row.count}, ${row.sum}, ${[...row.hist]}::int[])`
    );
    await client.$executeRaw`
        INSERT INTO "TelemetryPerfBucket" ("id", "routeId", "metric", "grain", "at", "count", "sum", "hist")
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("routeId", "metric", "grain", "at") DO UPDATE SET
            "count" = "TelemetryPerfBucket"."count" + EXCLUDED."count",
            "sum" = "TelemetryPerfBucket"."sum" + EXCLUDED."sum",
            "hist" = ARRAY(
                SELECT COALESCE(a.v, 0) + COALESCE(b.v, 0)
                FROM unnest("TelemetryPerfBucket"."hist") WITH ORDINALITY AS a(v, i)
                FULL JOIN unnest(EXCLUDED."hist") WITH ORDINALITY AS b(v, i) ON a.i = b.i
                ORDER BY COALESCE(a.i, b.i)
            )`;
}

/** The start of the hour a value is counted in. A clock that is off by more
 *  than a day is counted now, so a late or future timestamp never lands in an
 *  hour that has already been folded away. */
function hourOf(at: Date, now: Date): Date {
    const when = Math.abs(now.getTime() - at.getTime()) > DAY ? now : at;
    return new Date(Math.floor(when.getTime() / HOUR) * HOUR);
}

/**
 * Store one transaction. Never throws, for the reason `captureEvent` does not:
 * the client is answered 200 whatever happens here.
 */
export async function recordTransaction(
    project: IngestProject,
    reading: perf.PerfReading,
    now: Date = new Date()
): Promise<void> {
    try {
        const route = await prisma.telemetryPerfRoute.upsert({
            where: { projectId_op_name: { projectId: project.id, op: reading.op, name: reading.name } },
            create: { projectId: project.id, op: reading.op, name: reading.name, lastSeen: now },
            update: { lastSeen: now },
            select: { id: true, p95: true, metric: true, targetMs: true }
        });
        const at = hourOf(reading.at, now);
        await addBuckets(
            Object.entries(reading.values).map(([metric, value]) => ({
                routeId: route.id,
                metric,
                grain: 60,
                at,
                count: 1,
                sum: value,
                hist: perf.histogramOf(value)
            }))
        );

        // Kept whole only when it is among the slow ones: past the route's p95
        // once it has one, past its target before then. The job trims what
        // this lets through to the slowest few.
        const judged = reading.values[route.metric as perf.PerfMetric] ?? reading.durationMs;
        const bar = route.p95 ?? route.targetMs ?? perf.defaultTarget(reading.op, route.metric as perf.PerfMetric);
        if (judged >= bar) {
            await prisma.telemetryPerfSample.create({
                data: {
                    projectId: project.id,
                    routeId: route.id,
                    eventId: reading.eventId,
                    durationMs: reading.durationMs,
                    release: reading.release,
                    environment: reading.environment,
                    url: reading.url?.slice(0, 2000) ?? null,
                    detail: JSON.stringify({ spans: reading.spans, values: reading.values, method: reading.method }),
                    at: reading.at
                }
            });
        }
    } catch (error) {
        console.error("polaris: could not store a telemetry transaction:", error);
    }
}

/** Store one INP report against the page load of its route. Never throws. */
export async function recordInteraction(
    project: IngestProject,
    reading: { name: string; value: number; at: Date },
    now: Date = new Date()
): Promise<void> {
    try {
        const route = await prisma.telemetryPerfRoute.upsert({
            where: { projectId_op_name: { projectId: project.id, op: "pageload", name: reading.name } },
            create: { projectId: project.id, op: "pageload", name: reading.name, lastSeen: now },
            update: {},
            select: { id: true }
        });
        await addBuckets([
            {
                routeId: route.id,
                metric: "inp",
                grain: 60,
                at: hourOf(reading.at, now),
                count: 1,
                sum: reading.value,
                hist: perf.histogramOf(reading.value)
            }
        ]);
    } catch (error) {
        console.error("polaris: could not store a telemetry interaction:", error);
    }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/** What the histograms of a route say over the last day and the week before. */
export interface WindowStats {
    readonly recent: number[];
    readonly baseline: number[];
}

/** Split a route's buckets into the last day and the week before it, per metric. */
export function windowStats(
    buckets: readonly { metric: string; at: Date; hist: readonly number[] }[],
    now: Date
): Map<string, WindowStats> {
    const dayAgo = now.getTime() - DAY;
    const out = new Map<string, WindowStats>();
    for (const bucket of buckets) {
        const current = out.get(bucket.metric) ?? { recent: [], baseline: [] };
        const recent = bucket.at.getTime() >= dayAgo;
        out.set(bucket.metric, {
            recent: recent ? perf.mergeHistograms(current.recent, bucket.hist) : current.recent,
            baseline: recent ? current.baseline : perf.mergeHistograms(current.baseline, bucket.hist)
        });
    }
    return out;
}

const total = (hist: readonly number[]): number => hist.reduce((sum, count) => sum + count, 0);

/** Fold hourly buckets older than two days into their day, then drop them. */
async function foldHours(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - HOURS_KEPT_MS);
    let folded = 0;
    for (let pass = 0; pass < MAX_BATCHES; pass++) {
        const hours = await prisma.telemetryPerfBucket.findMany({
            where: { grain: 60, at: { lt: cutoff } },
            orderBy: { at: "asc" },
            take: 2000,
            select: { id: true, routeId: true, metric: true, at: true, count: true, sum: true, hist: true }
        });
        if (hours.length === 0) break;
        const days = new Map<string, BucketWrite>();
        for (const hour of hours) {
            const day = new Date(Math.floor(hour.at.getTime() / DAY) * DAY);
            const key = `${hour.routeId}|${hour.metric}|${day.getTime()}`;
            const seen = days.get(key);
            days.set(key, {
                routeId: hour.routeId,
                metric: hour.metric,
                grain: 1440,
                at: day,
                count: (seen?.count ?? 0) + hour.count,
                sum: (seen?.sum ?? 0) + hour.sum,
                hist: perf.mergeHistograms(seen?.hist ?? [], hour.hist)
            });
        }
        // One transaction, so a pass that dies half way neither counts an hour
        // twice nor loses it.
        await prisma.$transaction(async (tx) => {
            await addBuckets([...days.values()], tx);
            await tx.telemetryPerfBucket.deleteMany({ where: { id: { in: hours.map((hour) => hour.id) } } });
        });
        folded += hours.length;
        if (hours.length < 2000) break;
    }
    return folded;
}

function slowEvent(
    route: { id: string; name: string; op: string },
    metric: perf.PerfMetric,
    reason: perf.SlowReason,
    numbers: { p75: number | null; target: number; baseline: number | null; inp: number | null },
    now: Date
): core.CapturedEvent {
    const shown =
        reason === "inp"
            ? `INP p75 ${perf.formatMs(numbers.inp)} > ${perf.formatMs(perf.VITAL_TARGETS.inp)}`
            : reason === "regression"
              ? `p75 ${perf.formatMetric(metric, numbers.p75)}, usually ${perf.formatMetric(metric, numbers.baseline)}`
              : `p75 ${perf.formatMetric(metric, numbers.p75)} > ${perf.formatMetric(metric, numbers.target)}`;
    return {
        eventId: null,
        level: "warning",
        type: `slow.${route.op}`,
        value: `${route.name} - ${shown}`,
        culprit: route.name,
        platform: null,
        release: null,
        environment: null,
        serverName: null,
        transaction: route.name,
        url: null,
        method: null,
        user: null,
        userKey: null,
        tags: {
            "performance.route": route.id,
            "performance.op": route.op,
            "performance.metric": metric,
            "performance.reason": reason,
            "performance.p75": String(Math.round(numbers.p75 ?? 0)),
            "performance.target": String(numbers.target)
        },
        frames: [],
        breadcrumbs: [],
        contexts: [],
        request: null,
        sdk: null,
        ip: null,
        at: now,
        fingerprint: `performance:${route.id}`
    };
}

/** Work out one batch of routes' percentiles and flag the slow ones. */
async function evaluateBatch(now: Date): Promise<{ evaluated: number; flagged: number }> {
    const dayAgo = new Date(now.getTime() - DAY);
    const routes = await prisma.telemetryPerfRoute.findMany({
        where: {
            lastSeen: { gte: dayAgo },
            OR: [{ evaluatedAt: null }, { evaluatedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) } }]
        },
        orderBy: [{ evaluatedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: BATCH,
        select: {
            id: true,
            projectId: true,
            name: true,
            op: true,
            targetMs: true,
            flaggedAt: true,
            project: { select: { perfTargetMs: true, platform: true } }
        }
    });
    if (routes.length === 0) return { evaluated: 0, flagged: 0 };

    const buckets = await prisma.telemetryPerfBucket.findMany({
        where: {
            routeId: { in: routes.map((route) => route.id) },
            metric: { in: ["duration", "lcp", "inp"] },
            at: { gte: new Date(now.getTime() - DAY - BASELINE_MS) }
        },
        select: { routeId: true, metric: true, at: true, hist: true }
    });
    const byRoute = new Map<string, typeof buckets>();
    for (const bucket of buckets) byRoute.set(bucket.routeId, [...(byRoute.get(bucket.routeId) ?? []), bucket]);

    let flagged = 0;
    for (const route of routes) {
        const stats = windowStats(byRoute.get(route.id) ?? [], now);
        const metric = perf.primaryMetric(route.op, total(stats.get("lcp")?.recent ?? []) > 0);
        const window = stats.get(metric) ?? { recent: [], baseline: [] };
        const inp = stats.get("inp")?.recent ?? [];
        const target = perf.effectiveTarget({
            op: route.op,
            metric,
            routeTarget: route.targetMs,
            projectTarget: route.project.perfTargetMs
        });
        const numbers = {
            count: total(window.recent),
            p50: perf.percentile(window.recent, 0.5),
            p75: perf.percentile(window.recent, 0.75),
            p95: perf.percentile(window.recent, 0.95),
            baselineP75: perf.percentile(window.baseline, 0.75)
        };
        const inpP75 = perf.percentile(inp, 0.75);
        const reason = perf.slowReason({
            count: numbers.count,
            p75: numbers.p75,
            baselineP75: numbers.baselineP75,
            baselineCount: total(window.baseline),
            target,
            inpP75,
            inpCount: total(inp)
        });
        const due = reason !== null && (!route.flaggedAt || now.getTime() - route.flaggedAt.getTime() >= FLAG_EVERY_MS);
        let issueId: string | undefined;
        if (due && reason) {
            const event = slowEvent(
                route,
                metric,
                reason,
                { p75: numbers.p75, target, baseline: numbers.baselineP75, inp: inpP75 },
                now
            );
            await captureEvent({ id: route.projectId, platform: route.project.platform }, event);
            const issue = await prisma.telemetryIssue.findUnique({
                where: { projectId_fingerprint: { projectId: route.projectId, fingerprint: event.fingerprint } },
                select: { id: true }
            });
            issueId = issue?.id;
            flagged++;
        }
        await prisma.telemetryPerfRoute.update({
            where: { id: route.id },
            data: {
                metric,
                ...numbers,
                evaluatedAt: now,
                ...(due ? { flaggedAt: now } : {}),
                ...(issueId ? { issueId } : {})
            }
        });
    }
    return { evaluated: routes.length, flagged };
}

/** Keep the slowest few transactions per route, and nothing past a year. */
async function trim(now: Date): Promise<void> {
    await prisma.$executeRaw`
        DELETE FROM "TelemetryPerfSample" WHERE "id" IN (
            SELECT "id" FROM (
                SELECT "id", row_number() OVER (PARTITION BY "routeId" ORDER BY "durationMs" DESC) AS rank
                FROM "TelemetryPerfSample"
            ) ranked WHERE ranked.rank > ${SAMPLES_PER_ROUTE}
        )`;
    const yearAgo = new Date(now.getTime() - 365 * DAY);
    await prisma.telemetryPerfBucket.deleteMany({ where: { at: { lt: yearAgo } } });
    // A route nothing has reported for a year goes, with its histograms.
    await prisma.telemetryPerfRoute.deleteMany({ where: { lastSeen: { lt: yearAgo } } });
    // A route that went quiet has no last day to speak of.
    await prisma.telemetryPerfRoute.updateMany({
        where: { lastSeen: { lt: new Date(now.getTime() - DAY) }, count: { gt: 0 } },
        data: { count: 0 }
    });
}

/**
 * The telemetry-performance job: fold hours into days, work out every active
 * route's percentiles against its target and its own last week, open or touch
 * the issue of each slow one, and keep the samples bounded.
 */
export async function runPerformanceJob(now: Date = new Date()): Promise<{
    folded: number;
    evaluated: number;
    flagged: number;
}> {
    const folded = await foldHours(now);
    let evaluated = 0;
    let flagged = 0;
    for (let pass = 0; pass < MAX_BATCHES; pass++) {
        const batch = await evaluateBatch(now);
        evaluated += batch.evaluated;
        flagged += batch.flagged;
        if (batch.evaluated < BATCH) break;
    }
    await trim(now);
    return { folded, evaluated, flagged };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const ROUTE_SORTS = ["count", "p50", "p75", "p95", "name", "lastSeen"] as const;
export type RouteSort = (typeof ROUTE_SORTS)[number];
export const ROUTE_PAGE = 50;

export interface RouteRow {
    readonly id: string;
    readonly name: string;
    readonly op: string;
    readonly metric: perf.PerfMetric;
    readonly count: number;
    readonly p50: number | null;
    readonly p75: number | null;
    readonly p95: number | null;
    readonly baselineP75: number | null;
    readonly target: number;
    /** Whether the target is this route's own rather than inherited. */
    readonly ownTarget: boolean;
    readonly issueId: string | null;
    readonly lastSeen: string;
}

const ROUTE_SELECT = {
    id: true,
    name: true,
    op: true,
    metric: true,
    count: true,
    p50: true,
    p75: true,
    p95: true,
    baselineP75: true,
    targetMs: true,
    issueId: true,
    lastSeen: true
} as const;

function rowOf(
    route: Prisma.TelemetryPerfRouteGetPayload<{ select: typeof ROUTE_SELECT }>,
    projectTarget: number | null
): RouteRow {
    const metric = (perf.PERF_METRICS as readonly string[]).includes(route.metric)
        ? (route.metric as perf.PerfMetric)
        : "duration";
    return {
        id: route.id,
        name: route.name,
        op: route.op,
        metric,
        count: route.count,
        p50: route.p50,
        p75: route.p75,
        p95: route.p95,
        baselineP75: route.baselineP75,
        target: perf.effectiveTarget({ op: route.op, metric, routeTarget: route.targetMs, projectTarget }),
        ownTarget: route.targetMs !== null,
        issueId: route.issueId,
        lastSeen: route.lastSeen.toISOString()
    };
}

async function projectTarget(projectId: string): Promise<number | null> {
    const project = await prisma.telemetryProject.findUnique({
        where: { id: projectId },
        select: { perfTargetMs: true }
    });
    return project?.perfTargetMs ?? null;
}

/**
 * One page of a project's routes, sorted and filtered in the database. The
 * cursor is an offset: the orders are on columns the job rewrites, so a row's
 * place moves between pages anyway, and an offset over an indexed order is the
 * honest version of that.
 */
export async function listRoutesPage(input: {
    projectId: string;
    sort: RouteSort;
    op?: string | null;
    query?: string | null;
    cursor?: string | null;
}): Promise<{ items: RouteRow[]; next: string | null; projectTarget: number | null; ops: string[] }> {
    const skip = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
    const where: Prisma.TelemetryPerfRouteWhereInput = {
        projectId: input.projectId,
        ...(input.op ? { op: input.op } : {}),
        ...(input.query ? { name: { contains: input.query, mode: "insensitive" } } : {})
    };
    const orderBy: Prisma.TelemetryPerfRouteOrderByWithRelationInput[] =
        input.sort === "name"
            ? [{ name: "asc" }, { id: "asc" }]
            : input.sort === "lastSeen" || input.sort === "count"
              ? [{ [input.sort]: "desc" }, { id: "asc" }]
              : [{ [input.sort]: { sort: "desc", nulls: "last" } }, { id: "asc" }];
    const [rows, target, ops] = await Promise.all([
        prisma.telemetryPerfRoute.findMany({ where, orderBy, skip, take: ROUTE_PAGE + 1, select: ROUTE_SELECT }),
        projectTarget(input.projectId),
        skip === 0
            ? prisma.telemetryPerfRoute.findMany({
                  where: { projectId: input.projectId },
                  distinct: ["op"],
                  select: { op: true },
                  take: 20
              })
            : Promise.resolve([])
    ]);
    return {
        items: rows.slice(0, ROUTE_PAGE).map((row) => rowOf(row, target)),
        next: rows.length > ROUTE_PAGE ? String(skip + ROUTE_PAGE) : null,
        projectTarget: target,
        ops: ops.map((row) => row.op).sort()
    };
}

export interface VitalRow {
    readonly metric: perf.PerfMetric;
    readonly count: number;
    readonly p75: number | null;
    readonly target: number | null;
}

export interface SampleRow {
    readonly id: string;
    readonly eventId: string | null;
    readonly durationMs: number;
    readonly release: string | null;
    readonly environment: string | null;
    readonly url: string | null;
    readonly at: string;
    readonly spans: readonly perf.SpanRow[];
}

/** A route with its measurements over the last day and its slowest samples. */
export async function routeDetail(
    projectId: string,
    routeId: string,
    now: Date = new Date()
): Promise<{ route: RouteRow; vitals: VitalRow[]; samples: SampleRow[]; issueStatus: string | null } | null> {
    const [route, target] = await Promise.all([
        prisma.telemetryPerfRoute.findFirst({
            where: { id: routeId, projectId },
            select: { ...ROUTE_SELECT, issue: { select: { status: true } } }
        }),
        projectTarget(projectId)
    ]);
    if (!route) return null;
    const [buckets, samples] = await Promise.all([
        prisma.telemetryPerfBucket.findMany({
            where: { routeId, grain: 60, at: { gte: new Date(now.getTime() - DAY) } },
            select: { metric: true, at: true, hist: true }
        }),
        prisma.telemetryPerfSample.findMany({
            where: { routeId },
            orderBy: { durationMs: "desc" },
            take: 10
        })
    ]);
    const stats = windowStats(buckets, now);
    const vitals = perf.PERF_METRICS.filter((metric) => stats.has(metric)).map((metric) => {
        const hist = stats.get(metric)?.recent ?? [];
        return {
            metric,
            count: total(hist),
            p75: perf.percentile(hist, 0.75),
            target: metric === "duration" ? null : perf.VITAL_TARGETS[metric]
        };
    });
    return {
        route: rowOf(route, target),
        vitals,
        issueStatus: route.issue?.status ?? null,
        samples: samples.map((sample) => {
            let spans: perf.SpanRow[] = [];
            try {
                const parsed = JSON.parse(sample.detail) as { spans?: perf.SpanRow[] };
                spans = Array.isArray(parsed.spans) ? parsed.spans : [];
            } catch {
                spans = [];
            }
            return {
                id: sample.id,
                eventId: sample.eventId,
                durationMs: sample.durationMs,
                release: sample.release,
                environment: sample.environment,
                url: sample.url,
                at: sample.at.toISOString(),
                spans
            };
        })
    };
}

/** Set the target of one route, or of the whole project when no route is named. */
export async function setTarget(projectId: string, routeId: string | null, targetMs: number | null): Promise<boolean> {
    if (routeId) {
        const { count } = await prisma.telemetryPerfRoute.updateMany({
            where: { id: routeId, projectId },
            data: { targetMs, evaluatedAt: null }
        });
        return count > 0;
    }
    await prisma.telemetryProject.update({ where: { id: projectId }, data: { perfTargetMs: targetMs } });
    // Every route is judged again on the next pass, against the new line.
    await prisma.telemetryPerfRoute.updateMany({ where: { projectId }, data: { evaluatedAt: null } });
    return true;
}
