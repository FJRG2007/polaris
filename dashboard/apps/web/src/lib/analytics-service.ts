/**
 * Recording and reading visits.
 *
 * A *site* is the thing being measured: one deployed service, or Polaris itself. It
 * is created the first time anything is recorded for it or the first time anyone
 * looks, so an operator never has to set one up before the numbers appear - which is
 * the whole point of folding the edge log in.
 *
 * Two sources write here. The edge's access log covers every deployed service with
 * no script and no configuration; the tracker adds what a log cannot see - how long
 * a visit lasted, the screen it was read on, the country, and custom events. Both go
 * through `recordVisit` so they cannot drift into counting differently.
 */

import { prisma } from "@polaris/db";
import { sessionWhere } from "@/lib/analytics-reports";
import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    ANALYTICS_DEFAULTS,
    analyticsSettingsSchema,
    groupVisitPath,
    parseVisitAgent,
    parseVisitSource,
    reportVisits,
    resolveCountry,
    visitDay,
    visitSessionId,
    analyticsSiteSettingsSchema,
    visitIpIgnored,
    visitPathMatches,
    type AnalyticsSettings,
    type AnalyticsSiteSettings,
    type VisitFilter,
    type VisitDimension,
    type VisitEventRow,
    type VisitRange,
    type VisitReport,
    type VisitRow,
    type VisitSessionRow,
    VISIT_RANGE_SPEC
} from "@polaris/core";

const SETTINGS_KEY = "analytics";
const SALT_KEY = "analytics.salt";

/** How long after its last beat a visit is considered over. Umami's number, and it
 *  matches what people mean by "one sitting". */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * `external` is a site that is not served from here at all - somebody's blog on
 * another host, measured with the tracker alone. Its scope id is
 * `<creator's user id>:<random>`, which is what makes the creator its owner
 * without a column of its own (see `externalSiteOwner`).
 */
export type AnalyticsScopeType = "polaris" | "application" | "external";

export interface AnalyticsSiteView {
    readonly id: string;
    readonly scopeType: AnalyticsScopeType;
    readonly scopeId: string;
    readonly name: string;
    readonly hostnames: readonly string[];
    readonly publicKey: string;
    readonly trackerEnabled: boolean;
    /** What this site never records. */
    readonly rules: AnalyticsSiteSettings;
}

// --- settings ---------------------------------------------------------------

export async function getAnalyticsSettings(): Promise<AnalyticsSettings> {
    const raw = await getSetting(SETTINGS_KEY);
    if (!raw) return ANALYTICS_DEFAULTS;
    const parsed = analyticsSettingsSchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data : ANALYTICS_DEFAULTS;
}

export async function setAnalyticsSettings(settings: AnalyticsSettings): Promise<void> {
    await setSetting(SETTINGS_KEY, JSON.stringify(analyticsSettingsSchema.parse(settings)));
}

/**
 * The salt that turns an address into today's session id.
 *
 * Rotated once a day and never exposed. Rotating is what makes the hash a session
 * rather than an identity: yesterday's ids cannot be recomputed, so there is nothing
 * to join across days even for whoever holds the database.
 */
async function dailySalt(now: number): Promise<string> {
    const day = visitDay(now);
    const raw = await getSetting(SALT_KEY);
    const saved = safeJson(raw) as { day?: number; salt?: string } | null;
    if (saved && saved.day === day && typeof saved.salt === "string") return saved.salt;
    const salt = randomBytes(32).toString("hex");
    await setSetting(SALT_KEY, JSON.stringify({ day, salt }));
    return salt;
}

// --- sites ------------------------------------------------------------------

/** The site for a scope, created on first use. */
export async function ensureAnalyticsSite(
    scopeType: AnalyticsScopeType,
    scopeId: string,
    name: string,
    hostnames: readonly string[] = []
): Promise<AnalyticsSiteView> {
    const existing = await prisma.analyticsSite.findUnique({ where: { scopeType_scopeId: { scopeType, scopeId } } });
    if (existing) {
        // The name and the domains are facts about the service, not about analytics -
        // so they follow a rename or a new domain instead of freezing at whatever they
        // were when the first visit happened.
        const hosts = JSON.stringify([...hostnames].sort());
        if (existing.name !== name || existing.hostnames !== hosts) {
            const updated = await prisma.analyticsSite.update({
                where: { id: existing.id },
                data: { name, hostnames: hosts }
            });
            return toSiteView(updated);
        }
        return toSiteView(existing);
    }
    const created = await prisma.analyticsSite.create({
        data: {
            scopeType,
            scopeId,
            name,
            hostnames: JSON.stringify([...hostnames].sort()),
            publicKey: randomBytes(16).toString("hex")
        }
    });
    return toSiteView(created);
}

