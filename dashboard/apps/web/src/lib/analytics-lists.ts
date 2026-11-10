/**
 * The long lists in Analytics - every page, every referrer, every country, every
 * site - read a page at a time.
 *
 * A breakdown is a ranking, not a table with a natural key, so the cursor is the
 * position in the ranking itself: the last row's visitors, views and key, in the
 * order the ranking sorts by (visitors, then views, then key). The next page is
 * whatever sorts after that tuple. Unlike an offset, a row that changes rank
 * between two pages is not shown twice or skipped past by everything below it.
 *
 * The ranking is built the same way the overview builds its top ten: from the
 * per-visit rows up to 31 days, from the daily totals past that (see
 * `readAnalytics`). Both are bounded - the raw read by the same event cap, the
 * rollup by `RANK_CAP` rows - so a page costs at most what the overview costs.
 */

import { prisma } from "@polaris/db";
import { sessionWhere } from "@/lib/analytics-reports";
import { reportVisits, visitDay, type VisitDimension, type VisitFilter, type VisitRow } from "@polaris/core";

/** The deepest a ranking goes. Also the most `reportVisits` will rank. */
export const RANK_CAP = 500;

/** Rows per page, unless the caller asks for fewer. */
export const LIST_PAGE = 50;

/** The same boundaries `readAnalytics` draws, so a list and the overview agree. */
const RAW_MAX_MS = 31 * 86_400_000;
const RAW_EVENT_CAP = 200_000;

/** The dimensions the daily totals carry. Everything else needs the raw rows. */
const DAILY_DIMENSIONS: ReadonlySet<VisitDimension> = new Set([
    "path",
    "referrer",
    "channel",
    "browser",
    "os",
    "device",
    "country",
    "event"
]);

export interface RankCursor {
    readonly visitors: number;
    readonly views: number;
    readonly key: string;
}

export interface Page<T> {
    readonly rows: T[];
    /** Pass back to get the rows after these; null at the end. */
    readonly next: string | null;
}

