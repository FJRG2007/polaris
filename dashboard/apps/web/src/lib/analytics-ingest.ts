/**
 * Folding the edge's access log into visits, and keeping the tables from growing
 * forever.
 *
 * This is what makes analytics work with nothing installed. Every request that
 * reaches a deployed service already passes through the edge and is already written
 * to its access log; reading it means a service gets visitor numbers the moment it
 * has a domain, without a script tag, a redeploy, or any cooperation from the app.
 * The tracker is then a strict addition on top - duration, screen, custom events -
 * rather than the only way to see anything at all, which is how Vercel does it and
 * why it is the right default.
 *
 * The cost of the log alone is worth naming: it cannot see how long a visit lasted,
 * and it cannot tell a page from an asset without guessing. So assets are dropped
 * rather than counted as pages, and duration is left unmeasured until the tracker
 * supplies it.
 */

import { prisma } from "@polaris/db";
import { readFile } from "node:fs/promises";
import { parseHttpLogs } from "@polaris/deploy";
import { dashboardHosts } from "@/lib/domain-edge";
import { getSetting, setSetting } from "@/lib/setting-store";
import { visitDay, type VisitDimension } from "@polaris/core";
import { ensureAnalyticsSite, getAnalyticsSettings, recordVisit, type AnalyticsScopeType } from "@/lib/analytics-service";

const ACCESS_LOG_FILE = process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";
const CURSOR_KEY = "analytics.edgeCursor";
const TAIL_BYTES = 16 * 1024 * 1024;

/** Requests that are not somebody reading a page. Counting these is the difference
 *  between "412 visitors" and "412 visitors and 38,000 stylesheet fetches". */
const ASSET_EXTENSIONS =
    /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|gz|txt|xml|json|wasm)$/i;

/** Paths that are machinery rather than content. */
const IGNORED_PREFIXES = ["/_next/", "/__nextjs", "/api/", "/.well-known/", "/cdn-cgi/"];

/**
 * Where the last pass stopped.
 *
 * A timestamp alone is not enough: several requests share a millisecond on any busy
 * service, and "strictly after" would silently drop all but the first while "at or
 * after" would count them twice. So the boundary millisecond carries the set of
 * entries already taken from it.
 */
interface EdgeCursor {
    at: number;
    seen: string[];
}

/**
 * One ingest pass. Returns how many visits were recorded, so the background tick can
 * say something true rather than "ok".
 */
export async function ingestEdgeVisits(now = Date.now()): Promise<{ recorded: number }> {
    const settings = await getAnalyticsSettings();
    if (!settings.ingestEdgeLog) return { recorded: 0 };

    const raw = await readLogTail();
    if (!raw) return { recorded: 0 };

    const routes = await hostRoutes();
    if (routes.size === 0) return { recorded: 0 };

    const cursor = await readCursor();
    const entries = parseHttpLogs(raw);

    let recorded = 0;
    let newest = cursor.at;
    const newestKeys: string[] = cursor.at > 0 ? [...cursor.seen] : [];

    for (const entry of entries) {
        if (!entry.time || !entry.host) continue;
        const at = Date.parse(entry.time);
        if (!Number.isFinite(at) || at > now) continue;
        if (at < cursor.at) continue;
        const key = entryKey(entry.time, entry.ip, entry.method, entry.path, entry.status);
        if (at === cursor.at && cursor.seen.includes(key)) continue;
        if (!isPageRequest(entry.method, entry.path, entry.status)) continue;

        const route = routes.get(entry.host.toLowerCase());
        if (!route) continue;

        try {
            await recordVisit({
                siteId: route.siteId,
                at,
                ip: entry.ip,
                userAgent: entry.userAgent,
                url: entry.path,
                referrer: entry.referer,
                self: entry.host
            });
            recorded += 1;
        } catch (error) {
            // One malformed line must not stop the pass, or the cursor never advances
            // and the same line is retried every tick forever.
            console.error("polaris: could not record an edge visit:", error);
        }

        if (at > newest) {
            newest = at;
            newestKeys.length = 0;
        }
        if (at === newest) newestKeys.push(key);
    }

    if (newest > cursor.at || newestKeys.length !== cursor.seen.length) {
        await writeCursor({ at: newest, seen: newestKeys.slice(-200) });
    }
    return { recorded };
}

