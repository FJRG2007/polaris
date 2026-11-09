/**
 * The questions Analytics answers past its overview: filters, the previous
 * period, events and their properties, revenue, funnels, journeys, goals,
 * retention, visits one by one, and the saved reports that name them.
 *
 * Every one of them is aggregated in the database and returns a bounded number
 * of rows - a count per funnel step, the top journeys, a property's top values -
 * never the visits themselves. The overview's per-visit read is capped and only
 * spans a month; these run over the same window without loading it.
 *
 * Raw SQL where Prisma cannot say it (window functions, JSON properties,
 * per-step joins), always through `Prisma.sql` so every value is a bound
 * parameter. The only text spliced in is a column or alias name taken from a
 * fixed table in this file.
 */

import * as core from "@polaris/core";
import { Prisma, prisma } from "@polaris/db";

/** Rows any list here may return. */
const LIST_CAP = 100;

// --- filters ------------------------------------------------------------------

/** The session column behind each filter that lives on the visit. */
const SESSION_COLUMN: Readonly<Record<Exclude<core.VisitFilterDimension, "path" | "event">, string>> = {
    referrer: "referrerSource",
    channel: "referrerKind",
    campaign: "campaign",
    medium: "medium",
    browser: "browser",
    os: "os",
    device: "device",
    country: "country",
    language: "language",
    screen: "screen",
    ip: "ip",
    distinctId: "distinctId"
};

/** What the referrer breakdown calls a visit with no referrer. */
const DIRECT = "Direct";

/** The same filters, as a Prisma condition on a session. */
export function sessionWhere(filters: readonly core.VisitFilter[]): Prisma.AnalyticsSessionWhereInput {
    const all = filters.map((filter): Prisma.AnalyticsSessionWhereInput => {
        let match: Prisma.AnalyticsSessionWhereInput;
        if (filter.dimension === "path") match = { events: { some: { kind: "pageview", path: filter.value } } };
        else if (filter.dimension === "event") match = { events: { some: { kind: "event", name: filter.value } } };
        else if (filter.dimension === "referrer" && filter.value === DIRECT) match = { referrerSource: null };
        else match = { [SESSION_COLUMN[filter.dimension]]: filter.value };
        if (!filter.negate) return match;
        // Not "the column is something else": a visit with no country is not a
        // visit from Spain either, and NOT (x = y) drops every null.
        if (filter.dimension === "path" || filter.dimension === "event") return { NOT: match };
        return { OR: [{ NOT: match }, { [SESSION_COLUMN[filter.dimension]]: null }] };
    });
    return all.length ? { AND: all } : {};
}

/** The same filters, as SQL on a session aliased `s`. */
function sessionSql(filters: readonly core.VisitFilter[]): Prisma.Sql {
    if (filters.length === 0) return Prisma.empty;
    const parts = filters.map((filter) => {
        if (filter.dimension === "path" || filter.dimension === "event") {
            const test =
                filter.dimension === "path"
                    ? Prisma.sql`x.kind = 'pageview' AND x.path = ${filter.value}`
                    : Prisma.sql`x.kind = 'event' AND x.name = ${filter.value}`;
            const exists = Prisma.sql`EXISTS (SELECT 1 FROM "AnalyticsEvent" x WHERE x."sessionId" = s.id AND ${test})`;
            return filter.negate ? Prisma.sql`NOT ${exists}` : exists;
        }
        const column = Prisma.raw(`s."${SESSION_COLUMN[filter.dimension]}"`);
        if (filter.dimension === "referrer" && filter.value === DIRECT)
            return filter.negate ? Prisma.sql`${column} IS NOT NULL` : Prisma.sql`${column} IS NULL`;
        return filter.negate
            ? Prisma.sql`${column} IS DISTINCT FROM ${filter.value}`
            : Prisma.sql`${column} = ${filter.value}`;
    });
    return Prisma.sql` AND ${Prisma.join(parts, " AND ")}`;
}

export interface ReportWindow {
    readonly siteId: string;
    readonly from: number;
    readonly to: number;
    readonly filters: readonly core.VisitFilter[];
}

/** The window's events, as a CTE named `ev`, narrowed by the filters. */
function eventsCte(window: ReportWindow): Prisma.Sql {
    const join = window.filters.length
        ? Prisma.sql`JOIN "AnalyticsSession" s ON s.id = e."sessionId"`
        : Prisma.empty;
    return Prisma.sql`ev AS (
        SELECT e."sessionId", e.at, e.kind, e.name, e.path, e.props
        FROM "AnalyticsEvent" e ${join}
        WHERE e."siteId" = ${window.siteId}::uuid
          AND e.at >= ${new Date(window.from)} AND e.at < ${new Date(window.to)}${sessionSql(window.filters)}
    )`;
}

