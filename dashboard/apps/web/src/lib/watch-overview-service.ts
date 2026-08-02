/**
 * What Watch shows on its overview: everything worth monitoring, grouped, each
 * with enough recent history to draw a shape rather than a number.
 *
 * The cards are built from the collected series, not from a live probe of every
 * subject - opening a monitoring dashboard should not be the most expensive
 * request in the app, and a sparkline needs history anyway. Live figures belong
 * on the detail screen, where there is one subject to pay for.
 */

import { prisma } from "@polaris/db";
import { listHosts } from "./host-service";
import type { DockerDriver } from "@polaris/docker";
import { hostDockerDriver, localDockerDriver } from "./docker-service";
import { LOCAL_HOST_SUBJECT, type MetricSubjectType } from "./metrics-shared";

/** How much history a card's sparkline shows. Long enough to have a shape, short
 *  enough that a card is not a chart. */
const SPARK_WINDOW_MS = 60 * 60 * 1000;
const SPARK_POINTS = 30;

export type WatchSubjectKind = "server" | "service" | "container";

export interface SparkPoint {
    t: number;
    v: number | null;
}

export interface WatchCard {
    id: string;
    kind: WatchSubjectKind;
    name: string;
    /** One line under the name: what it is, or where it lives. */
    detail: string;
    /** up | down | idle - drives the dot, not a percentage. */
    state: "up" | "down" | "idle";
    stateLabel: string;
    /** Latest CPU reading as a percentage, when there is one. */
    cpuPercent: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    /** CPU over the last hour, for the card's sparkline. Empty when nothing has
     *  been sampled - the card then says so rather than drawing a flat line. */
    spark: SparkPoint[];
    /** Alarms currently firing on this subject. */
    alarms: number;
    /** Where clicking the card goes. */
    href: string;
}

export interface WatchOverview {
    servers: WatchCard[];
    services: WatchCard[];
    containers: WatchCard[];
    /** Alarms in the "alarm" state across everything. */
    firing: number;
}

/** Recent samples for a set of subjects, bucketed into a small sparkline. */
async function sparklines(
    subjectType: MetricSubjectType,
    ids: string[],
    now: number
): Promise<Map<string, { spark: SparkPoint[]; last: { cpu: number | null; used: bigint | null; total: bigint | null } }>> {
    const map = new Map<
        string,
        { spark: SparkPoint[]; last: { cpu: number | null; used: bigint | null; total: bigint | null } }
    >();
    if (ids.length === 0) return map;

    const from = new Date(now - SPARK_WINDOW_MS);
    const rows = await prisma.metricSample.findMany({
        where: { subjectType, subjectId: { in: ids }, ts: { gte: from } },
        orderBy: { ts: "asc" },
        select: { subjectId: true, ts: true, cpuPercent: true, memUsedBytes: true, memTotalBytes: true }
    });

    const bucketMs = SPARK_WINDOW_MS / SPARK_POINTS;
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
        const list = grouped.get(row.subjectId);
        if (list) list.push(row);
        else grouped.set(row.subjectId, [row]);
    }

    for (const [id, list] of grouped) {
        // Fixed buckets rather than raw points, so every card's line covers the
        // same window and two cards can be compared by eye.
        const buckets: number[][] = Array.from({ length: SPARK_POINTS }, () => []);
        for (const row of list) {
            const index = Math.min(
                SPARK_POINTS - 1,
                Math.max(0, Math.floor((row.ts.getTime() - (now - SPARK_WINDOW_MS)) / bucketMs))
            );
            if (row.cpuPercent != null) buckets[index]!.push(row.cpuPercent);
        }
        const spark = buckets.map((values, index) => ({
            t: now - SPARK_WINDOW_MS + index * bucketMs,
            v: values.length === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
        }));
        const newest = list[list.length - 1];
        map.set(id, {
            spark,
            last: {
                cpu: newest?.cpuPercent ?? null,
                used: newest?.memUsedBytes ?? null,
                total: newest?.memTotalBytes ?? null
            }
        });
    }
    return map;
}

/** How many alarms are firing per target, so a card can carry the count. */
async function firingByTarget(ownerId: string): Promise<Map<string, number>> {
    const rows = await prisma.alarm.findMany({
        where: { ownerId, state: "alarm", enabled: true },
        select: { targetId: true }
    });
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.targetId, (map.get(row.targetId) ?? 0) + 1);
    return map;
}

/** A sample newer than this is "now"; anything older means the subject stopped
 *  reporting, which is worth showing as such rather than as a stale reading. */
const FRESH_MS = 10 * 60 * 1000;