export async function getAnalyticsSiteByKey(publicKey: string): Promise<AnalyticsSiteView | null> {
    const site = await prisma.analyticsSite.findUnique({ where: { publicKey } });
    return site ? toSiteView(site) : null;
}

/** What a site ignores, read on every recorded visit and so held briefly. */
const rulesCache = new Map<string, { at: number; rules: AnalyticsSiteSettings }>();
const RULES_TTL_MS = 30_000;

async function siteRules(siteId: string): Promise<AnalyticsSiteSettings> {
    const cached = rulesCache.get(siteId);
    if (cached && Date.now() - cached.at < RULES_TTL_MS) return cached.rules;
    const site = await prisma.analyticsSite.findUnique({
        where: { id: siteId },
        select: { excludedPaths: true, ignoredIps: true }
    });
    const rules = readRules(site);
    if (rulesCache.size > 5000) rulesCache.clear();
    rulesCache.set(siteId, { at: Date.now(), rules });
    return rules;
}

function readRules(site: { excludedPaths: string; ignoredIps: string } | null): AnalyticsSiteSettings {
    const parsed = analyticsSiteSettingsSchema.safeParse({
        excludedPaths: safeJson(site?.excludedPaths ?? "[]"),
        ignoredIps: safeJson(site?.ignoredIps ?? "[]")
    });
    return parsed.success ? parsed.data : { excludedPaths: [], ignoredIps: [] };
}

export async function setSiteRules(siteId: string, rules: AnalyticsSiteSettings): Promise<void> {
    await prisma.analyticsSite.update({
        where: { id: siteId },
        data: { excludedPaths: JSON.stringify(rules.excludedPaths), ignoredIps: JSON.stringify(rules.ignoredIps) }
    });
    rulesCache.delete(siteId);
}

export async function setTrackerEnabled(siteId: string, enabled: boolean): Promise<void> {
    await prisma.analyticsSite.update({ where: { id: siteId }, data: { trackerEnabled: enabled } });
}

/** Issue a new key. The old one stops working immediately; recorded history is
 *  untouched, because it hangs off the site rather than off the key. */
export async function rotateTrackerKey(siteId: string): Promise<string> {
    const publicKey = randomBytes(16).toString("hex");
    await prisma.analyticsSite.update({ where: { id: siteId }, data: { publicKey } });
    return publicKey;
}

function toSiteView(site: {
    id: string;
    scopeType: string;
    scopeId: string;
    name: string;
    hostnames: string;
    publicKey: string;
    trackerEnabled: boolean;
    excludedPaths?: string;
    ignoredIps?: string;
}): AnalyticsSiteView {
    const hostnames = safeJson(site.hostnames);
    return {
        id: site.id,
        scopeType: site.scopeType === "polaris" ? "polaris" : site.scopeType === "external" ? "external" : "application",
        scopeId: site.scopeId,
        name: site.name,
        hostnames: Array.isArray(hostnames) ? hostnames.filter((entry): entry is string => typeof entry === "string") : [],
        publicKey: site.publicKey,
        trackerEnabled: site.trackerEnabled,
        rules: readRules({ excludedPaths: site.excludedPaths ?? "[]", ignoredIps: site.ignoredIps ?? "[]" })
    };
}

// --- sites that are not served here -------------------------------------------

/** The account an external site's scope id names as its owner, or null. */
export function externalSiteOwner(scopeId: string): string | null {
    const match = /^([0-9a-f-]{36}):[0-9a-f]{12}$/i.exec(scopeId);
    return match ? match[1]!.toLowerCase() : null;
}

/** How many external sites one account may hold. A backstop, not a plan limit. */
export const EXTERNAL_SITE_CAP = 200;

/**
 * A site somebody runs elsewhere. Created with the tracker already accepting
 * beats, since the tracker is the only way such a site is ever measured - a
 * switch that has to be found and turned on before the first visit counts is
 * exactly the step a guided setup exists to remove.
 *
 * The hostname is kept for the screen and for telling the site's own links from
 * referrals; it is never matched against the edge log, which only ever routes
 * domains attached to a deployed service.
 */
