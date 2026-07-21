/**
 * Background metrics collector. Periodically samples consumption for every
 * deployed application container and every Drive storage connection (NAS/server),
 * writes raw samples, folds complete hours into rollups, and prunes past the
 * retention windows - so the dashboard can chart the past, not just the present.
 *
 * It runs in-process (started from instrumentation) because metrics history needs
 * continuous collection even when nobody is watching a tab; the lazy-on-access
 * pattern used elsewhere cannot produce a time series. Every subject is sampled
 * independently and failures are swallowed per subject, so one unreachable device
 * never stops the others or the loop.
 */

import { prisma, type Prisma } from "@polaris/db";
import { serviceName } from "@polaris/deploy";
import type { DockerDriver } from "@polaris/docker";
import { hostDockerDriver, localDockerDriver } from "./docker-service";
import { getDriverForConnection, getUnasMetrics } from "./storage-service";
import {
    COLLECT_TICK_MS,
    MAINTENANCE_EVERY_TICKS,
    RAW_RETENTION_MS,
    ROLLUP_RETENTION_MS,
    STORAGE_EVERY_TICKS
} from "./metrics-shared";

type SampleRow = Prisma.MetricSampleCreateManyInput;

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Coerce a possibly-fractional byte count to a BigInt column value, or null. */
function bigBytes(value: number | null | undefined): bigint | null {
    if (value == null || !Number.isFinite(value)) return null;
    return BigInt(Math.max(0, Math.round(value)));
}

/** Sample every deployed application's container (local via the host daemon,
 *  remote via Docker over SSH). Stopped/unreachable containers are skipped. */
async function collectApps(ts: Date): Promise<SampleRow[]> {
    const apps = await prisma.application.findMany({
        where: { currentDeploymentId: { not: null } },
        include: { environment: { include: { project: true } }, target: true }
    });
    const rows: SampleRow[] = [];
    for (const app of apps) {
        const container = serviceName(app.environment.project.slug, app.slug, app.id);
        const ownerId = app.environment.project.ownerId;
        let driver: DockerDriver | null = null;
        try {
            driver =
                app.target.kind === "local" || !app.target.hostId
                    ? localDockerDriver()
                    : await hostDockerDriver(app.target.hostId, ownerId);
            const stats = await driver.stats(container);
            rows.push({
                subjectType: "app",
                subjectId: app.id,
                ts,
                cpuPercent: round2(stats.cpuPercent),
                memUsedBytes: bigBytes(stats.memUsage),
                memTotalBytes: bigBytes(stats.memLimit)
            });
        } catch {
            // Container not running or host unreachable this tick - skip it.
        } finally {
            if (driver) await driver.dispose().catch(() => undefined);
        }
    }
    return rows;
}

/** Sample every storage connection: rich CPU/memory/disk for a UniFi UNAS, disk
 *  usage for any other backend that reports it. */
async function collectStorage(ts: Date): Promise<SampleRow[]> {
    const conns = await prisma.storageConnection.findMany({
        select: { id: true, ownerId: true, kind: true }
    });
    const rows: SampleRow[] = [];
    for (const conn of conns) {
        try {
            if (conn.kind === "unifi-unas") {
                const metrics = await getUnasMetrics(conn.id, conn.ownerId);
                rows.push({
                    subjectType: "storage",
                    subjectId: conn.id,
                    ts,
                    cpuPercent: metrics.system.cpuLoad != null ? round2(metrics.system.cpuLoad * 100) : null,
                    cpuTempC: metrics.system.cpuTemp ?? null,
                    memUsedBytes: bigBytes(metrics.system.memoryUsedBytes),
                    memTotalBytes: bigBytes(metrics.system.memoryTotalBytes),
                    diskUsedBytes: bigBytes(metrics.usedBytes),
                    diskTotalBytes: bigBytes(metrics.totalBytes)
                });
                continue;
            }
            const driver = await getDriverForConnection(conn.id);
            try {
                const usage = await driver.usage();
                // Skip backends that cannot report usage - no point storing an
                // all-null row.
                if (usage.total == null && usage.used == null) continue;
                rows.push({
                    subjectType: "storage",
                    subjectId: conn.id,
                    ts,
                    diskUsedBytes: usage.used ?? null,
                    diskTotalBytes: usage.total ?? null
                });
            } finally {
                await driver.dispose().catch(() => undefined);
            }
        } catch {
            // Device unreachable or bad credentials - skip it this tick.
        }
    }
    return rows;
}

/**
 * Collect one round of samples. `storage` gates the heavier NAS/server pass so it
 * runs on a slower cadence than container stats. Returns how many rows were
 * written. Exported so an external scheduler could drive it too.
 */