export async function getWatchOverview(ownerId: string): Promise<WatchOverview> {
    const now = Date.now();
    const [hosts, apps, alarms] = await Promise.all([
        listHosts(ownerId),
        prisma.application.findMany({
            where: { environment: { project: { ownerId } } },
            select: {
                id: true,
                name: true,
                currentDeploymentId: true,
                environment: { select: { name: true, projectId: true, project: { select: { name: true } } } }
            },
            orderBy: { createdAt: "asc" }
        }),
        firingByTarget(ownerId)
    ]);

    const hostIds = [LOCAL_HOST_SUBJECT, ...hosts.map((host) => host.id)];
    const [hostSeries, appSeries] = await Promise.all([
        sparklines("host", hostIds, now),
        sparklines("app", apps.map((app) => app.id), now)
    ]);

    const servers: WatchCard[] = [
        {
            id: LOCAL_HOST_SUBJECT,
            kind: "server",
            name: "Local",
            detail: "The machine Polaris runs on",
            ...readingsFor(hostSeries.get(LOCAL_HOST_SUBJECT), now),
            alarms: 0,
            href: `/watch/server/${LOCAL_HOST_SUBJECT}`
        },
        ...hosts.map((host) => ({
            id: host.id,
            kind: "server" as const,
            name: host.name,
            detail: `${host.username}@${host.address}`,
            ...readingsFor(hostSeries.get(host.id), now),
            alarms: alarms.get(host.id) ?? 0,
            href: `/watch/server/${host.id}`
        }))
    ];

    const services: WatchCard[] = apps.map((app) => {
        const readings = readingsFor(appSeries.get(app.id), now);
        return {
            id: app.id,
            kind: "service" as const,
            name: app.name,
            detail: `${app.environment.project.name} / ${app.environment.name}`,
            // A service that is not deployed is idle, not down: nothing is wrong,
            // there is simply nothing running to measure.
            state: app.currentDeploymentId ? readings.state : ("idle" as const),
            stateLabel: app.currentDeploymentId ? readings.stateLabel : "Not deployed",
            cpuPercent: readings.cpuPercent,
            memUsedBytes: readings.memUsedBytes,
            memTotalBytes: readings.memTotalBytes,
            spark: readings.spark,
            alarms: alarms.get(app.id) ?? 0,
            href: `/watch/service/${app.id}`
        };
    });

    return {
        servers,
        services,
        containers: await getWatchContainers(ownerId),
        firing: [...alarms.values()].reduce((total, count) => total + count, 0)
    };
}

/**
 * Every container running on any reachable server, with its live reading.
 *
 * These are read from the daemons rather than from the sample table, because a
 * container is not a stable subject - a redeploy replaces it, and a series keyed
 * by container id would be a graveyard of stubs. What is worth charting over time
 * is the service, which has its own card; a container gets the truth about right
 * now instead, and no sparkline pretending otherwise.
 */
export async function getWatchContainers(ownerId: string): Promise<WatchCard[]> {
    const hosts = await listHosts(ownerId);
    const sources: { id: string; label: string; open: () => Promise<DockerDriver> }[] = [
        { id: LOCAL_HOST_SUBJECT, label: "Local", open: async () => localDockerDriver() },
        ...hosts.map((host) => ({
            id: host.id,
            label: host.name,
            open: () => hostDockerDriver(host.id, ownerId)
        }))
    ];

    const cards: WatchCard[] = [];
    for (const source of sources) {
        let driver: DockerDriver | null = null;
        try {
            driver = await source.open();
            const containers = await driver.listContainers(true);
            for (const container of containers) {
                let cpu: number | null = null;
                let used: number | null = null;
                let total: number | null = null;
                if (container.state === "running") {
                    try {
                        const stats = await driver.stats(container.id);
                        cpu = Math.round(stats.cpuPercent * 10) / 10;
                        used = stats.memUsage;
                        total = stats.memLimit;
                    } catch {
                        // Stopped between the list and the read.
                    }
                }
                cards.push({
                    id: `${source.id}:${container.id}`,
                    kind: "container",
                    name: container.name,
                    detail: `${source.label} - ${container.image}`,
                    state: container.state === "running" ? "up" : "idle",
                    stateLabel: container.status || container.state,
                    cpuPercent: cpu,
                    memUsedBytes: used,
                    memTotalBytes: total,
                    spark: [],
                    alarms: 0,
                    href: `/apps/containers?connection=${encodeURIComponent(source.id === LOCAL_HOST_SUBJECT ? "local" : `host:${source.id}`)}`
                });
            }
        } catch {
            // Daemon absent or host unreachable - that server contributes nothing.
        } finally {
            if (driver) await driver.dispose().catch(() => undefined);
        }
    }
    return cards;
}

function readingsFor(
    entry: { spark: SparkPoint[]; last: { cpu: number | null; used: bigint | null; total: bigint | null } } | undefined,
    now: number
): Pick<WatchCard, "state" | "stateLabel" | "cpuPercent" | "memUsedBytes" | "memTotalBytes" | "spark"> {
    if (!entry) {
        return {
            state: "idle",
            stateLabel: "No data yet",
            cpuPercent: null,
            memUsedBytes: null,
            memTotalBytes: null,
            spark: []
        };
    }
    const newest = [...entry.spark].reverse().find((point) => point.v != null);
    const fresh = newest != null && now - newest.t < FRESH_MS;
    return {
        state: fresh ? "up" : "down",
        stateLabel: fresh ? "Reporting" : "Stopped reporting",
        cpuPercent: entry.last.cpu,
        memUsedBytes: entry.last.used == null ? null : Number(entry.last.used),
        memTotalBytes: entry.last.total == null ? null : Number(entry.last.total),
        spark: entry.spark
    };
}