export async function createExternalSite(
    ownerId: string,
    name: string,
    hostname: string
): Promise<AnalyticsSiteView | null> {
    const held = await prisma.analyticsSite.count({
        where: { scopeType: "external", scopeId: { startsWith: `${ownerId}:` } }
    });
    if (held >= EXTERNAL_SITE_CAP) return null;
    const created = await prisma.analyticsSite.create({
        data: {
            scopeType: "external",
            scopeId: `${ownerId}:${randomBytes(6).toString("hex")}`,
            name,
            hostnames: JSON.stringify(hostname ? [hostname] : []),
            publicKey: randomBytes(16).toString("hex"),
            trackerEnabled: true
        }
    });
    return toSiteView(created);
}

/** An external site by its scope id, or null. Never creates one. */
export async function findExternalSite(scopeId: string): Promise<AnalyticsSiteView | null> {
    const row = await prisma.analyticsSite.findUnique({
        where: { scopeType_scopeId: { scopeType: "external", scopeId } }
    });
    return row ? toSiteView(row) : null;
}

/** Rename an external site or change its address. Services follow their own. */
export async function updateExternalSite(siteId: string, name: string, hostname: string): Promise<void> {
    await prisma.analyticsSite.update({
        where: { id: siteId },
        data: { name, hostnames: JSON.stringify(hostname ? [hostname] : []) }
    });
}

/** Remove an external site and, by cascade, everything it recorded. */
export async function deleteExternalSite(siteId: string): Promise<void> {
    await prisma.analyticsSite.deleteMany({ where: { id: siteId, scopeType: "external" } });
}

/** The external sites an account owns, newest first, bounded. */
export async function ownedExternalSites(ownerId: string): Promise<{ scopeId: string; name: string }[]> {
    return prisma.analyticsSite.findMany({
        where: { scopeType: "external", scopeId: { startsWith: `${ownerId}:` } },
        orderBy: { createdAt: "desc" },
        take: EXTERNAL_SITE_CAP,
        select: { scopeId: true, name: true }
    });
}

/**
 * The first thing a site recorded, for the "check the installation" step: the
 * oldest event, and whether any of it came from the tracker rather than the edge
 * log (the tracker is the only source that sets a screen or a language, or that
 * sends a custom event).
 */
export async function firstRecorded(siteId: string): Promise<{ at: string; path: string; tracker: boolean } | null> {
    const [first, tracked] = await Promise.all([
        prisma.analyticsEvent.findFirst({
            where: { siteId },
            orderBy: { at: "asc" },
            select: { at: true, path: true }
        }),
        prisma.analyticsSession.findFirst({
            where: { siteId, OR: [{ screen: { not: null } }, { language: { not: null } }] },
            select: { id: true }
        })
    ]);
    if (!first) return null;
    return { at: first.at.toISOString(), path: first.path, tracker: tracked !== null };
}

// --- recording --------------------------------------------------------------

export interface VisitInput {
    readonly siteId: string;
    readonly at: number;
    readonly ip: string;
    readonly userAgent: string | null;
    /** Path, with or without a query. */
    readonly url: string;
    readonly referrer?: string | null;
    /** The site's own hostname, so its internal links are not counted as referrals
     *  from itself. */
    readonly self?: string | null;
    readonly kind?: "pageview" | "event";
    readonly name?: string | null;
    readonly props?: Record<string, unknown> | null;
    readonly language?: string | null;
    readonly screen?: string | null;
    readonly timezone?: string | null;
    readonly countryHeader?: string | null;
    /** Milliseconds the visitor spent, when the source can measure it. */
    readonly durationMs?: number | null;
    /** The site's own id for this visitor, from `polaris.identify()`. */
    readonly distinctId?: string | null;
    /** What `polaris.identify()` said about the visitor. */
    readonly data?: Record<string, unknown> | null;
}

/** Whether this site ignores this visit: an excluded page or an ignored address. */
async function ignored(input: VisitInput, path: string): Promise<boolean> {
    const rules = await siteRules(input.siteId);
    if (rules.ignoredIps.length && visitIpIgnored(rules.ignoredIps, input.ip)) return true;
    return rules.excludedPaths.some((pattern) => visitPathMatches(pattern, path));
}

/**
 * Record one visit beat.
 *
 * Idempotent per session in the sense that matters: the session row is upserted and
 * its clock extended, so the same visitor arriving over and over produces one
 * session and many events rather than many sessions. A beat that only extends the
 * clock (a duration report at the end of a page) writes no event.
 */