/** A cursor as it travels: opaque, URL-safe. */
export function encodeCursor(cursor: RankCursor): string {
    return Buffer.from(JSON.stringify([cursor.visitors, cursor.views, cursor.key]), "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module wrote - a page from the top. */
export function decodeCursor(raw: string | null | undefined): RankCursor | null {
    if (!raw || raw.length > 2048) return null;
    try {
        const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 3) return null;
        const [visitors, views, key] = value as unknown[];
        if (!Number.isSafeInteger(visitors) || !Number.isSafeInteger(views) || typeof key !== "string") return null;
        return { visitors: visitors as number, views: views as number, key };
    } catch {
        return null;
    }
}

/** The ranking's order: visitors, then views, both descending, then the key. */
export function compareRank(a: RankCursor, b: RankCursor): number {
    return b.visitors - a.visitors || b.views - a.views || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** The rows that sort after the cursor, `limit` of them, and where to go next. */
export function pageRanked(
    rows: readonly VisitRow[],
    cursor: string | null | undefined,
    limit = LIST_PAGE
): Page<VisitRow> {
    const size = Math.max(1, Math.min(limit, 200));
    const after = decodeCursor(cursor);
    const sorted = [...rows].sort(compareRank);
    const start = after ? sorted.findIndex((row) => compareRank(row, after) > 0) : 0;
    if (start < 0) return { rows: [], next: null };
    const slice = sorted.slice(start, start + size);
    const last = slice[slice.length - 1];
    return { rows: slice, next: start + size < sorted.length && last ? encodeCursor(last) : null };
}

export interface RankWindow {
    readonly siteId: string;
    readonly from: number;
    readonly to: number;
    readonly filters: readonly VisitFilter[];
}

export interface RankedList extends Page<VisitRow> {
    /** Where the ranking came from; the daily totals cannot be filtered. */
    readonly source: "raw" | "daily";
    /** This dimension is not kept in the daily totals this window is drawn from. */
    readonly unavailable: boolean;
    /** The ranking reached `RANK_CAP` and stops there. */
    readonly capped: boolean;
}

/** One dimension's whole ranking over a window, a page at a time. */
export async function rankedPage(
    window: RankWindow,
    dimension: VisitDimension,
    cursor: string | null | undefined,
    limit = LIST_PAGE
): Promise<RankedList> {
    if (window.to - window.from > RAW_MAX_MS) {
        if (!DAILY_DIMENSIONS.has(dimension)) {
            return { rows: [], next: null, source: "daily", unavailable: true, capped: false };
        }
        const grouped = await prisma.analyticsDay.groupBy({
            by: ["value"],
            where: {
                siteId: window.siteId,
                dimension,
                day: { gte: new Date(visitDay(window.from)), lt: new Date(window.to) }
            },
            _sum: { visitors: true, views: true },
            orderBy: [{ _sum: { visitors: "desc" } }, { _sum: { views: "desc" } }, { value: "asc" }],
            take: RANK_CAP
        });
        const rows = grouped.map((row) => ({
            key: row.value,
            visitors: row._sum?.visitors ?? 0,
            views: row._sum?.views ?? 0
        }));
        return { ...pageRanked(rows, cursor, limit), source: "daily", unavailable: false, capped: rows.length >= RANK_CAP };
    }

    const narrow = sessionWhere(window.filters);
    const [sessions, events] = await Promise.all([
        prisma.analyticsSession.findMany({
            where: { siteId: window.siteId, lastSeenAt: { gte: new Date(window.from) }, ...narrow }
        }),
        prisma.analyticsEvent.findMany({
            where: {
                siteId: window.siteId,
                at: { gte: new Date(window.from), lt: new Date(window.to) },
                ...(window.filters.length ? { session: { is: narrow } } : {})
            },
            orderBy: { at: "asc" },
            take: RAW_EVENT_CAP,
            select: { sessionId: true, at: true, kind: true, name: true, path: true }
        })
    ]);
    const report = reportVisits({
        sessions: sessions.map((session) => ({
            ...session,
            startedAt: session.startedAt.getTime(),
            lastSeenAt: session.lastSeenAt.getTime()
        })),
        events: events.map((event) => ({
            sessionId: event.sessionId,
            at: event.at.getTime(),
            kind: event.kind === "event" ? ("event" as const) : ("pageview" as const),
            name: event.name,
            path: event.path
        })),
        from: window.from,
        to: window.to,
        buckets: 1,
        limit: RANK_CAP
    });
    const rows = report.breakdowns[dimension];
    return { ...pageRanked(rows, cursor, limit), source: "raw", unavailable: false, capped: rows.length >= RANK_CAP };
}

/** A site in the list of everything this account can measure. */
export interface SiteListRow {
    readonly id: string;
    readonly label: string;
    readonly scope: "application" | "external" | "polaris";
}

/** The key the site list sorts and pages by: the label, then the id. */
function siteKey(site: SiteListRow): string {
    return `${site.label.toLowerCase()}\u0000${site.id}`;
}

/**
 * The site list a page at a time, ordered by label then id, narrowed by a
 * search. The cursor is the last row's sort key.
 */
export function pageSites(
    sites: readonly SiteListRow[],
    options: { cursor?: string | null; query?: string; limit?: number }
): Page<SiteListRow> {
    const size = Math.max(1, Math.min(options.limit ?? LIST_PAGE, 200));
    const query = (options.query ?? "").trim().toLowerCase();
    const sorted = sites
        .filter((site) => !query || site.label.toLowerCase().includes(query))
        .sort((a, b) => (siteKey(a) < siteKey(b) ? -1 : siteKey(a) > siteKey(b) ? 1 : 0));
    const after = options.cursor ?? "";
    const start = after ? sorted.findIndex((site) => siteKey(site) > after) : 0;
    if (start < 0) return { rows: [], next: null };
    const slice = sorted.slice(start, start + size);
    const last = slice[slice.length - 1];
    return { rows: slice, next: start + size < sorted.length && last ? siteKey(last) : null };
}

/** How far back "right now" reaches, and the rows it may read to say so. */
export const REALTIME_MS = 30 * 60 * 1000;
const REALTIME_SESSION_CAP = 5_000;
const REALTIME_EVENT_CAP = 50_000;

/**
 * The last half hour, a minute to a bar, with what is being read and from where.
 * Read straight from the per-visit rows: half an hour is always inside the raw
 * window, and a rollup is a day wide.
 */
export async function realtimeSnapshot(siteId: string, filters: readonly VisitFilter[], now = Date.now()) {
    const from = now - REALTIME_MS;
    const narrow = sessionWhere(filters);
    const [sessions, events] = await Promise.all([
        prisma.analyticsSession.findMany({
            where: { siteId, lastSeenAt: { gte: new Date(from) }, ...narrow },
            orderBy: { lastSeenAt: "desc" },
            take: REALTIME_SESSION_CAP
        }),
        prisma.analyticsEvent.findMany({
            where: {
                siteId,
                at: { gte: new Date(from), lt: new Date(now) },
                ...(filters.length ? { session: { is: narrow } } : {})
            },
            orderBy: { at: "desc" },
            take: REALTIME_EVENT_CAP,
            select: { sessionId: true, at: true, kind: true, name: true, path: true }
        })
    ]);
    const report = reportVisits({
        sessions: sessions.map((session) => ({
            ...session,
            startedAt: session.startedAt.getTime(),
            lastSeenAt: session.lastSeenAt.getTime()
        })),
        events: events.map((event) => ({
            sessionId: event.sessionId,
            at: event.at.getTime(),
            kind: event.kind === "event" ? ("event" as const) : ("pageview" as const),
            name: event.name,
            path: event.path
        })),
        from,
        to: now,
        buckets: 30,
        limit: 10
    });
    const fiveMinutes = now - 5 * 60 * 1000;
    return {
        from,
        to: now,
        online: sessions.filter((session) => session.lastSeenAt.getTime() >= fiveMinutes).length,
        visitors: report.overview.visitors,
        views: report.overview.views,
        series: report.series,
        pages: report.breakdowns.path,
        countries: report.breakdowns.country,
        referrers: report.breakdowns.referrer,
        /** The latest activity, newest first, for the live feed. */
        feed: events.slice(0, 40).map((event) => {
            const session = sessions.find((one) => one.id === event.sessionId);
            return {
                at: event.at.toISOString(),
                kind: event.kind === "event" ? ("event" as const) : ("pageview" as const),
                name: event.name,
                path: event.path,
                sessionId: event.sessionId,
                country: session?.country ?? null,
                browser: session?.browser ?? null,
                device: session?.device ?? null
            };
        })
    };
}

export type RealtimeSnapshot = Awaited<ReturnType<typeof realtimeSnapshot>>;