export async function collectMetricsOnce(opts: { storage: boolean }): Promise<number> {
    const ts = new Date();
    const rows = await collectApps(ts);
    if (opts.storage) rows.push(...(await collectStorage(ts)));
    if (rows.length === 0) return 0;
    // Every row in a tick shares one timestamp and each subject is unique, so the
    // composite PK never collides - no skipDuplicates needed (unsupported on the
    // SQLite-portable target anyway).
    await prisma.metricSample.createMany({ data: rows });
    return rows.length;
}

// --- rollup + retention -----------------------------------------------------

function avgNum(values: (number | null)[]): number | null {
    const present = values.filter((value): value is number => value != null);
    if (present.length === 0) return null;
    return round2(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function maxNum(values: (number | null)[]): number | null {
    const present = values.filter((value): value is number => value != null);
    if (present.length === 0) return null;
    return round2(Math.max(...present));
}

function avgBig(values: (bigint | null)[]): bigint | null {
    const present = values.filter((value): value is bigint => value != null);
    if (present.length === 0) return null;
    const total = present.reduce((sum, value) => sum + value, 0n);
    return total / BigInt(present.length);
}

function aggregate(list: { cpuPercent: number | null; cpuTempC: number | null; memUsedBytes: bigint | null; memTotalBytes: bigint | null; diskUsedBytes: bigint | null; diskTotalBytes: bigint | null }[]) {
    return {
        cpuPercentAvg: avgNum(list.map((row) => row.cpuPercent)),
        cpuPercentMax: maxNum(list.map((row) => row.cpuPercent)),
        cpuTempCAvg: avgNum(list.map((row) => row.cpuTempC)),
        memUsedBytesAvg: avgBig(list.map((row) => row.memUsedBytes)),
        memTotalBytesAvg: avgBig(list.map((row) => row.memTotalBytes)),
        diskUsedBytesAvg: avgBig(list.map((row) => row.diskUsedBytes)),
        diskTotalBytesAvg: avgBig(list.map((row) => row.diskTotalBytes)),
        samples: list.length
    };
}

/**
 * Fold the last few complete hours of raw samples into hourly rollups, per
 * subject. Upsert-based so re-running (or catching up after a short downtime) is
 * idempotent. BigInt columns are averaged in JS because Prisma's groupBy cannot
 * aggregate BigInt and raw SQL would break the SQLite-portable schema.
 */
async function rollupRecentHours(now: Date, hours = 3): Promise<void> {
    const currentHourStart = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    for (let index = 1; index <= hours; index += 1) {
        const start = currentHourStart - index * 3_600_000;
        const bucket = new Date(start);
        const samples = await prisma.metricSample.findMany({
            where: { ts: { gte: bucket, lt: new Date(start + 3_600_000) } }
        });
        if (samples.length === 0) continue;
        const groups = new Map<string, typeof samples>();
        for (const sample of samples) {
            const key = `${sample.subjectType} ${sample.subjectId}`;
            const group = groups.get(key);
            if (group) group.push(sample);
            else groups.set(key, [sample]);
        }
        for (const [key, list] of groups) {
            const separator = key.indexOf(" ");
            const subjectType = key.slice(0, separator);
            const subjectId = key.slice(separator + 1);
            const agg = aggregate(list);
            await prisma.metricRollup.upsert({
                where: { subjectType_subjectId_bucket: { subjectType, subjectId, bucket } },
                create: { subjectType, subjectId, bucket, ...agg },
                update: agg
            });
        }
    }
}

/** Drop raw samples and rollups older than their retention windows. */
async function purgeOldMetrics(now: Date): Promise<void> {
    await prisma.metricSample.deleteMany({ where: { ts: { lt: new Date(now.getTime() - RAW_RETENTION_MS) } } });
    await prisma.metricRollup.deleteMany({ where: { bucket: { lt: new Date(now.getTime() - ROLLUP_RETENTION_MS) } } });
}

// --- loop -------------------------------------------------------------------

let started = false;

/**
 * Start the collector loop. Idempotent (runs once per process) and self-guarding:
 * every tick is wrapped so a failure only logs and the interval keeps going. The
 * timer is unref'd so it never holds the process open on its own.
 */
export function startMetricsCollector(): void {
    if (started) return;
    started = true;
    let tick = 0;
    const run = async (): Promise<void> => {
        tick += 1;
        try {
            await collectMetricsOnce({ storage: tick % STORAGE_EVERY_TICKS === 1 });
        } catch (error) {
            console.error("polaris: metrics collection failed:", error);
        }
        if (tick % MAINTENANCE_EVERY_TICKS === 0) {
            const now = new Date();
            try {
                await rollupRecentHours(now);
                await purgeOldMetrics(now);
            } catch (error) {
                console.error("polaris: metrics maintenance failed:", error);
            }
        }
    };
    void run();
    const timer = setInterval(() => void run(), COLLECT_TICK_MS);
    timer.unref?.();
}
