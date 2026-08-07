/**
 * What Watch shows on its overview: everything worth monitoring, grouped, each
 * with enough recent history to draw a shape rather than a number.
 *
 * The cards are built from the collected series, not from a live probe of every
 * subject - opening a monitoring dashboard should not be the most expensive
 * request in the app, and a sparkline needs history anyway. Live figures belong
 * on the detail screen, where there is one subject to pay for.
 *
 * Servers and services are therefore a database read and nothing else. Containers
 * are the exception (see `getWatchContainers`) and are deliberately kept out of
 * that read: they cost a round trip to every reachable daemon, so they are fetched
 * separately by the client rather than held in front of a navigation.
 */

import { prisma } from "@polaris/db";
import type { DockerDriver } from "@polaris/docker";
import { isLocalMachine, localDockerId } from "./local-machine";
import { hostRouteId, LOCAL_HOST_SUBJECT, type MetricSubjectType } from "./metrics-shared";
import { cachedSamples, newestSampleAt, refreshSamples, STATS_TTL_MS } from "./container-stats-cache";
import {
    hostDockerDriver,
    HOST_DOCKER_PREFIX,
    localDockerDriver,
    LOCAL_DOCKER_CONNECTION_ID
} from "./docker-service";

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

/** What Watch needs to know about a registered server, including whether it is
 *  the machine Polaris runs on. Its own projection rather than the general host
 *  reader's, because that identity is nobody else's business. */
async function watchHosts(ownerId: string) {
    const [hosts, localId] = await Promise.all([
        prisma.host.findMany({
            where: { ownerId },
            select: { id: true, name: true, address: true, username: true, dockerId: true },
            orderBy: { createdAt: "asc" }
        }),
        localDockerId()
    ]);
    return {
        /** The registered server that turned out to BE the local machine, if any. */
        local: hosts.find((host) => isLocalMachine(host, localId)) ?? null,
        remote: hosts.filter((host) => !isLocalMachine(host, localId))
    };
}

/**
 * Every server, one card each.
 *
 * The machine Polaris runs on always appears, whether or not it was ever enrolled
 * as a server. When it WAS enrolled it does not appear twice: the two are one box
 * and are shown as one card, under the name it was given.
 */
export async function getWatchServers(ownerId: string): Promise<WatchCard[]> {
    return buildServers(ownerId, await firingByTarget(ownerId));
}

async function buildServers(ownerId: string, alarms: Map<string, number>): Promise<WatchCard[]> {
    const now = Date.now();
    const { local, remote } = await watchHosts(ownerId);

    const ids = [LOCAL_HOST_SUBJECT, ...remote.map((host) => host.id)];
    const series = await sparklines("host", ids, now);

    return [
        {
            id: LOCAL_HOST_SUBJECT,
            kind: "server",
            name: local?.name ?? "Local",
            detail: local
                ? `${local.username}@${local.address} - the machine Polaris runs on`
                : "The machine Polaris runs on",
            ...readingsFor(series.get(LOCAL_HOST_SUBJECT), now),
            alarms: local ? (alarms.get(local.id) ?? 0) : 0,
            // Addressed as the machine, not as the reserved subject its samples
            // are filed under.
            href: `/watch/server/${hostRouteId(LOCAL_HOST_SUBJECT)}`
        },
        ...remote.map((host) => ({
            id: host.id,
            kind: "server" as const,
            name: host.name,
            detail: `${host.username}@${host.address}`,
            ...readingsFor(series.get(host.id), now),
            alarms: alarms.get(host.id) ?? 0,
            href: `/watch/server/${host.id}`
        }))
    ];
}

/** Every deployed service, one card each. */
export async function getWatchServices(ownerId: string): Promise<WatchCard[]> {
    return buildServices(ownerId, await firingByTarget(ownerId));
}