export async function recordVisit(input: VisitInput): Promise<void> {
    const settings = await getAnalyticsSettings();
    const agent = parseVisitAgent(input.userAgent);
    if (agent.device === "bot" && !settings.countBots) return;

    const [path, query] = splitUrl(input.url);
    if (await ignored(input, path)) return;
    const source = parseVisitSource(input.referrer ?? null, query, input.self ?? null);
    const salt = await dailySalt(input.at);
    const sessionId = await visitSessionId({
        salt,
        siteId: input.siteId,
        ip: input.ip,
        userAgent: input.userAgent ?? ""
    });

    const at = new Date(input.at);
    const kind = input.kind ?? "pageview";
    const country = resolveCountry(input.countryHeader ?? null, input.timezone ?? null);
    // A duration beat says the visit lasted this long from its start, which is a
    // better last-seen than "now" for a tab that was closed a while ago.
    const lastSeen = input.durationMs && input.durationMs > 0 ? new Date(input.at) : at;

    const common = {
        lastSeenAt: lastSeen,
        // These can arrive on a later beat than the first - the tracker knows the
        // screen and time zone, the edge log does not - so a known value replaces an
        // unknown one and never the other way round.
        ...(country ? { country } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.screen ? { screen: input.screen } : {}),
        ...(input.distinctId ? { distinctId: input.distinctId } : {}),
        ...(input.data ? { data: JSON.stringify(input.data) } : {})
    };

    await prisma.analyticsSession.upsert({
        where: { id: sessionId },
        create: {
            id: sessionId,
            siteId: input.siteId,
            startedAt: at,
            lastSeenAt: lastSeen,
            views: kind === "pageview" ? 1 : 0,
            ip: input.ip,
            browser: agent.browser,
            os: agent.os,
            device: agent.device,
            country,
            language: input.language ?? null,
            screen: input.screen ?? null,
            referrerKind: source.kind,
            referrerSource: source.source,
            campaign: source.campaign,
            medium: source.medium,
            distinctId: input.distinctId ?? null,
            data: input.data ? JSON.stringify(input.data) : null
        },
        update: {
            ...common,
            ...(kind === "pageview" ? { views: { increment: 1 } } : {})
        }
    });

    if (kind === "event" && !input.name) return;
    const grouped = groupVisitPath(path);
    await prisma.analyticsEvent.create({
        data: {
            siteId: input.siteId,
            sessionId,
            at,
            kind,
            name: input.name ?? null,
            path: grouped,
            rawPath: grouped === path ? null : path,
            props: input.props ? JSON.stringify(input.props) : null
        }
    });
}

/** Extend a visit without recording a page: what the tracker sends when a page is
 *  left, so the visit has a measured length instead of only a start. */
export async function recordVisitLeave(input: VisitInput): Promise<void> {
    const salt = await dailySalt(input.at);
    const sessionId = await visitSessionId({
        salt,
        siteId: input.siteId,
        ip: input.ip,
        userAgent: input.userAgent ?? ""
    });
    await prisma.analyticsSession.updateMany({
        where: { id: sessionId, siteId: input.siteId },
        data: { lastSeenAt: new Date(input.at) }
    });
}

/** Name the visit, from `polaris.identify()`. Writes no event and starts no visit:
 *  an identity on its own is not a visit to anything. */
export async function recordVisitIdentify(input: VisitInput): Promise<void> {
    if (!input.distinctId && !input.data) return;
    const salt = await dailySalt(input.at);
    const sessionId = await visitSessionId({
        salt,
        siteId: input.siteId,
        ip: input.ip,
        userAgent: input.userAgent ?? ""
    });
    await prisma.analyticsSession.updateMany({
        where: { id: sessionId, siteId: input.siteId },
        data: {
            ...(input.distinctId ? { distinctId: input.distinctId } : {}),
            ...(input.data ? { data: JSON.stringify(input.data) } : {})
        }
    });
}

// --- reading ----------------------------------------------------------------

export interface AnalyticsView extends VisitReport {
    readonly site: AnalyticsSiteView;
    readonly from: number;
    readonly to: number;
    /** Visitors active in the last five minutes. */
    readonly online: number;
    /** Whether these numbers came from the per-visit rows or from the daily totals.
     *  The screen says which, because the two do not answer the same questions. */
    readonly source: "raw" | "daily";
    /** The dimensions this source cannot answer, so the screen can say why a panel is
     *  empty instead of implying nobody used a screen size all quarter. */
    readonly unavailable: readonly VisitDimension[];
    /** Filters were asked for over a window only the daily totals answer, which
     *  cannot be narrowed - so these numbers are unfiltered and the screen says so. */
    readonly filtersIgnored: boolean;
}

