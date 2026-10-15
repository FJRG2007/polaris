/**
 * Tell the administrators when a server does something unusual, or its disk is
 * about to fill.
 *
 * Each server's owner is told; the box Polaris runs on has no owner, so every
 * administrator is told about that one.
 *
 * Run from the metrics collector's hourly maintenance, right after the hour's
 * rollups are written - no timer of its own. Each unusual stretch is told once,
 * when it starts: a watermark of the latest start already told is kept in
 * settings, and on the very first run only the last few hours count, so turning
 * this on does not replay a week of history into the bell. A disk forecast is
 * told when it first crosses the warning line and again only after it has gone
 * back above it.
 */

import { formatBytes } from "@polaris/core";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getSetting, setSetting } from "@/lib/setting-store";
import { hostRouteId, LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { readServerInsights, type InsightAnomaly, type InsightMetric, type ServerInsight } from "./insights";

const WATERMARK_KEY = "servers.insights.watermark";
const WARNED_KEY = "servers.insights.diskWarned";
const HOUR_MS = 3_600_000;

/** How far back the first run looks, so a fresh install is not told a week at once. */
const FIRST_RUN_MS = 3 * HOUR_MS;

/** A metric's value as it is said in a notice. */
function sayValue(metric: InsightMetric, value: number): string {
    return metric === "network" ? `${formatBytes(Math.round(value))}/s` : `${Math.round(value)}%`;
}

/** The unusual stretches this run should tell, given what was told before. Pure. */
export function freshAnomalies(
    insights: readonly ServerInsight[],
    watermark: number | null,
    now: number
): { subject: string; anomaly: InsightAnomaly }[] {
    const since = watermark ?? now - FIRST_RUN_MS;
    const fresh: { subject: string; anomaly: InsightAnomaly }[] = [];
    for (const insight of insights) {
        for (const anomaly of insight.anomalies) {
            if (anomaly.start > since) fresh.push({ subject: insight.subject, anomaly });
        }
    }
    return fresh;
}

async function readWarned(): Promise<Set<string>> {
    const raw = await getSetting(WARNED_KEY).catch(() => null);
    try {
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : []);
    } catch {
        return new Set();
    }
}

/** Servers read per query, so one tick holds a bounded number of rollup rows
 *  (about 340 per server) however many machines are registered. */
const CHUNK = 25;

/** Who hears about a server: its owner, or every administrator for the box
 *  Polaris runs on, which has no owner of its own. */
function recipientsFor(subject: string, owners: Map<string, string>, admins: readonly string[]): string[] {
    if (subject === LOCAL_HOST_SUBJECT) return [...admins];
    const owner = owners.get(subject);
    return owner ? [owner] : [];
}

async function tell(
    userId: string,
    subject: string,
    server: string,
    anomalies: readonly InsightAnomaly[],
    forecast: ServerInsight["forecast"] | null
): Promise<void> {
    const t = await wordsFor(userId, "notices");
    for (const anomaly of anomalies) {
        await notify({
            userId,
            event: "server.anomaly",
            title: t(anomaly.direction === "high" ? "serverInsights.highTitle" : "serverInsights.lowTitle", {
                server,
                metric: t(`serverInsights.metrics.${anomaly.metric}`)
            }),
            body: t("serverInsights.anomalyBody", {
                value: sayValue(anomaly.metric, anomaly.peakValue),
                usual: sayValue(anomaly.metric, anomaly.baseline)
            }),
            level: anomaly.severity,
            audience: subject === LOCAL_HOST_SUBJECT ? "admins" : "you",
            href: `/apps/servers/insights?server=${encodeURIComponent(hostRouteId(subject))}`,
            metadata: { subject, metric: anomaly.metric, start: anomaly.start }
        }).catch((error: unknown) => console.error("polaris: could not report a server anomaly:", error));
    }
    if (!forecast || (forecast.kind !== "filling" && forecast.kind !== "full")) return;
    await notify({
        userId,
        event: "server.forecast",
        title:
            forecast.kind === "full"
                ? t("serverInsights.fullTitle", { server })
                : t("serverInsights.fillsTitle", { server, days: Math.max(1, Math.round(forecast.days)) }),
        body: t("serverInsights.fillsBody", {
            rate: formatBytes(Math.max(0, Math.round(forecast.bytesPerDay))),
            free: formatBytes(Math.max(0, forecast.totalBytes - forecast.usedBytes))
        }),
        level: forecast.kind === "full" ? "danger" : "warning",
        audience: subject === LOCAL_HOST_SUBJECT ? "admins" : "you",
        actionRequired: true,
        href: `/apps/servers/${encodeURIComponent(hostRouteId(subject))}`
    }).catch((error: unknown) => console.error("polaris: could not report a disk forecast:", error));
}

export async function watchServerInsights(now = new Date()): Promise<void> {
    const hosts = await prisma.host.findMany({ select: { id: true, name: true, ownerId: true } });
    const names = new Map<string, string>(hosts.map((host) => [host.id, host.name]));
    const owners = new Map<string, string>(hosts.map((host) => [host.id, host.ownerId]));
    names.set(LOCAL_HOST_SUBJECT, (await getLocalServerName().catch(() => null)) || LOCAL_SERVER_FALLBACK_NAME);

    const rawMark = await getSetting(WATERMARK_KEY).catch(() => null);
    const watermark = rawMark && Number.isFinite(Number(rawMark)) ? Number(rawMark) : null;
    const warned = await readWarned();
    const admins = (
        await prisma.user.findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } }).catch(() => [])
    ).map((user) => user.id);
    // An owner who was removed or hidden is not told; nor is anybody in their place.
    const visible = new Set([
        ...admins,
        ...(
            await prisma.user
                .findMany({ where: { id: { in: [...new Set(owners.values())] }, ...VISIBLE_USER }, select: { id: true } })
                .catch(() => [])
        ).map((user) => user.id)
    ]);

    const subjects = [...names.keys()];
    const nextWarned: string[] = [];
    let latest = watermark ?? now.getTime() - FIRST_RUN_MS;
    for (let index = 0; index < subjects.length; index += CHUNK) {
        const insights = await readServerInsights(subjects.slice(index, index + CHUNK), now);
        const fresh = freshAnomalies(insights, watermark, now.getTime());
        for (const insight of insights) {
            if (insight.diskWarning) nextWarned.push(insight.subject);
            const anomalies = fresh.filter((one) => one.subject === insight.subject).map((one) => one.anomaly);
            for (const anomaly of anomalies) latest = Math.max(latest, anomaly.start);
            const forecast = insight.diskWarning && !warned.has(insight.subject) ? insight.forecast : null;
            if (anomalies.length === 0 && !forecast) continue;
            const server = names.get(insight.subject) ?? "";
            for (const userId of recipientsFor(insight.subject, owners, admins)) {
                if (!visible.has(userId)) continue;
                await tell(userId, insight.subject, server, anomalies, forecast);
            }
        }
    }

    await setSetting(WATERMARK_KEY, String(latest));
    await setSetting(WARNED_KEY, JSON.stringify(nextWarned));
}