async function buildServices(ownerId: string, alarms: Map<string, number>): Promise<WatchCard[]> {
    const now = Date.now();
    const apps = await prisma.application.findMany({
        where: { environment: { project: { ownerId } } },
        select: {
            id: true,
            name: true,
            currentDeploymentId: true,
            environment: { select: { name: true, projectId: true, project: { select: { name: true } } } }
        },
        orderBy: { createdAt: "asc" }
    });

    const series = await sparklines("app", apps.map((app) => app.id), now);
    return apps.map((app) => {
        const readings = readingsFor(series.get(app.id), now);
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
}

export async function getWatchOverview(ownerId: string): Promise<WatchOverview> {
    const alarms = await firingByTarget(ownerId);
    const [servers, services] = await Promise.all([buildServers(ownerId, alarms), buildServices(ownerId, alarms)]);
    return {
        servers,
        services,
        firing: [...alarms.values()].reduce((total, count) => total + count, 0)
    };
}

/**
 * Every container running on any reachable server, with its last reading.
 *
 * A container has no stored series, because it is not a stable subject - a
 * redeploy replaces it, and a table keyed by container id would be a graveyard of
 * stubs. What is worth charting over time is the service, which has its own card.
 *
 * So the figures come from the sampler the Containers app and the metrics
 * collector already share: the collector reads every container on every machine
 * once a minute to add its server up, and leaves each reading behind it. Watch
 * reads those rather than asking the daemons the same question a third time - the
 * request costs a listing per machine instead of a listing plus a second per
 * container, and a fresh pass is started behind the answer when what it served has
 * aged out.
 *
 * Still never called while rendering a page: a listing per machine can still cross
 * a network, so it is served over `/api/watch/containers` and arrives after the
 * screen does.
 */
export async function getWatchContainers(ownerId: string): Promise<WatchCard[]> {
    const { local, remote } = await watchHosts(ownerId);
    const sources: ContainerSource[] = [
        // A server that is the local machine is reached through the daemon, not
        // over SSH to itself, so its containers are listed once.
        {
            id: LOCAL_HOST_SUBJECT,
            connectionId: LOCAL_DOCKER_CONNECTION_ID,
            label: local?.name ?? "Local",
            open: async () => localDockerDriver()
        },
        ...remote.map((host) => ({
            id: host.id,
            connectionId: `${HOST_DOCKER_PREFIX}${host.id}`,
            label: host.name,
            open: () => hostDockerDriver(host.id, ownerId)
        }))
    ];

    // Machines in parallel: one unreachable server should cost its own timeout,
    // not everybody else's turn.
    const perSource = await Promise.all(sources.map((source) => containersOn(source, ownerId)));
    return perSource.flat();
}

/** One machine to list, and the id its samples are held under. The two differ:
 *  Watch keys a server by its metric subject, the sampler by the Containers
 *  connection that reaches it. */
interface ContainerSource {
    id: string;
    connectionId: string;
    label: string;
    open: () => Promise<DockerDriver>;
}

async function containersOn(source: ContainerSource, ownerId: string): Promise<WatchCard[]> {
    let driver: DockerDriver | null = null;
    try {
        driver = await source.open();
        const containers = await driver.listContainers(true);
        const running = containers.filter((container) => container.state === "running");
        const samples = cachedSamples(source.connectionId);
        const cards = containers.map((container) => {
            // A stopped container has nothing to sample. Its last reading is not
            // shown either: the card already says it is not running, and a number
            // beside that reads as though it still were.
            const sample = container.state === "running" ? (samples.get(container.id) ?? null) : null;
            return {
                id: `${source.id}:${container.id}`,
                kind: "container" as const,
                name: container.name,
                detail: `${source.label} - ${container.image}`,
                state: container.state === "running" ? ("up" as const) : ("idle" as const),
                stateLabel: container.status || container.state,
                cpuPercent: sample == null ? null : Math.round(sample.stats.cpuPercent * 10) / 10,
                memUsedBytes: sample?.stats.memUsage ?? null,
                memTotalBytes: sample?.stats.memLimit ?? null,
                spark: [],
                alarms: 0,
                href: `/apps/containers?c=${encodeURIComponent(source.connectionId)}`
            };
        });

        // Behind the answer, never in front of it, and single-flight per machine -
        // so two people on Watch do not sample the same engine twice.
        const newest = newestSampleAt(
            samples,
            running.map((container) => container.id)
        );
        if (newest === null || Date.now() - newest > STATS_TTL_MS) {
            refreshSamples(
                source.connectionId,
                ownerId,
                running.map((container) => ({ id: container.id, name: container.name })),
                { prune: true }
            );
        }
        return cards;
    } catch {
        // Daemon absent or host unreachable - that server contributes nothing.
        return [];
    } finally {
        if (driver) await driver.dispose().catch(() => undefined);
    }
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