/** Whether a log line is somebody reading a page. */
function isPageRequest(method: string, path: string, status: number): boolean {
    if (method !== "GET") return false;
    // A redirect is not a page read; the page it leads to is logged separately. A
    // 404 is not either - it is the firewall's business, and counting it would put
    // every scanner's wordlist in the top pages.
    if (status < 200 || status >= 300) return false;
    const clean = path.split("?")[0] ?? "/";
    if (ASSET_EXTENSIONS.test(clean)) return false;
    return !IGNORED_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

function entryKey(time: string, ip: string, method: string, path: string, status: number): string {
    return `${time}|${ip}|${method}|${path}|${status}`;
}

/**
 * Hostname to site, with the site created on demand.
 *
 * The log names a host; everything else here names an application. Resolving that
 * per line would be a query per request, so it is built once per pass.
 */
async function hostRoutes(): Promise<Map<string, { siteId: string }>> {
    const routes = new Map<string, { siteId: string }>();

    const applications = await prisma.application.findMany({
        select: { id: true, name: true, domains: { select: { hostname: true, enabled: true } } }
    });
    for (const application of applications) {
        const hostnames = application.domains.filter((domain) => domain.enabled).map((domain) => domain.hostname.toLowerCase());
        if (hostnames.length === 0) continue;
        const site = await ensureAnalyticsSite("application", application.id, application.name, hostnames);
        for (const hostname of hostnames) routes.set(hostname, { siteId: site.id });
    }

    // Polaris's own traffic is a site like any other, so an operator can see who is
    // reaching the dashboard with the same screen they use for everything else.
    const own = await dashboardHosts().catch(() => [] as string[]);
    if (own.length > 0) {
        const site = await ensureAnalyticsSite("polaris", "", "Polaris", own.map((host) => host.toLowerCase()));
        for (const host of own) routes.set(host.toLowerCase(), { siteId: site.id });
    }
    return routes;
}

async function readCursor(): Promise<EdgeCursor> {
    const raw = await getSetting(CURSOR_KEY);
    if (!raw) return { at: 0, seen: [] };
    try {
        const saved = JSON.parse(raw) as Partial<EdgeCursor>;
        return {
            at: typeof saved.at === "number" && Number.isFinite(saved.at) ? saved.at : 0,
            seen: Array.isArray(saved.seen) ? saved.seen.filter((key): key is string => typeof key === "string") : []
        };
    } catch {
        return { at: 0, seen: [] };
    }
}

async function writeCursor(cursor: EdgeCursor): Promise<void> {
    await setSetting(CURSOR_KEY, JSON.stringify(cursor));
}

async function readLogTail(): Promise<string> {
    let raw: string;
    try {
        raw = await readFile(ACCESS_LOG_FILE, "utf8");
    } catch {
        return "";
    }
    if (raw.length <= TAIL_BYTES) return raw;
    const cut = raw.slice(raw.length - TAIL_BYTES);
    return cut.slice(cut.indexOf("\n") + 1);
}

// --- rollup and retention ---------------------------------------------------

/** The dimensions worth keeping past the raw window. Deliberately not all of them:
 *  an address and a screen size are detail about one visit, and a year of those is
 *  what retention exists to end. */
const ROLLUP_DIMENSIONS: readonly VisitDimension[] = [
    "path",
    "referrer",
    "channel",
    "browser",
    "os",
    "device",
    "country",
    "event"
];

/**
 * Fold a completed day into totals.
 *
 * Runs for whole UTC days only, and rewrites rather than adds, so running it twice
 * over the same day cannot double a number. That matters more than it sounds: the
 * pass is on a timer, the process restarts, and an "add to the running total"
 * rollup silently inflates every historical figure the first time it runs twice.
 */
export async function rollupAnalyticsDay(day: number): Promise<{ sites: number }> {
    const from = visitDay(day);
    const to = from + 86_400_000;
    const sites = await prisma.analyticsSite.findMany({ select: { id: true } });

    let touched = 0;
    for (const site of sites) {
        const [sessions, events] = await Promise.all([
            prisma.analyticsSession.findMany({
                where: { siteId: site.id, startedAt: { gte: new Date(from), lt: new Date(to) } }
            }),
            prisma.analyticsEvent.findMany({
                where: { siteId: site.id, at: { gte: new Date(from), lt: new Date(to) } },
                select: { sessionId: true, kind: true, name: true, path: true }
            })
        ]);
        if (sessions.length === 0) continue;

        const byId = new Map(sessions.map((session) => [session.id, session]));
        const viewsPerSession = new Map<string, number>();
        for (const event of events) {
            if (event.kind !== "pageview") continue;
            viewsPerSession.set(event.sessionId, (viewsPerSession.get(event.sessionId) ?? 0) + 1);
        }

        interface Cell {
            dimension: string;
            value: string;
            visitors: Set<string>;
            views: number;
            bounces: number;
            durationSec: number;
            measured: number;
        }
        const cells = new Map<string, Cell>();
        // The pair is kept on the cell rather than parsed back out of the key. A value
        // holds whatever a referrer or a browser name holds - "Hacker News", "Samsung
        // Internet" - so a key that has to be split apart again is a key that will one
        // day be split in the wrong place.
        const cell = (dimension: string, value: string): Cell => {
            const key = `${dimension}\t${value}`;
            let found = cells.get(key);
            if (!found) {
                found = { dimension, value, visitors: new Set(), views: 0, bounces: 0, durationSec: 0, measured: 0 };
                cells.set(key, found);
            }
            return found;
        };

        for (const session of sessions) {
            const views = viewsPerSession.get(session.id) ?? 0;
            const length = Math.max(0, Math.round((session.lastSeenAt.getTime() - session.startedAt.getTime()) / 1000));
            const bounced = views <= 1 ? 1 : 0;

            const total = cell("total", "");
            total.visitors.add(session.id);
            total.views += views;
            total.bounces += bounced;
            if (length > 0) {
                total.durationSec += length;
                total.measured += 1;
            }

            for (const [dimension, value] of [
                ["referrer", session.referrerSource ?? "Direct"],
                ["channel", session.referrerKind],
                ["browser", session.browser],
                ["os", session.os],
                ["device", session.device],
                ["country", session.country ?? ""]
            ] as const) {
                if (value === "") continue;
                const found = cell(dimension, value);
                found.visitors.add(session.id);
                found.views += views;
            }
        }

        for (const event of events) {
            if (!byId.has(event.sessionId)) continue;
            if (event.kind === "pageview") {
                const found = cell("path", event.path);
                found.visitors.add(event.sessionId);
                found.views += 1;
            } else if (event.name) {
                const found = cell("event", event.name);
                found.visitors.add(event.sessionId);
                found.views += 1;
            }
        }

        // Replace the day wholesale: a partial rewrite would leave yesterday's rows
        // for a value that no longer appears.
        await prisma.analyticsDay.deleteMany({ where: { siteId: site.id, day: new Date(from) } });
        const rows = [...cells.values()]
            .filter((entry) => entry.dimension === "total" || ROLLUP_DIMENSIONS.includes(entry.dimension as VisitDimension))
            .map((entry) => ({
                siteId: site.id,
                day: new Date(from),
                dimension: entry.dimension,
                value: entry.value,
                visitors: entry.visitors.size,
                views: entry.views,
                bounces: entry.bounces,
                durationSec: entry.durationSec,
                measured: entry.measured
            }));
        if (rows.length > 0) await prisma.analyticsDay.createMany({ data: rows });
        touched += 1;
    }
    return { sites: touched };
}

/**
 * Drop raw visits past the retention window, once their day has been folded.
 *
 * Order matters and is the reason these are one function: pruning before the rollup
 * would delete the only copy of a day nobody had summarised yet.
 */
export async function pruneAnalytics(now = Date.now()): Promise<{ days: number; sessions: number }> {
    const settings = await getAnalyticsSettings();
    const cutoff = visitDay(now) - settings.retentionDays * 86_400_000;

    // Yesterday and anything older is complete and can be folded. Today is still
    // moving, so it is left to the live query.
    const oldest = await prisma.analyticsSession.findFirst({
        where: { startedAt: { lt: new Date(visitDay(now)) } },
        orderBy: { startedAt: "asc" },
        select: { startedAt: true }
    });
    let days = 0;
    if (oldest) {
        // Bounded per pass so a first run against months of history does not hold the
        // process for minutes; the rest is picked up on the following ticks.
        for (let day = visitDay(oldest.startedAt.getTime()); day < visitDay(now) && days < 7; day += 86_400_000) {
            const already = await prisma.analyticsDay.findFirst({
                where: { day: new Date(day), dimension: "total" },
                select: { id: true }
            });
            if (already) continue;
            await rollupAnalyticsDay(day);
            days += 1;
        }
    }

    const removed = await prisma.analyticsSession.deleteMany({ where: { lastSeenAt: { lt: new Date(cutoff) } } });
    return { days, sessions: removed.count };
}

export type { AnalyticsScopeType };