/** `%`, `_` and `\` are LIKE's own; everything else is the visitor's path. */
function likePrefix(value: string): string {
    return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** A funnel step or a goal, as SQL on an event aliased `alias`. */
function matchSql(match: core.VisitMatch, alias: string): Prisma.Sql {
    const a = Prisma.raw(alias);
    if (match.type === "event") return Prisma.sql`(${a}.kind = 'event' AND ${a}.name = ${match.value})`;
    if (match.value.endsWith("*"))
        return Prisma.sql`(${a}.kind = 'pageview' AND ${a}.path LIKE ${likePrefix(match.value.slice(0, -1))})`;
    return Prisma.sql`(${a}.kind = 'pageview' AND ${a}.path = ${match.value})`;
}

// --- previous period ------------------------------------------------------------

export interface PeriodTotals {
    readonly visitors: number;
    readonly views: number;
    readonly bounceRate: number | null;
    readonly avgVisitSec: number | null;
}

/**
 * The same totals over the window before this one, so every card can say
 * whether it went up. From the visits when the window is short enough to still
 * have them, from the daily totals otherwise - which cannot be filtered, so a
 * filtered long window has no comparison rather than a wrong one.
 */
export async function previousPeriod(
    window: ReportWindow,
    source: "raw" | "daily"
): Promise<PeriodTotals | null> {
    const span = window.to - window.from;
    const from = new Date(window.from - span);
    const to = new Date(window.from);
    if (source === "daily") {
        if (window.filters.length) return null;
        const sum = await prisma.analyticsDay.aggregate({
            where: { siteId: window.siteId, dimension: "total", day: { gte: from, lt: to } },
            _sum: { visitors: true, views: true, bounces: true, durationSec: true, measured: true }
        });
        const visitors = sum._sum.visitors ?? 0;
        const measured = sum._sum.measured ?? 0;
        return {
            visitors,
            views: sum._sum.views ?? 0,
            bounceRate: visitors > 0 ? (sum._sum.bounces ?? 0) / visitors : null,
            avgVisitSec: measured > 0 ? Math.round((sum._sum.durationSec ?? 0) / measured) : null
        };
    }
    const rows = await prisma.$queryRaw<
        { visitors: number; bounces: number; duration: number; measured: number; views: number }[]
    >(Prisma.sql`
        SELECT count(*)::int AS visitors,
               count(*) FILTER (WHERE s.views <= 1)::int AS bounces,
               coalesce(sum(extract(epoch FROM (s."lastSeenAt" - s."startedAt"))) FILTER (WHERE s."lastSeenAt" > s."startedAt"), 0)::float8 AS duration,
               count(*) FILTER (WHERE s."lastSeenAt" > s."startedAt")::int AS measured,
               coalesce(sum(s.views), 0)::int AS views
        FROM "AnalyticsSession" s
        WHERE s."siteId" = ${window.siteId}::uuid
          AND s."lastSeenAt" >= ${from} AND s."startedAt" < ${to}${sessionSql(window.filters)}
    `);
    const row = rows[0];
    if (!row) return { visitors: 0, views: 0, bounceRate: null, avgVisitSec: null };
    return {
        visitors: row.visitors,
        views: row.views,
        bounceRate: row.visitors > 0 ? row.bounces / row.visitors : null,
        avgVisitSec: row.measured > 0 ? Math.round(row.duration / row.measured) : null
    };
}

// --- events and their properties ---------------------------------------------------

export interface EventNameRow {
    readonly name: string;
    readonly events: number;
    readonly visitors: number;
}

export async function eventNames(window: ReportWindow): Promise<EventNameRow[]> {
    return prisma.$queryRaw<EventNameRow[]>(Prisma.sql`
        WITH ${eventsCte(window)}
        SELECT name, count(*)::int AS events, count(DISTINCT "sessionId")::int AS visitors
        FROM ev WHERE kind = 'event' AND name IS NOT NULL
        GROUP BY name ORDER BY events DESC, name ASC LIMIT ${LIST_CAP}
    `);
}

export interface EventPropertyRow {
    readonly key: string;
    readonly value: string;
    readonly events: number;
}

/** One event's properties, every key with its most common values. */
export async function eventProperties(window: ReportWindow, name: string): Promise<EventPropertyRow[]> {
    return prisma.$queryRaw<EventPropertyRow[]>(Prisma.sql`
        WITH ${eventsCte(window)}
        SELECT kv.key AS key, kv.value AS value, count(*)::int AS events
        FROM ev, jsonb_each_text(ev.props::jsonb) AS kv
        WHERE ev.kind = 'event' AND ev.name = ${name} AND ev.props IS NOT NULL
        GROUP BY kv.key, kv.value ORDER BY events DESC, key ASC LIMIT ${LIST_CAP * 3}
    `);
}

// --- revenue -------------------------------------------------------------------

export interface RevenueRow {
    readonly currency: string;
    /** As a decimal string: money is not summed in floating point. */
    readonly total: string;
    readonly events: number;
    readonly visitors: number;
}

export interface RevenueReport {
    readonly totals: readonly RevenueRow[];
    readonly byEvent: readonly (RevenueRow & { readonly name: string })[];
}

/**
 * Revenue, from events that carry a numeric `revenue` property and, ideally, a
 * `currency` one - the convention Umami's tracker uses, so a page instrumented
 * for it reports here unchanged. Amounts in different currencies are never
 * added together.
 */
export async function revenue(window: ReportWindow): Promise<RevenueReport> {
    const paid = Prisma.raw("kind = 'event' AND props IS NOT NULL AND jsonb_typeof(props::jsonb -> 'revenue') = 'number'");
    const currency = Prisma.raw("upper(coalesce(props::jsonb ->> 'currency', ''))");
    const [totals, byEvent] = await Promise.all([
        prisma.$queryRaw<RevenueRow[]>(Prisma.sql`
            WITH ${eventsCte(window)}
            SELECT ${currency} AS currency, sum((props::jsonb ->> 'revenue')::numeric)::text AS total,
                   count(*)::int AS events, count(DISTINCT "sessionId")::int AS visitors
            FROM ev WHERE ${paid} GROUP BY 1 ORDER BY events DESC LIMIT 20
        `),
        prisma.$queryRaw<(RevenueRow & { name: string })[]>(Prisma.sql`
            WITH ${eventsCte(window)}
            SELECT coalesce(name, '') AS name, ${currency} AS currency,
                   sum((props::jsonb ->> 'revenue')::numeric)::text AS total,
                   count(*)::int AS events, count(DISTINCT "sessionId")::int AS visitors
            FROM ev WHERE ${paid} GROUP BY 1, 2 ORDER BY events DESC LIMIT ${LIST_CAP / 2}
        `)
    ]);
    return { totals, byEvent };
}

// --- funnels -------------------------------------------------------------------

export interface FunnelStep {
    readonly step: core.VisitMatch;
    readonly visitors: number;
}

/**
 * How many visits reached each step, in order, within the window from their
 * first step. Each step is a CTE joined to the one before it, so the database
 * returns one count per step and never the sessions.
 */
export async function funnel(window: ReportWindow, definition: core.FunnelDefinition): Promise<FunnelStep[]> {
    const steps = definition.steps;
    const ctes: Prisma.Sql[] = [eventsCte(window)];
    ctes.push(Prisma.sql`f0 AS (
        SELECT e."sessionId", min(e.at) AS t0, min(e.at) AS t FROM ev e WHERE ${matchSql(steps[0]!, "e")} GROUP BY 1
    )`);
    for (let index = 1; index < steps.length; index++) {
        const name = Prisma.raw(`f${index}`);
        const previous = Prisma.raw(`f${index - 1}`);
        ctes.push(Prisma.sql`${name} AS (
            SELECT p."sessionId", p.t0, min(e.at) AS t
            FROM ${previous} p JOIN ev e ON e."sessionId" = p."sessionId"
                AND e.at > p.t AND e.at <= p.t0 + make_interval(mins => ${definition.windowMinutes})
            WHERE ${matchSql(steps[index]!, "e")}
            GROUP BY 1, 2
        )`);
    }
    const counts = steps.map(
        (_, index) => Prisma.sql`(SELECT count(*) FROM ${Prisma.raw(`f${index}`)})::int AS ${Prisma.raw(`c${index}`)}`
    );
    const rows = await prisma.$queryRaw<Record<string, number>[]>(
        Prisma.sql`WITH ${Prisma.join(ctes, ", ")} SELECT ${Prisma.join(counts, ", ")}`
    );
    const row = rows[0] ?? {};
    return steps.map((step, index) => ({ step, visitors: Number(row[`c${index}`] ?? 0) }));
}

// --- journeys ------------------------------------------------------------------

export interface JourneyRow {
    readonly paths: readonly string[];
    readonly visits: number;
}

/**
 * The most common sequences of pages, as they were read: a reload or a route
 * that replaced itself is one page, not two.
 */
export async function journeys(window: ReportWindow, definition: core.JourneyDefinition): Promise<JourneyRow[]> {
    const start = definition.start ? Prisma.sql`WHERE p[1] = ${definition.start}` : Prisma.empty;
    return prisma.$queryRaw<JourneyRow[]>(Prisma.sql`
        WITH ${eventsCte(window)},
        d AS (
            SELECT "sessionId", at, path, lag(path) OVER (PARTITION BY "sessionId" ORDER BY at) AS prev
            FROM ev WHERE kind = 'pageview'
        ),
        v AS (
            SELECT "sessionId", path, row_number() OVER (PARTITION BY "sessionId" ORDER BY at) AS n
            FROM d WHERE prev IS DISTINCT FROM path
        ),
        j AS (
            SELECT "sessionId", array_agg(path ORDER BY n) AS p FROM v WHERE n <= ${definition.steps} GROUP BY 1
        )
        SELECT p AS paths, count(*)::int AS visits FROM j ${start}
        GROUP BY p ORDER BY visits DESC LIMIT 25
    `);
}

// --- goals ---------------------------------------------------------------------

export interface GoalResult {
    readonly id: string;
    readonly visitors: number;
    readonly events: number;
}

/** Every goal at once, as one pass over the window. */
export async function goals(
    window: ReportWindow,
    list: readonly { id: string; goal: core.GoalDefinition }[]
): Promise<{ total: number; results: GoalResult[] }> {
    const bounded = list.slice(0, 25);
    const columns = bounded.flatMap((entry, index) => [
        Prisma.sql`count(DISTINCT e."sessionId") FILTER (WHERE ${matchSql(entry.goal, "e")})::int AS ${Prisma.raw(`v${index}`)}`,
        Prisma.sql`count(*) FILTER (WHERE ${matchSql(entry.goal, "e")})::int AS ${Prisma.raw(`n${index}`)}`
    ]);
    const rows = await prisma.$queryRaw<Record<string, number>[]>(Prisma.sql`
        WITH ${eventsCte(window)}
        SELECT ${Prisma.join([Prisma.sql`count(DISTINCT e."sessionId")::int AS total`, ...columns], ", ")} FROM ev e
    `);
    const row = rows[0] ?? {};
    return {
        total: Number(row.total ?? 0),
        results: bounded.map((entry, index) => ({
            id: entry.id,
            visitors: Number(row[`v${index}`] ?? 0),
            events: Number(row[`n${index}`] ?? 0)
        }))
    };
}

// --- retention -----------------------------------------------------------------

export interface RetentionCell {
    /** Epoch ms of the cohort's UTC day. */
    readonly cohort: number;
    /** Days after the cohort's first. */
    readonly offset: number;
    readonly visitors: number;
}

/** Longest window a retention grid is drawn over: a cohort per day, a column per day. */
export const RETENTION_MAX_DAYS = 31;

/**
 * Who came back, by the day they first came.
 *
 * Over identified visitors only. A visit's own id rotates with the daily salt
 * on purpose (see analytics-service), so the only thing that can join Monday to
 * Tuesday is the id the site itself sends with `polaris.identify()`.
 */
export async function retention(window: ReportWindow): Promise<RetentionCell[]> {
    const from = new Date(Math.max(window.from, window.to - RETENTION_MAX_DAYS * 86_400_000));
    const rows = await prisma.$queryRaw<{ cohort: Date; offset: number; visitors: number }[]>(Prisma.sql`
        WITH u AS (
            SELECT s."distinctId" AS d, date_trunc('day', s."startedAt") AS day
            FROM "AnalyticsSession" s
            WHERE s."siteId" = ${window.siteId}::uuid AND s."distinctId" IS NOT NULL
              AND s."startedAt" >= ${from} AND s."startedAt" < ${new Date(window.to)}${sessionSql(window.filters)}
            GROUP BY 1, 2
        ),
        f AS (SELECT d, min(day) AS c FROM u GROUP BY d)
        SELECT f.c AS cohort, (extract(epoch FROM (u.day - f.c)) / 86400)::int AS "offset",
               count(DISTINCT u.d)::int AS visitors
        FROM u JOIN f ON f.d = u.d
        GROUP BY 1, 2 ORDER BY 1, 2
        LIMIT ${RETENTION_MAX_DAYS * RETENTION_MAX_DAYS}
    `);
    return rows.map((row) => ({ cohort: new Date(row.cohort).getTime(), offset: row.offset, visitors: row.visitors }));
}

// --- visits, one by one -----------------------------------------------------------

/** One visit, in full: what it was, and everything it did in order. */
export async function sessionJourney(siteId: string, sessionId: string) {
    const session = await prisma.analyticsSession.findFirst({ where: { id: sessionId, siteId } });
    if (!session) return null;
    const events = await prisma.analyticsEvent.findMany({
        where: { siteId, sessionId },
        orderBy: { at: "asc" },
        take: 500,
        select: { at: true, kind: true, name: true, path: true, rawPath: true, props: true }
    });
    return {
        id: session.id,
        ip: session.ip,
        browser: session.browser,
        os: session.os,
        device: session.device,
        country: session.country,
        language: session.language,
        screen: session.screen,
        referrerKind: session.referrerKind,
        referrerSource: session.referrerSource,
        campaign: session.campaign,
        medium: session.medium,
        distinctId: session.distinctId,
        data: parseProps(session.data),
        views: session.views,
        startedAt: session.startedAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        events: events.map((event) => ({
            at: event.at.toISOString(),
            kind: event.kind === "event" ? ("event" as const) : ("pageview" as const),
            name: event.name,
            path: event.rawPath ?? event.path,
            props: parseProps(event.props)
        }))
    };
}

/** Stored properties back as a flat record; anything else as none. */
export function parseProps(raw: string | null): Record<string, string | number | boolean> | null {
    if (!raw) return null;
    try {
        const parsed = core.visitPropsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

// --- saved reports ---------------------------------------------------------------

export interface SavedReport {
    readonly id: string;
    readonly kind: core.AnalyticsReportKind;
    readonly name: string;
    readonly definition: unknown;
    readonly updatedAt: string;
}

/** A site's saved reports, each re-validated on the way out: a row a later
 *  schema no longer accepts is skipped rather than handed to a screen. */
export async function listReports(siteId: string): Promise<SavedReport[]> {
    const rows = await prisma.analyticsReport.findMany({
        where: { siteId },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        take: 200,
        select: { id: true, kind: true, name: true, definition: true, updatedAt: true }
    });
    const out: SavedReport[] = [];
    for (const row of rows) {
        let definition: unknown;
        try {
            definition = JSON.parse(row.definition);
        } catch {
            continue;
        }
        const parsed = core.analyticsReportSchema.safeParse({ kind: row.kind, name: row.name, definition });
        if (!parsed.success) continue;
        out.push({
            id: row.id,
            kind: parsed.data.kind,
            name: parsed.data.name,
            definition: parsed.data.definition,
            updatedAt: row.updatedAt.toISOString()
        });
    }
    return out;
}

export async function saveReport(
    siteId: string,
    userId: string,
    report: core.AnalyticsReportInput,
    id?: string
): Promise<string | null> {
    const data = { kind: report.kind, name: report.name, definition: JSON.stringify(report.definition) };
    if (id) {
        const updated = await prisma.analyticsReport.updateMany({ where: { id, siteId }, data });
        return updated.count ? id : null;
    }
    const count = await prisma.analyticsReport.count({ where: { siteId } });
    if (count >= 200) return null;
    const row = await prisma.analyticsReport.create({
        data: { ...data, siteId, createdById: userId },
        select: { id: true }
    });
    return row.id;
}

export async function deleteReport(siteId: string, id: string): Promise<boolean> {
    const removed = await prisma.analyticsReport.deleteMany({ where: { id, siteId } });
    return removed.count > 0;
}

// --- a site's history ------------------------------------------------------------

/** Wipe what a site recorded: visits, events and the daily totals. The site, its
 *  key, its settings and its saved reports stay. */
export async function resetSiteData(siteId: string): Promise<void> {
    await prisma.$transaction([
        prisma.analyticsEvent.deleteMany({ where: { siteId } }),
        prisma.analyticsSession.deleteMany({ where: { siteId } }),
        prisma.analyticsDay.deleteMany({ where: { siteId } })
    ]);
}