/**
 * Longest window still answered from the per-visit rows.
 *
 * Past this the daily totals are read instead. Not an optimisation - a year of raw
 * requests on a busy service is millions of rows, and loading them to draw twelve
 * bars would take the process down. It is also why the rollup exists.
 */
const RAW_MAX_MS = 31 * 86_400_000;

/** A backstop for a service that gets a month of traffic in a day. Reaching it means
 *  the window is reported as truncated rather than silently wrong. */
const RAW_EVENT_CAP = 200_000;

/** What only the per-visit rows can answer. */
const RAW_ONLY: readonly VisitDimension[] = ["entry", "exit", "campaign", "language", "screen", "ip"];

export async function readAnalytics(
    site: AnalyticsSiteView,
    range: VisitRange,
    now = Date.now(),
    filters: readonly VisitFilter[] = []
): Promise<AnalyticsView> {
    const spec = VISIT_RANGE_SPEC[range];
    const from = now - spec.ms;
    const narrow = sessionWhere(filters);
    const online = await prisma.analyticsSession.count({
        where: { siteId: site.id, lastSeenAt: { gte: new Date(now - 5 * 60 * 1000) }, ...narrow }
    });

    if (spec.ms > RAW_MAX_MS) {
        const report = await reportFromDays(site.id, from, now, spec.buckets);
        return {
            ...report,
            site,
            from,
            to: now,
            online,
            source: "daily",
            unavailable: RAW_ONLY,
            filtersIgnored: filters.length > 0
        };
    }

    const [sessions, events] = await Promise.all([
        prisma.analyticsSession.findMany({
            where: { siteId: site.id, lastSeenAt: { gte: new Date(from) }, ...narrow },
            orderBy: { startedAt: "asc" }
        }),
        prisma.analyticsEvent.findMany({
            where: {
                siteId: site.id,
                at: { gte: new Date(from), lt: new Date(now) },
                ...(filters.length ? { session: { is: narrow } } : {})
            },
            orderBy: { at: "asc" },
            take: RAW_EVENT_CAP,
            select: { sessionId: true, at: true, kind: true, name: true, path: true }
        })
    ]);

    const report = reportVisits({
        sessions: sessions.map(toSessionRow),
        events: events.map(toEventRow),
        from,
        to: now,
        buckets: spec.buckets
    });
    return { ...report, site, from, to: now, online, source: "raw", unavailable: [], filtersIgnored: false };
}

/**
 * The same report, rebuilt from the daily totals.
 *
 * Coarser by construction: a day is the smallest bucket, and the dimensions the
 * rollup does not carry come back empty rather than approximated. Visitors are
 * summed across days, which counts a person who came back on two days twice - the
 * only thing it can mean when sessions are cookieless and rotate daily, and what the
 * screen labels it as.
 */
async function reportFromDays(siteId: string, from: number, to: number, buckets: number): Promise<VisitReport> {
    const rows = await prisma.analyticsDay.findMany({
        where: { siteId, day: { gte: new Date(visitDay(from)), lt: new Date(to) } },
        orderBy: { day: "asc" }
    });

    const totals = rows.filter((row) => row.dimension === "total");
    const views = totals.reduce((sum, row) => sum + row.views, 0);
    const visitors = totals.reduce((sum, row) => sum + row.visitors, 0);
    const bounces = totals.reduce((sum, row) => sum + row.bounces, 0);
    const durationSec = totals.reduce((sum, row) => sum + row.durationSec, 0);
    const measured = totals.reduce((sum, row) => sum + row.measured, 0);

    const width = Math.max(1, (to - from) / Math.max(1, buckets));
    const slots = Array.from({ length: Math.max(1, buckets) }, (_, index) => ({
        t: Math.round(from + index * width),
        views: 0,
        visitors: 0
    }));
    for (const row of totals) {
        const slot = slots[Math.min(slots.length - 1, Math.max(0, Math.floor((row.day.getTime() - from) / width)))];
        if (!slot) continue;
        slot.views += row.views;
        slot.visitors += row.visitors;
    }

    const rank = (dimension: VisitDimension) => {
        const tally = new Map<string, { visitors: number; views: number }>();
        for (const row of rows) {
            if (row.dimension !== dimension) continue;
            const cell = tally.get(row.value) ?? { visitors: 0, views: 0 };
            cell.visitors += row.visitors;
            cell.views += row.views;
            tally.set(row.value, cell);
        }
        return [...tally]
            .map(([key, cell]) => ({ key, ...cell }))
            .sort((a, b) => b.visitors - a.visitors || b.views - a.views || (a.key < b.key ? -1 : 1))
            .slice(0, 10);
    };

    const empty: VisitRow[] = [];
    return {
        overview: {
            visitors,
            sessions: visitors,
            views,
            events: rows.filter((row) => row.dimension === "event").reduce((sum, row) => sum + row.views, 0),
            bounceRate: visitors > 0 ? bounces / visitors : null,
            avgVisitSec: measured > 0 ? Math.round(durationSec / measured) : null,
            viewsPerSession: visitors > 0 ? views / visitors : null
        },
        series: slots,
        breakdowns: {
            path: rank("path"),
            entry: empty,
            exit: empty,
            referrer: rank("referrer"),
            channel: rank("channel"),
            campaign: empty,
            browser: rank("browser"),
            os: rank("os"),
            device: rank("device"),
            country: rank("country"),
            language: empty,
            screen: empty,
            event: rank("event"),
            ip: empty
        }
    };
}

