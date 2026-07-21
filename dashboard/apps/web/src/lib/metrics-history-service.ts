/**
 * Read side of the metrics time-series: resolve a subject and window to a downsampled
 * point array for charting. Ownership is enforced here (a subject is only served to
 * the user who owns the app or connection). Short windows read full-resolution raw
 * samples and downsample in JS; wide windows read the compact hourly rollups.
 */

import { prisma } from "@polaris/db";
import { MAX_POINTS, RAW_MAX_SPAN_MS, type MetricPoint, type MetricSubjectType } from "./metrics-shared";

/** Remove all history for a subject - called when the app/connection is deleted
 *  so orphaned series do not linger until retention sweeps them. */
export async function deleteMetricsForSubject(subjectType: MetricSubjectType, subjectId: string): Promise<void> {
    await prisma.metricSample.deleteMany({ where: { subjectType, subjectId } });
    await prisma.metricRollup.deleteMany({ where: { subjectType, subjectId } });
}

/** Confirm the subject exists and belongs to the owner before returning its data. */
async function subjectBelongsToOwner(
    subjectType: MetricSubjectType,
    subjectId: string,
    ownerId: string
): Promise<boolean> {
    if (subjectType === "app") {
        const app = await prisma.application.findFirst({
            where: { id: subjectId, environment: { project: { ownerId } } },
            select: { id: true }
        });
        return app != null;
    }
    const connection = await prisma.storageConnection.findFirst({
        where: { id: subjectId, ownerId },
        select: { id: true }
    });
    return connection != null;
}

function num(value: bigint | null): number | null {
    return value == null ? null : Number(value);
}

/** Average a column across a downsample bucket, ignoring gaps (null holes). */
function avg(values: (number | null)[]): number | null {
    const present = values.filter((value): value is number => value != null);
    if (present.length === 0) return null;
    return present.reduce((sum, value) => sum + value, 0) / present.length;
}

/** Collapse a dense point array to at most `max` points by averaging fixed-size
 *  windows - so a 6h/1d raw series returns a chart-friendly number of points. */
function downsample(points: MetricPoint[], max: number): MetricPoint[] {
    if (points.length <= max) return points;
    const size = Math.ceil(points.length / max);
    const out: MetricPoint[] = [];
    for (let i = 0; i < points.length; i += size) {
        const slice = points.slice(i, i + size);
        out.push({
            t: Math.round(avg(slice.map((point) => point.t)) ?? slice[0]!.t),
            cpuPercent: round1(avg(slice.map((point) => point.cpuPercent))),
            cpuTempC: round1(avg(slice.map((point) => point.cpuTempC))),
            memUsedBytes: roundInt(avg(slice.map((point) => point.memUsedBytes))),
            memTotalBytes: roundInt(avg(slice.map((point) => point.memTotalBytes))),
            diskUsedBytes: roundInt(avg(slice.map((point) => point.diskUsedBytes))),
            diskTotalBytes: roundInt(avg(slice.map((point) => point.diskTotalBytes)))
        });
    }
    return out;
}

function round1(value: number | null): number | null {
    return value == null ? null : Math.round(value * 10) / 10;
}

function roundInt(value: number | null): number | null {
    return value == null ? null : Math.round(value);
}

/**
 * The downsampled series for a subject over [from, to]. Returns null when the
 * subject does not belong to the owner (so the route answers 404, not 200-empty).
 */
export async function getMetricSeries(input: {
    subjectType: MetricSubjectType;
    subjectId: string;
    ownerId: string;
    from: Date;
    to: Date;
}): Promise<MetricPoint[] | null> {
    if (!(await subjectBelongsToOwner(input.subjectType, input.subjectId, input.ownerId))) return null;

    const spanMs = input.to.getTime() - input.from.getTime();
    if (spanMs <= RAW_MAX_SPAN_MS) {
        const rows = await prisma.metricSample.findMany({
            where: { subjectType: input.subjectType, subjectId: input.subjectId, ts: { gte: input.from, lte: input.to } },
            orderBy: { ts: "asc" }
        });
        const points = rows.map<MetricPoint>((row) => ({
            t: row.ts.getTime(),
            cpuPercent: row.cpuPercent,
            cpuTempC: row.cpuTempC,
            memUsedBytes: num(row.memUsedBytes),
            memTotalBytes: num(row.memTotalBytes),
            diskUsedBytes: num(row.diskUsedBytes),
            diskTotalBytes: num(row.diskTotalBytes)
        }));
        return downsample(points, MAX_POINTS);
    }

    const rows = await prisma.metricRollup.findMany({
        where: { subjectType: input.subjectType, subjectId: input.subjectId, bucket: { gte: input.from, lte: input.to } },
        orderBy: { bucket: "asc" }
    });
    return rows.map<MetricPoint>((row) => ({
        t: row.bucket.getTime(),
        cpuPercent: row.cpuPercentAvg,
        cpuTempC: row.cpuTempCAvg,
        memUsedBytes: num(row.memUsedBytesAvg),
        memTotalBytes: num(row.memTotalBytesAvg),
        diskUsedBytes: num(row.diskUsedBytesAvg),
        diskTotalBytes: num(row.diskTotalBytesAvg)
    }));
}
