/**
 * Traffic spike and drop alerts, and the weekly or monthly summary, for the
 * sites people follow in Analytics.
 *
 * Plausible's traffic notifications (https://plausible.io/docs/traffic-spikes)
 * and Pulse's summary notifications, delivered the only way Polaris delivers
 * anything: as a notification in the bell. Each reader sets their own on a site
 * (`AnalyticsAlert`), so a notice only ever reaches somebody the site is visible
 * to - checked again on every pass, and a row whose reader lost the site is
 * dropped rather than kept telling them about it.
 *
 * Spike: that many visitors on the site at once (the realtime panel's
 * five-minute window), told at most once every 12 hours. Drop: fewer than that
 * many visitors in the last 24 hours, told at most once a day, and never for a
 * site younger than a day. Summary: the totals of the last 7 or 30 days against
 * the window before, from the raw visits (both windows stay inside retention).
 */

import { prisma } from "@polaris/db";
import { usersWithPermission } from "@polaris/auth";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { siteAccess } from "@/app/(app)/analytics/site-access";
import type { AnalyticsScopeType } from "@/lib/analytics-service";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ALERT_DIGESTS = ["off", "weekly", "monthly"] as const;
export type AlertDigest = (typeof ALERT_DIGESTS)[number];

/** How far apart two notices of one kind may be. */
export const SPIKE_GAP_MS = 12 * HOUR;
export const DROP_GAP_MS = DAY;
export const DIGEST_SPAN_MS: Readonly<Record<Exclude<AlertDigest, "off">, number>> = { weekly: 7 * DAY, monthly: 30 * DAY };

/** The window the realtime panel calls "on the site now". */
const ONLINE_MS = 5 * 60 * 1000;

/** Rows read per page of a pass. */
const PAGE = 200;

/** Whether a gap has passed since the last notice of a kind (or there was none). */
export function due(lastSent: Date | null, gapMs: number, now: number): boolean {
    return !lastSent || now - lastSent.getTime() >= gapMs;
}

/** Whether the visitors on the site now are a spike for this threshold. */
export function isSpike(online: number, threshold: number | null): boolean {
    return threshold !== null && threshold > 0 && online >= threshold;
}

/** Whether the visitors of the last day are a drop: only for a site at least a day old. */
export function isDrop(visitors: number, threshold: number | null, siteCreatedAt: Date, now: number): boolean {
    return threshold !== null && threshold > 0 && visitors < threshold && now - siteCreatedAt.getTime() >= DAY;
}

/** Signed percent change, or null when there was nothing before to compare with. */
export function percentChange(current: number, previous: number): number | null {
    if (previous <= 0) return null;
    return Math.round(((current - previous) / previous) * 100);
}

interface AlertRow {
    id: string;
    userId: string;
    spikeVisitors: number | null;
    dropVisitors: number | null;
    digest: string;
    spikeSentAt: Date | null;
    dropSentAt: Date | null;
    digestSentAt: Date | null;
    createdAt: Date;
    site: { id: string; name: string; scopeType: string; scopeId: string; createdAt: Date };
}

async function windowTotals(siteId: string, from: number, to: number): Promise<{ visitors: number; views: number }> {
    const sum = await prisma.analyticsSession.aggregate({
        where: { siteId, startedAt: { gte: new Date(from), lt: new Date(to) } },
        _count: { _all: true },
        _sum: { views: true }
    });
    return { visitors: sum._count._all, views: sum._sum.views ?? 0 };
}

function siteHref(site: AlertRow["site"]): string {
    const query = new URLSearchParams({ scope: site.scopeType, id: site.scopeId }).toString();
    return `/analytics?${query}`;
}

