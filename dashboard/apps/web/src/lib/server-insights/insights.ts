/**
 * Server insights: what was unusual on each machine lately, and when its disk
 * fills.
 *
 * Worked out on read from the hourly rollups the metrics collector already keeps
 * for every server, so there is no process of its own and nothing stored beyond
 * what the charts already read. Fourteen days of hours per server is a few hundred
 * rows, which is the whole cost of a page view; the hourly maintenance tick asks
 * the same question once to decide whether anybody needs telling.
 */

import { prisma } from "@polaris/db";
import {
    ANOMALY_MIN_HISTORY,
    bucketize,
    detectAnomalies,
    forecastDisk,
    type AnomalyEpisode,
    type AnomalyOptions,
    type DiskForecast,
    type DiskPoint,
    type SeriesPoint
} from "./stats";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How far back the rollups are read: the forecast's span, and the anomalies' history. */
export const HISTORY_MS = 14 * DAY_MS;

/** How far back unusual stretches are listed. */
export const ANOMALY_LOOKBACK_MS = 7 * DAY_MS;

/** Under this many days to full, a disk is worth a warning. */
export const FORECAST_WARN_DAYS = 14;

/** The most unusual stretches listed per server, newest first. */
const MAX_ANOMALIES = 40;

export const INSIGHT_METRICS = ["cpu", "memory", "disk", "network"] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number];

/** Per metric: the smallest move worth a line, in that metric's own units. CPU,
 *  memory and disk are percentages of the machine; network is bytes per second. */
const MIN_DELTA: Record<InsightMetric, number> = {
    cpu: 15,
    memory: 10,
    disk: 5,
    network: 512 * 1024
};

/** The day before a point is its normal; a modified z-score of 3.5 is the usual
 *  cut-off for "an outlier" with this measure. */
const DETECTION: Omit<AnomalyOptions, "minDelta"> = { window: 24, minHistory: ANOMALY_MIN_HISTORY, threshold: 3.5 };

/** Twice the threshold is no longer a wobble. */
const DANGER_SCORE = DETECTION.threshold * 2;

export interface InsightAnomaly extends AnomalyEpisode {
    metric: InsightMetric;
    severity: "warning" | "danger";
}

export interface ServerInsight {
    /** The metrics subject id of the server. */
    subject: string;
    anomalies: InsightAnomaly[];
    forecast: DiskForecast;
    /** Whether the forecast is close enough to warn about. */
    diskWarning: boolean;
    /** Hours of readings read, so an empty list can tell "calm" from "too new to judge". */
    historyHours: number;
}

/** One hourly rollup row, as read. */
export interface RollupRow {
    subjectId: string;
    bucket: Date;
    cpuPercentAvg: number | null;
    memUsedBytesAvg: bigint | null;
    memTotalBytesAvg: bigint | null;
    diskUsedBytesAvg: bigint | null;
    diskTotalBytesAvg: bigint | null;
    netRxBytesSum: bigint | null;
    netTxBytesSum: bigint | null;
}

function share(used: bigint | null, total: bigint | null): number | null {
    if (used == null || total == null || total <= 0n) return null;
    return (Number(used) / Number(total)) * 100;
}

function metricValue(row: RollupRow, metric: InsightMetric): number | null {
    switch (metric) {
        case "cpu":
            return row.cpuPercentAvg;
        case "memory":
            return share(row.memUsedBytesAvg, row.memTotalBytesAvg);
        case "disk":
            return share(row.diskUsedBytesAvg, row.diskTotalBytesAvg);
        case "network":
            if (row.netRxBytesSum == null && row.netTxBytesSum == null) return null;
            return (Number(row.netRxBytesSum ?? 0n) + Number(row.netTxBytesSum ?? 0n)) / 3600;
    }
}

/** Whether a forecast is close enough to full to warn about. */
export function forecastWarns(forecast: DiskForecast): boolean {
    return forecast.kind === "full" || (forecast.kind === "filling" && forecast.days <= FORECAST_WARN_DAYS);
}

/** One server's insights from its rollup rows (sorted by bucket). Pure. */
export function insightFromRows(subject: string, rows: readonly RollupRow[], now: number): ServerInsight {
    const anomalies: InsightAnomaly[] = [];
    for (const metric of INSIGHT_METRICS) {
        const series: SeriesPoint[] = rows.map((row) => ({ t: row.bucket.getTime(), v: metricValue(row, metric) }));
        const episodes = detectAnomalies(bucketize(series, HOUR_MS), { ...DETECTION, minDelta: MIN_DELTA[metric] });
        for (const episode of episodes) {
            if (episode.end < now - ANOMALY_LOOKBACK_MS) continue;
            anomalies.push({ ...episode, metric, severity: episode.score >= DANGER_SCORE ? "danger" : "warning" });
        }
    }
    anomalies.sort((a, b) => b.start - a.start);

    const disk: DiskPoint[] = [];
    for (const row of rows) {
        if (row.diskUsedBytesAvg == null || row.diskTotalBytesAvg == null) continue;
        disk.push({ t: row.bucket.getTime(), used: Number(row.diskUsedBytesAvg), total: Number(row.diskTotalBytesAvg) });
    }
    const forecast = forecastDisk(disk);
    return {
        subject,
        anomalies: anomalies.slice(0, MAX_ANOMALIES),
        forecast,
        diskWarning: forecastWarns(forecast),
        historyHours: rows.length
    };
}

/** Insights for the given server subjects, in one read of their rollups. The
 *  caller has already established that the reader may see each of them. */
export async function readServerInsights(subjects: readonly string[], now = new Date()): Promise<ServerInsight[]> {
    if (subjects.length === 0) return [];
    const rows = await prisma.metricRollup.findMany({
        where: {
            subjectType: "host",
            subjectId: { in: [...subjects] },
            bucket: { gte: new Date(now.getTime() - HISTORY_MS) }
        },
        orderBy: { bucket: "asc" },
        select: {
            subjectId: true,
            bucket: true,
            cpuPercentAvg: true,
            memUsedBytesAvg: true,
            memTotalBytesAvg: true,
            diskUsedBytesAvg: true,
            diskTotalBytesAvg: true,
            netRxBytesSum: true,
            netTxBytesSum: true
        }
    });
    const bySubject = new Map<string, RollupRow[]>();
    for (const row of rows) {
        const list = bySubject.get(row.subjectId);
        if (list) list.push(row);
        else bySubject.set(row.subjectId, [row]);
    }
    return subjects.map((subject) => insightFromRows(subject, bySubject.get(subject) ?? [], now.getTime()));
}
