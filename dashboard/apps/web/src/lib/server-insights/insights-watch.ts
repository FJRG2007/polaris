/**
 * Tell the administrators when a server does something unusual, or its disk is
 * about to fill.
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

export async function watchServerInsights(now = new Date()): Promise<void> {
    const hosts = await prisma.host.findMany({ select: { id: true, name: true } });
    const names = new Map<string, string>(hosts.map((host) => [host.id, host.name]));
    names.set(LOCAL_HOST_SUBJECT, (await getLocalServerName().catch(() => null)) || LOCAL_SERVER_FALLBACK_NAME);
    const insights = await readServerInsights([...names.keys()], now);

    const rawMark = await getSetting(WATERMARK_KEY).catch(() => null);
    const watermark = rawMark && Number.isFinite(Number(rawMark)) ? Number(rawMark) : null;
    const fresh = freshAnomalies(insights, watermark, now.getTime());

    const warned = await readWarned();
    const toWarn = insights.filter((insight) => insight.diskWarning && !warned.has(insight.subject));
    const nextWarned = insights.filter((insight) => insight.diskWarning).map((insight) => insight.subject);

    if (fresh.length > 0 || toWarn.length > 0) {
        const admins = await prisma.user
            .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
            .catch(() => []);
        for (const admin of admins) {
            const t = await wordsFor(admin.id, "notices");
            for (const { subject, anomaly } of fresh) {
                const metric = t(`serverInsights.metrics.${anomaly.metric}`);
                await notify({
                    userId: admin.id,
                    event: "server.anomaly",
                    title: t(anomaly.direction === "high" ? "serverInsights.highTitle" : "serverInsights.lowTitle", {
                        server: names.get(subject) ?? "",
                        metric
                    }),
                    body: t("serverInsights.anomalyBody", {
                        value: sayValue(anomaly.metric, anomaly.peakValue),
                        usual: sayValue(anomaly.metric, anomaly.baseline)
                    }),
                    level: anomaly.severity,
                    audience: "admins",
                    href: "/apps/servers/insights",
                    metadata: { subject, metric: anomaly.metric, start: anomaly.start }
                }).catch((error: unknown) => console.error("polaris: could not report a server anomaly:", error));
            }
            for (const insight of toWarn) {
                const forecast = insight.forecast;
                const server = names.get(insight.subject) ?? "";
                const full = forecast.kind === "full";
                await notify({
                    userId: admin.id,
                    event: "server.forecast",
                    title: full
                        ? t("serverInsights.fullTitle", { server })
                        : t("serverInsights.fillsTitle", {
                              server,
                              days: forecast.kind === "filling" ? Math.max(1, Math.round(forecast.days)) : 0
                          }),
                    body:
                        forecast.kind === "filling" || forecast.kind === "full"
                            ? t("serverInsights.fillsBody", {
                                  rate: formatBytes(Math.max(0, Math.round(forecast.bytesPerDay))),
                                  free: formatBytes(Math.max(0, forecast.totalBytes - forecast.usedBytes))
                              })
                            : "",
                    audience: "admins",
                    actionRequired: true,
                    href: `/apps/servers/${encodeURIComponent(hostRouteId(insight.subject))}`
                }).catch((error: unknown) => console.error("polaris: could not report a disk forecast:", error));
            }
        }
    }

    const latest = Math.max(watermark ?? now.getTime() - FIRST_RUN_MS, ...fresh.map((one) => one.anomaly.start));
    await setSetting(WATERMARK_KEY, String(latest));
    await setSetting(WARNED_KEY, JSON.stringify(nextWarned));
}
