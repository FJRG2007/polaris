/**
 * Read side of the metrics time-series: resolve a subject and window to a downsampled
 * point array for charting. Ownership is enforced here (a subject is only served to
 * the user who owns the app or connection). Short windows read full-resolution raw
 * samples and downsample in JS; wide windows read the compact hourly rollups.
 *
 * Two things are worked out here rather than stored. Bandwidth is kept as the
 * container's own counters, which only ever climb, so it is turned into a rate
 * against the gap between readings. And a service's disk is not its own column at
 * all - what fills up is the volumes it mounts, which are measured as subjects of
 * their own on a slower cadence - so those are read alongside and laid over the
 * service's points. A game server is the case that makes both matter: a world is
 * gigabytes on a volume, and what a server costs a connection is the question
 * nobody could answer from CPU and memory.
 */

import { prisma } from "@polaris/db";
import {
    LOCAL_HOST_SUBJECT,
    MAX_POINTS,
    RAW_MAX_SPAN_MS,
    type MetricPoint,
    type MetricSubjectType
} from "./metrics-shared";

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
    if (subjectType === "host") {
        // "local" is the box Polaris itself runs on, which belongs to whoever is
        // asking - there is no Host row behind it to check ownership against.
        if (subjectId === LOCAL_HOST_SUBJECT) return true;
        const host = await prisma.host.findFirst({ where: { id: subjectId, ownerId }, select: { id: true } });
        return host != null;
    }
    if (subjectType === "volume") {
        // Ownership rides on the deploy target, which is where every other volume
        // query checks it too.
        const volume = await prisma.volume.findFirst({
            where: { id: subjectId, target: { ownerId } },
            select: { id: true }
        });
        return volume != null;
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
            diskTotalBytes: roundInt(avg(slice.map((point) => point.diskTotalBytes))),
            // Already rates by the time they get here, so averaging them is right.
            netRxBytesPerSecond: roundInt(avg(slice.map((point) => point.netRxBytesPerSecond))),
            netTxBytesPerSecond: roundInt(avg(slice.map((point) => point.netTxBytesPerSecond)))
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
 * A counter turned into a rate, against the gap it was measured over.
 *
 * Null rather than zero wherever it cannot be worked out: the first reading in a
 * window has nothing before it, and a gap with no time in it has no rate. A fall
 * means the container restarted and began counting again, so the reading itself
 * is what it has moved since - which is the honest floor, and never negative.
 */
function ratePerSecond(previous: bigint | null, current: bigint | null, elapsedMs: number): number | null {
    if (current == null || previous == null || elapsedMs <= 0) return null;
    const moved = current >= previous ? current - previous : current;
    return Math.round(Number(moved) / (elapsedMs / 1000));
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
    const points =
        spanMs <= RAW_MAX_SPAN_MS ? await rawSeries(input) : await rollupSeries(input);
    // What a service is actually storing lives on the volumes it mounts, and they
    // are measured as their own subjects. Only for a service: a volume asked about
    // directly already is that series, and a host reports its own disk.
    return input.subjectType === "app" ? withVolumeDisk(input.subjectId, points, input.from, input.to) : points;
}

/** Full-resolution samples, with the counters differenced into rates. */
async function rawSeries(input: {
    subjectType: MetricSubjectType;
    subjectId: string;
    from: Date;
    to: Date;
}): Promise<MetricPoint[]> {
    const rows = await prisma.metricSample.findMany({
        where: { subjectType: input.subjectType, subjectId: input.subjectId, ts: { gte: input.from, lte: input.to } },
        orderBy: { ts: "asc" }
    });
    const points = rows.map<MetricPoint>((row, index) => {
        const before = index > 0 ? rows[index - 1]! : null;
        const elapsed = before ? row.ts.getTime() - before.ts.getTime() : 0;
        return {
            t: row.ts.getTime(),
            cpuPercent: row.cpuPercent,
            cpuTempC: row.cpuTempC,
            memUsedBytes: num(row.memUsedBytes),
            memTotalBytes: num(row.memTotalBytes),
            diskUsedBytes: num(row.diskUsedBytes),
            diskTotalBytes: num(row.diskTotalBytes),
            netRxBytesPerSecond: ratePerSecond(before?.netRxBytes ?? null, row.netRxBytes, elapsed),
            netTxBytesPerSecond: ratePerSecond(before?.netTxBytes ?? null, row.netTxBytes, elapsed)
        };
    });
    return downsample(points, MAX_POINTS);
}

/** One point per hour, from the rollups. The network columns there are already
 *  totals for their hour, so the rate is that spread across it. */
async function rollupSeries(input: {
    subjectType: MetricSubjectType;
    subjectId: string;
    from: Date;
    to: Date;
}): Promise<MetricPoint[]> {
    const rows = await prisma.metricRollup.findMany({
        where: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            bucket: { gte: input.from, lte: input.to }
        },
        orderBy: { bucket: "asc" }
    });
    return rows.map<MetricPoint>((row) => ({
        t: row.bucket.getTime(),
        cpuPercent: row.cpuPercentAvg,
        cpuTempC: row.cpuTempCAvg,
        memUsedBytes: num(row.memUsedBytesAvg),
        memTotalBytes: num(row.memTotalBytesAvg),
        diskUsedBytes: num(row.diskUsedBytesAvg),
        diskTotalBytes: num(row.diskTotalBytesAvg),
        netRxBytesPerSecond: perHour(row.netRxBytesSum),
        netTxBytesPerSecond: perHour(row.netTxBytesSum)
    }));
}