/** The most recent visits, for the live list. Sessions rather than events: the
 *  question this answers is "who is here", not "what was fetched". */
export async function recentVisits(
    siteId: string,
    limit = 25,
    options: { filters?: readonly VisitFilter[]; before?: Date | null } = {}
) {
    const sessions = await prisma.analyticsSession.findMany({
        where: {
            siteId,
            ...(options.before ? { lastSeenAt: { lt: options.before } } : {}),
            ...sessionWhere(options.filters ?? [])
        },
        orderBy: { lastSeenAt: "desc" },
        take: Math.min(limit, 200)
    });
    const ids = sessions.map((session) => session.id);
    const events = ids.length
        ? await prisma.analyticsEvent.findMany({
              where: { sessionId: { in: ids }, kind: "pageview" },
              orderBy: { at: "desc" },
              select: { sessionId: true, path: true, at: true }
          })
        : [];
    const latest = new Map<string, { path: string; at: Date }>();
    for (const event of events) if (!latest.has(event.sessionId)) latest.set(event.sessionId, event);

    return sessions.map((session) => ({
        id: session.id,
        ip: session.ip,
        browser: session.browser,
        os: session.os,
        device: session.device,
        country: session.country,
        language: session.language,
        referrerKind: session.referrerKind,
        referrerSource: session.referrerSource,
        distinctId: session.distinctId,
        views: session.views,
        startedAt: session.startedAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        durationSec: Math.max(0, Math.round((session.lastSeenAt.getTime() - session.startedAt.getTime()) / 1000)),
        lastPath: latest.get(session.id)?.path ?? null
    }));
}

function toSessionRow(session: {
    id: string;
    startedAt: Date;
    lastSeenAt: Date;
    views: number;
    ip: string | null;
    browser: string;
    os: string;
    device: string;
    country: string | null;
    language: string | null;
    screen: string | null;
    referrerKind: string;
    referrerSource: string | null;
    campaign: string | null;
    medium: string | null;
}): VisitSessionRow {
    return {
        id: session.id,
        startedAt: session.startedAt.getTime(),
        lastSeenAt: session.lastSeenAt.getTime(),
        views: session.views,
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
        medium: session.medium
    };
}

function toEventRow(event: { sessionId: string; at: Date; kind: string; name: string | null; path: string }): VisitEventRow {
    return {
        sessionId: event.sessionId,
        at: event.at.getTime(),
        kind: event.kind === "event" ? "event" : "pageview",
        name: event.name,
        path: event.path
    };
}

function splitUrl(url: string): [string, string | null] {
    const trimmed = url.trim() || "/";
    // Only the path is trusted from a client. An absolute URL is reduced to its path
    // rather than rejected, because a tracker on a page with a base tag will send one.
    const withoutOrigin = /^https?:\/\//i.test(trimmed) ? (trimmed.replace(/^https?:\/\/[^/]*/i, "") || "/") : trimmed;
    const hash = withoutOrigin.split("#")[0] ?? "/";
    const index = hash.indexOf("?");
    if (index === -1) return [hash || "/", null];
    return [hash.slice(0, index) || "/", hash.slice(index + 1)];
}

function safeJson(raw: string | null): unknown {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