/** One row's pass: what is due is told and stamped; never throws. */
async function checkOne(row: AlertRow, operators: ReadonlySet<string>, now: number): Promise<void> {
    const access = await siteAccess(
        row.userId,
        operators.has(row.userId),
        row.site.scopeType as AnalyticsScopeType,
        row.site.scopeId
    ).catch(() => undefined);
    if (access === undefined) return;
    if (access === null) {
        await prisma.analyticsAlert.deleteMany({ where: { id: row.id } });
        return;
    }

    // Loaded here, not at the top: the settings actions import this module, and
    // the dispatcher's own imports have no business in every action call.
    const [{ notify }, { wordsFor }] = await Promise.all([
        import("@/lib/notifications/dispatch"),
        import("@/lib/notifications/notice-words")
    ]);
    const t = await wordsFor(row.userId, "notices");
    const href = siteHref(row.site);
    const stamp: { spikeSentAt?: Date; dropSentAt?: Date; digestSentAt?: Date } = {};

    if (row.spikeVisitors !== null && due(row.spikeSentAt, SPIKE_GAP_MS, now)) {
        const online = await prisma.analyticsSession.count({
            where: { siteId: row.site.id, lastSeenAt: { gte: new Date(now - ONLINE_MS) } }
        });
        if (isSpike(online, row.spikeVisitors)) {
            await notify({
                userId: row.userId,
                event: "analytics.traffic",
                title: t("analytics.spikeTitle", { site: row.site.name }),
                body: t("analytics.spikeBody", { count: online }),
                href,
                level: "info",
                metadata: { siteId: row.site.id, kind: "spike", online }
            });
            stamp.spikeSentAt = new Date(now);
        }
    }

    if (row.dropVisitors !== null && due(row.dropSentAt, DROP_GAP_MS, now)) {
        const visitors = await prisma.analyticsSession.count({
            where: { siteId: row.site.id, lastSeenAt: { gte: new Date(now - DAY) } }
        });
        if (isDrop(visitors, row.dropVisitors, row.site.createdAt, now)) {
            await notify({
                userId: row.userId,
                event: "analytics.traffic",
                title: t("analytics.dropTitle", { site: row.site.name }),
                body: t("analytics.dropBody", { count: visitors, threshold: row.dropVisitors }),
                href,
                level: "warning",
                metadata: { siteId: row.site.id, kind: "drop", visitors }
            });
            stamp.dropSentAt = new Date(now);
        }
    }

    if (row.digest === "weekly" || row.digest === "monthly") {
        const span = DIGEST_SPAN_MS[row.digest];
        // The first summary comes a whole period after it was asked for, not at once.
        const since = row.digestSentAt ?? row.createdAt;
        if (due(since, span, now)) {
            const [current, previous] = await Promise.all([
                windowTotals(row.site.id, now - span, now),
                windowTotals(row.site.id, now - 2 * span, now - span)
            ]);
            const change = (a: number, b: number) => {
                const pct = percentChange(a, b);
                if (pct === null) return t("analytics.noPrevious");
                if (pct === 0) return t("analytics.noChange");
                return `${pct > 0 ? "+" : ""}${pct}%`;
            };
            await notify({
                userId: row.userId,
                event: "analytics.digest",
                title: t(row.digest === "weekly" ? "analytics.weeklyTitle" : "analytics.monthlyTitle", { site: row.site.name }),
                body: t("analytics.digestBody", {
                    visitors: current.visitors,
                    views: current.views,
                    visitorsChange: change(current.visitors, previous.visitors),
                    viewsChange: change(current.views, previous.views)
                }),
                href,
                metadata: { siteId: row.site.id, kind: row.digest, ...current }
            });
            stamp.digestSentAt = new Date(now);
        }
    }

    if (Object.keys(stamp).length) await prisma.analyticsAlert.updateMany({ where: { id: row.id }, data: stamp });
}

/**
 * One pass over every alert that is switched on. Paged by id, so a large
 * instance is read a page at a time; one row failing does not stop the rest.
 */
export async function runAnalyticsAlerts(now = Date.now()): Promise<number | { skipped: string }> {
    if (!(await isAppInstalled("analytics"))) return { skipped: "Analytics is not installed" };
    const operators = new Set(await usersWithPermission("system.manage"));
    let cursor: string | undefined;
    let checked = 0;
    for (;;) {
        const rows: AlertRow[] = await prisma.analyticsAlert.findMany({
            where: { OR: [{ spikeVisitors: { not: null } }, { dropVisitors: { not: null } }, { digest: { not: "off" } }] },
            select: {
                id: true,
                userId: true,
                spikeVisitors: true,
                dropVisitors: true,
                digest: true,
                spikeSentAt: true,
                dropSentAt: true,
                digestSentAt: true,
                createdAt: true,
                site: { select: { id: true, name: true, scopeType: true, scopeId: true, createdAt: true } }
            },
            orderBy: { id: "asc" },
            take: PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        for (const row of rows) {
            await checkOne(row, operators, now).catch((error) =>
                console.error("polaris: an analytics alert check failed:", error)
            );
        }
        checked += rows.length;
        if (rows.length < PAGE) return checked;
        cursor = rows[rows.length - 1]?.id;
    }
}

export interface AlertSettings {
    readonly spikeVisitors: number | null;
    readonly dropVisitors: number | null;
    readonly digest: AlertDigest;
}

export const NO_ALERTS: AlertSettings = { spikeVisitors: null, dropVisitors: null, digest: "off" };

export async function readAlertSettings(siteId: string, userId: string): Promise<AlertSettings> {
    const row = await prisma.analyticsAlert.findUnique({
        where: { siteId_userId: { siteId, userId } },
        select: { spikeVisitors: true, dropVisitors: true, digest: true }
    });
    if (!row) return NO_ALERTS;
    const digest = (ALERT_DIGESTS as readonly string[]).includes(row.digest) ? (row.digest as AlertDigest) : "off";
    return { spikeVisitors: row.spikeVisitors, dropVisitors: row.dropVisitors, digest };
}

/** Save one reader's settings; all off removes the row. A changed summary starts its period again. */
export async function writeAlertSettings(siteId: string, userId: string, next: AlertSettings): Promise<void> {
    if (next.spikeVisitors === null && next.dropVisitors === null && next.digest === "off") {
        await prisma.analyticsAlert.deleteMany({ where: { siteId, userId } });
        return;
    }
    const current = await readAlertSettings(siteId, userId);
    const restart = current.digest !== next.digest ? { digestSentAt: new Date() } : {};
    await prisma.analyticsAlert.upsert({
        where: { siteId_userId: { siteId, userId } },
        create: { siteId, userId, ...next, digestSentAt: new Date() },
        update: { ...next, ...restart }
    });
}