/** An hour's worth of bytes, as bytes per second. */
function perHour(total: bigint | null): number | null {
    return total == null ? null : Math.round(Number(total) / 3600);
}

/**
 * A service's own points, with what its volumes hold laid over them.
 *
 * Volumes are sampled far less often than containers - measuring one walks its
 * whole tree - so their readings are carried forward: what a volume held at the
 * last measurement is what it holds until the next one, which is a step line
 * rather than a line with holes in it. A service with no volumes is returned
 * untouched, and charts nothing for disk rather than charting a zero.
 */
async function withVolumeDisk(
    applicationId: string,
    points: MetricPoint[],
    from: Date,
    to: Date
): Promise<MetricPoint[]> {
    if (points.length === 0) return points;
    const volumes = await prisma.volume.findMany({ where: { applicationId }, select: { id: true } });
    if (volumes.length === 0) return points;
    const ids = volumes.map((volume) => volume.id);

    // From the same table the service's own points came from. A window wider than
    // the raw retention would otherwise find nothing for most of itself: raw
    // samples are kept for days and rollups for months, so a 30-day chart drawn
    // off raw volume readings would show disk for the last week and nothing
    // before it, which reads as a volume that did not exist yet.
    //
    // Reaching a little before the window in both cases, so a chart that opens
    // between two volume measurements still starts with the last known figure
    // rather than with nothing.
    const since = new Date(from.getTime() - 24 * 3_600_000);
    const rows =
        to.getTime() - from.getTime() <= RAW_MAX_SPAN_MS
            ? await prisma.metricSample.findMany({
                  where: { subjectType: "volume", subjectId: { in: ids }, ts: { gte: since, lte: to } },
                  orderBy: { ts: "asc" },
                  select: { subjectId: true, ts: true, diskUsedBytes: true, diskTotalBytes: true }
              })
            : (
                  await prisma.metricRollup.findMany({
                      where: { subjectType: "volume", subjectId: { in: ids }, bucket: { gte: since, lte: to } },
                      orderBy: { bucket: "asc" },
                      select: { subjectId: true, bucket: true, diskUsedBytesAvg: true, diskTotalBytesAvg: true }
                  })
              ).map((row) => ({
                  subjectId: row.subjectId,
                  ts: row.bucket,
                  diskUsedBytes: row.diskUsedBytesAvg,
                  diskTotalBytes: row.diskTotalBytesAvg
              }));
    if (rows.length === 0) return points;

    // Every volume at once: what a service is storing is all of them together, and
    // they are measured in the same tick.
    const held = new Map<string, { used: number | null; total: number | null }>();
    const totals: { t: number; used: number | null; total: number | null }[] = [];
    for (const row of rows) {
        held.set(row.subjectId, { used: num(row.diskUsedBytes), total: num(row.diskTotalBytes) });
        totals.push({
            t: row.ts.getTime(),
            used: sumOf([...held.values()].map((entry) => entry.used)),
            total: sumOf([...held.values()].map((entry) => entry.total))
        });
    }

    let cursor = 0;
    return points.map((point) => {
        while (cursor + 1 < totals.length && totals[cursor + 1]!.t <= point.t) cursor += 1;
        const at = totals[cursor]!;
        // Nothing was measured before this point yet, so there is nothing to say.
        if (at.t > point.t) return point;
        return { ...point, diskUsedBytes: at.used, diskTotalBytes: at.total };
    });
}

/** The parts that were measured, added up. Null when none of them were, so a
 *  volume nothing could read does not chart as an empty one. */
function sumOf(values: (number | null)[]): number | null {
    const present = values.filter((value): value is number => value != null);
    return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}
