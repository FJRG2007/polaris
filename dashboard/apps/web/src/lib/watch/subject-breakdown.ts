/**
 * What is behind one number on a Watch card.
 *
 * The four charts on a watched subject say how much CPU, memory, storage and
 * upload it is using. None of them says what is using it, which is the question
 * every one of them provokes - and the storage one provokes it hardest, because
 * a machine reporting 88 GB with almost nothing installed on it reads as a fault
 * rather than as a disk with a build cache on it.
 *
 * Nothing new is measured here. Every figure already exists somewhere in Polaris
 * and was only ever shown on another screen:
 *
 *   - CPU and memory are the containers the engine is running, which is exactly
 *     what the host series is the sum of. The collector samples them every minute
 *     on its way past and leaves them in the stats cache, so opening this costs a
 *     listing rather than a second per container.
 *   - Storage is what the Servers screen already lists: the volumes largest
 *     first with what each belongs to, plus the image store and the build cache.
 *     Only for the machine Polaris runs on, because it is the only disk anything
 *     here can measure - a server reached over SSH reports no disk at all, and
 *     inventing one would be worse than the empty chart it already draws.
 *   - Upload is the stored counters, differenced over the window on screen. A
 *     counter read once inside a window is a position rather than a distance, so
 *     a service sampled once contributes no rate and is left out instead of being
 *     charted at nothing.
 *
 * What it deliberately does not offer is a breakdown of a single container. A
 * watched service IS one container: its CPU, its memory and its upload have no
 * parts, and the only thing inside it that does is the volumes it mounts. So a
 * service offers storage and nothing else.
 *
 * Server-only.
 */

import { z } from "zod";
import { shortHash } from "@polaris/deploy";
import { getCapabilities } from "@polaris/config";
import { prisma, type Prisma } from "@polaris/db";
import { localDisk } from "@/lib/deploy/local-disk";
import { hostSpace } from "@/lib/deploy/host-space";
import { cachedSamples } from "@/lib/container-stats-cache";
import { LOCAL_SERVER_ID, serverIdSchema, type Permission } from "@polaris/core";
import { describePart, isPolarisPart } from "@/lib/polaris-parts";
import { baseProject, hostVolumes } from "@/lib/deploy/host-volumes";
import { counterAdvance, hostSubject, RAW_MAX_SPAN_MS } from "@/lib/metrics-shared";
import type { ContainerStats, ContainerSummary, DockerDriver } from "@polaris/docker";
import {
    HOST_DOCKER_PREFIX,
    hostDockerDriver,
    LOCAL_DOCKER_CONNECTION_ID,
    localDockerDriver
} from "@/lib/docker-service";
import {
    BREAKDOWN_METRICS,
    nothingToShow,
    ranked,
    ratePerSecond,
    remainder,
    wholeOf,
    type Breakdown,
    type BreakdownMetric,
    type BreakdownPart
} from "./breakdown-shape";

/**
 * What a screen may ask for. The window is the one the chart is drawn over, so a
 * breakdown answers for the range being looked at rather than for this instant -
 * which is the difference between "what used my upload last week" and "what is
 * using it right now".
 */
const chartWindow = {
    metric: z.enum(BREAKDOWN_METRICS),
    from: z.number().int().positive(),
    to: z.number().int().positive()
};

export const breakdownRequestSchema = z
    .discriminatedUnion("kind", [
        // A server is `local` or a registered one; a service is an application.
        // Typed apart rather than as one loose string, because both ids go into
        // columns that only hold one shape and a query is not the place to find
        // that out.
        z.object({ kind: z.literal("server"), id: serverIdSchema, ...chartWindow }),
        z.object({ kind: z.literal("service"), id: z.string().uuid(), ...chartWindow })
    ])
    .refine((value) => value.to > value.from, { message: "That window has no time in it" });

export type BreakdownRequest = z.infer<typeof breakdownRequestSchema>;

/** What the caller has established about whoever is asking. */
export interface BreakdownViewer {
    readonly id: string;
    /** Whether they may read how the machine itself is being used, which is what
     *  gates every machine-wide figure here (the Servers app gates the same
     *  readings on the same permission). */
    readonly canReadMachine: boolean;
}

/** The permission `canReadMachine` stands for, so one name decides it. */
export const MACHINE_PERMISSION: Permission = "system.manage";

/** Said whenever a machine-wide figure is asked for by somebody who is allowed on
 *  the page but not to read the machine. Deliberately not an error: the chart
 *  above it is theirs to see. */
const NOT_YOURS = "You can see this server's figures, but not what is on the machine itself.";

/**
 * Which of a subject's four metrics have something behind them.
 *
 * Worked out on the page rather than when a card is pressed, because the answer
 * decides whether the card looks openable at all. Four charts that all offer to
 * explain themselves and two that then say "nothing to show" is how a reader
 * learns to stop pressing them - so a card only carries the affordance where
 * pressing it produces a list.
 *
 * What it cannot know in advance is whether the machine will answer or whether
 * the window happens to be empty. Those stay the panel's to say.
 */
export async function offeredBreakdowns(
    viewer: BreakdownViewer,
    subject: { kind: "server" | "service"; id: string }
): Promise<BreakdownMetric[]> {
    if (subject.kind === "service") {
        const volumes = await prisma.volume
            .count({
                where: {
                    applicationId: subject.id,
                    application: { environment: { project: { ownerId: viewer.id } } }
                }
            })
            .catch(() => 0);
        // A service is one container: its CPU, memory and upload have no parts.
        // What it mounts does.
        return volumes > 0 ? ["disk"] : [];
    }

    const offered: BreakdownMetric[] = [];
    const local = subject.id === LOCAL_SERVER_ID;
    // This machine is read through the host daemon, which an install without one
    // does not have - and without it there is nothing to list, only a disk with
    // an unexplained figure on it. A server elsewhere is read over its own
    // connection and does not depend on that.
    if (viewer.canReadMachine && (!local || getCapabilities().docker)) {
        offered.push("cpu", "mem");
        // The only disk anything here can measure is this machine's own.
        if (local) offered.push("disk");
    }
    const deployed = await prisma.application
        .count({
            where: { environment: { project: { ownerId: viewer.id } }, target: targetOn(subject.id) }
        })
        .catch(() => 0);
    // Upload is broken down per service. With no service on this machine there is
    // nothing to attribute it to, whatever the machine itself sent.
    if (deployed > 0) offered.push("net");
    return offered;
}

/**
 * Take one metric apart for one subject.
 *
 * Never throws for an ordinary failure - a machine that is off, a daemon that
 * will not answer, a window with nothing recorded in it are all answers, and the
 * dialog says them in words rather than showing an error over a blank list.
 */
export async function subjectBreakdown(
    viewer: BreakdownViewer,
    request: BreakdownRequest
): Promise<Breakdown> {
    if (request.kind === "service") {
        if (request.metric !== "disk") {
            return nothingToShow(
                "A service is one container, so this figure has no parts to show."
            );
        }
        return serviceStorage(viewer.id, request.id, new Date(request.to));
    }

    if (request.metric === "net") return machineTraffic(viewer.id, request);
    if (!viewer.canReadMachine) return nothingToShow(NOT_YOURS);
    if (request.metric === "disk") {
        if (request.id !== LOCAL_SERVER_ID) {
            return nothingToShow(
                "Polaris measures the disk of the machine it runs on. It cannot see this one's."
            );
        }
        return machineStorage();
    }
    return machineLoad(viewer.id, request.id, request.metric);
}

// --- CPU and memory ---------------------------------------------------------

/** How old a cached sample may be before it is read again rather than shown. Two
 *  collection ticks: the collector leaves a sample of every container on its way
 *  past, and anything older than that means it has stopped arriving. */
const SAMPLE_MAX_AGE_MS = 120_000;

/**
 * What is running on the machine, ranked by the metric that was clicked.
 *
 * Ranked by the clicked metric rather than always by CPU: somebody who opened
 * Memory is asking which container is holding the memory, and a list in CPU order
 * with a memory column beside it makes them do the sorting by eye.
 */
async function machineLoad(
    viewerId: string,
    serverId: string,
    metric: "cpu" | "mem"
): Promise<Breakdown> {
    const local = serverId === LOCAL_SERVER_ID;
    const connectionId = local ? LOCAL_DOCKER_CONNECTION_ID : `${HOST_DOCKER_PREFIX}${serverId}`;
    let driver: DockerDriver | null = null;
    try {
        driver = local ? localDockerDriver() : await hostDockerDriver(serverId, viewerId);
        const running = (await driver.listContainers(false)).filter(
            (container) => container.state === "running"
        );
        if (running.length === 0) {
            return nothingToShow("Nothing is running on this server right now.");
        }

        const { samples, at } = await sampleContainers(driver, connectionId, running);
        const owners = await deployedOn(serverId);
        const parts = running.flatMap<BreakdownPart>((container) => {
            const stats = samples.get(container.id);
            if (!stats) return [];
            return [
                {
                    ...describeContainer(container, connectionId, owners),
                    kind: "container",
                    value: metric === "cpu" ? stats.cpuPercent : stats.memUsage
                }
            ];
        });
        if (parts.length === 0) {
            return nothingToShow("This server would not say what its containers are using.");
        }

        // CPU is already a share of the whole machine, so the machine is 100 of
        // it. Memory is against what the machine actually has, which is the
        // figure the chart puts a percentage beside.
        const machine =
            metric === "cpu" ? 100 : ((await driver.info().catch(() => null))?.memTotal ?? null);
        const total = wholeOf(machine, parts);
        const rest = remainder(total, parts, {
            key: "rest",
            label:
                metric === "cpu"
                    ? "Idle, and anything outside a container"
                    : "Free, and anything outside a container",
            detail: "The machine itself, and whatever is installed on it directly."
        });
        return {
            rows: ranked(rest ? [...parts, rest] : parts, total),
            total,
            note: "Measured from the containers this server is running, which is what the chart adds up.",
            unavailable: null,
            at
        };
    } catch {
        // The reason names a transport, a host or a socket. What a reader can do
        // about it is the same either way.
        return nothingToShow("Polaris could not read this server just now.");
    } finally {
        if (driver) await driver.dispose().catch(() => undefined);
    }
}

/**
 * Every running container's usage, taking as little from the engine as possible.
 *
 * The collector reads all of them once a minute and leaves each one in the stats
 * cache, so what is on screen a moment later is almost always already held. Only
 * the containers with nothing recent are asked for, because the engine answers a
 * one-shot stats request by holding it open for about a second while it takes the
 * second sample a CPU percentage needs - a dozen of those is a dialog that opens
 * in twelve seconds.
 */
async function sampleContainers(
    driver: DockerDriver,
    connectionId: string,
    running: readonly ContainerSummary[]
): Promise<{ samples: Map<string, ContainerStats>; at: number | null }> {
    const held = cachedSamples(connectionId);
    const cutoff = Date.now() - SAMPLE_MAX_AGE_MS;
    const samples = new Map<string, ContainerStats>();
    let oldest: number | null = null;
    const missing: string[] = [];

    for (const container of running) {
        const sample = held.get(container.id) ?? held.get(container.name);
        if (sample && sample.at >= cutoff) {
            samples.set(container.id, sample.stats);
            if (oldest === null || sample.at < oldest) oldest = sample.at;
        } else {
            missing.push(container.id);
        }
    }
    if (missing.length > 0) {
        const fresh = await driver.statsMany(missing);
        const at = Date.now();
        for (const [id, stats] of fresh) {
            if (stats) samples.set(id, stats);
        }
        // A reading taken now is never older than one that was held, so this only
        // fills in the instant when nothing was held at all.
        if (oldest === null) oldest = at;
    }
    return { samples, at: oldest };
}

/** What to call a container, and where its page is. Three answers in order of how
 *  much is known: part of Polaris itself, a service Polaris deployed, or
 *  something started on the machine that only the Containers screen knows. */
function describeContainer(
    container: ContainerSummary,
    connectionId: string,
    owners: Map<string, DeployedApp>
): { key: string; label: string; detail: string | null; href: string | null } {
    const containerHref = `/apps/containers/${encodeURIComponent(container.name)}?c=${encodeURIComponent(connectionId)}`;
    if (isPolarisPart(container)) {
        const part = describePart(container);
        return {
            key: container.id,
            label: `Polaris - ${part.label}`,
            detail: part.summary || null,
            href: containerHref
        };
    }
    const app = owners.get(baseProject(container.composeProject) ?? "");
    if (app) {
        return {
            key: container.id,
            label: app.name,
            detail: app.where,
            href: `/apps/deploy/${app.projectId}?service=${app.id}`
        };
    }
    return { key: container.id, label: container.name, detail: null, href: containerHref };
}

/** A service Polaris deployed, in the terms a row needs it. */
interface DeployedApp {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
    /** "Project / Environment", which is how a service is placed everywhere else. */
    readonly where: string;
}

/**
 * The services Polaris deployed to one machine, keyed by the compose project each
 * one runs under.
 *
 * A deployed service's project is `polaris-<hash of its id>`, and the hash is one
 * way - so this goes the other way round, hashing every service and looking the
 * answer up. Not owner-scoped: a container is on the machine whoever deployed it,
 * and a row that could not name it would say nothing instead of naming somebody
 * else's service. Only the name and where it lives are taken, and the caller has
 * already been gated on reading this machine.
 */
async function deployedOn(serverId: string): Promise<Map<string, DeployedApp>> {
    const apps = await prisma.application
        .findMany({
            where: { target: targetOn(serverId) },
            select: {
                id: true,
                name: true,
                environment: {
                    select: { name: true, projectId: true, project: { select: { name: true } } }
                }
            }
        })
        .catch(() => []);
    return new Map(
        apps.map((app) => [
            `polaris-${shortHash(app.id, 8)}`,
            {
                id: app.id,
                name: app.name,
                projectId: app.environment.projectId,
                where: `${app.environment.project.name} / ${app.environment.name}`
            }
        ])
    );
}

/** Which deploy targets are the machine in question. The local target is the one
 *  with no server behind it, however it was recorded. */
function targetOn(serverId: string): Prisma.DeployTargetWhereInput {
    return serverId === LOCAL_SERVER_ID
        ? { OR: [{ kind: "local" }, { hostId: null }] }
        : { hostId: serverId };
}

// --- storage ----------------------------------------------------------------

/** What the reader can do about each part of the container store, in the terms
 *  the Servers screen already puts them in. */
/** Where a machine's storage is looked at and the regenerable half of it handed
 *  back. Every storage row leads here when it leads nowhere better. */
const STORAGE_SCREEN = `/apps/servers/${LOCAL_SERVER_ID}?tab=storage`;

const STORE_ROWS: { key: "images" | "buildCache" | "containers"; label: string; detail: string }[] = [
    { key: "images", label: "Images", detail: "What every deployed service runs from." },
    { key: "buildCache", label: "Build cache", detail: "Comes back on the next build." },
    { key: "containers", label: "Containers", detail: "What running services wrote outside a volume." }
];

/**
 * Where the disk of the machine Polaris runs on went.
 *
 * The question this exists for, and the one where being honest about the edges
 * matters most: the volumes and the container store are measured, and everything
 * else on the disk - the system, whatever else is installed on the box - is one
 * row that says so rather than being quietly left out of a list that then looks
 * like the whole disk.
 */
async function machineStorage(): Promise<Breakdown> {
    const [volumes, space, disk] = await Promise.all([
        hostVolumes().catch(() => null),
        hostSpace().catch(() => null),
        localDisk()
    ]);
    if (!volumes && !space) {
        return nothingToShow("This machine would not say what it is holding.");
    }

    const parts: BreakdownPart[] = [];
    for (const volume of volumes ?? []) {
        if (!volume.bytes) continue;
        parts.push({
            key: `volume:${volume.name}`,
            label: volume.name,
            kind: "volume",
            detail: volume.owner
                ? `Belongs to ${volume.owner}`
                : volume.spare
                  ? "Nothing on this machine uses it"
                  : "Polaris has no record of this one",
            value: volume.bytes,
            // Its files where there is a way in, and otherwise the screen where
            // this volume can be looked at and removed - a row naming a large
            // volume with nowhere to go from it is the defect, not the missing
            // file browser.
            href: volume.browseHref ?? STORAGE_SCREEN
        });
    }
    if (space) {
        for (const row of STORE_ROWS) {
            parts.push({
                key: row.key,
                label: row.label,
                kind: "store",
                detail: row.detail,
                value: space[row.key],
                href: STORAGE_SCREEN
            });
        }
    }

    // Nothing to rank rather than one row saying the whole disk is unaccounted
    // for, which is a figure with a label on it rather than an answer.
    if (parts.length === 0) return nothingToShow("This machine would not say what it is holding.");

    const total = wholeOf(disk?.used ?? null, parts);
    const rest = remainder(total, parts, {
        key: "rest",
        label: "Everything else on this machine",
        detail: "The system itself and anything installed outside Polaris."
    });
    return {
        rows: ranked(rest ? [...parts, rest] : parts, total),
        total,
        note: volumes
            ? "Volumes are measured one by one. Nothing here is removed for you."
            : "The volumes on this machine could not be listed, so only the store is broken out.",
        unavailable: null,
        at: Date.now()
    };
}

/**
 * What one service is storing, volume by volume.
 *
 * The only breakdown a service has, and it is the right one: a service's storage
 * line IS the volumes it mounts added together, measured as subjects of their own
 * on a slower cadence than the container. Read at the end of the window rather
 * than now, so a chart of last week is broken down by what was on the volumes last
 * week.
 */
async function serviceStorage(viewerId: string, applicationId: string, to: Date): Promise<Breakdown> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId: viewerId } } },
        select: { id: true, volumes: { select: { id: true, name: true, mountPath: true } } }
    });
    if (!app) return nothingToShow("That service is not here any more.");
    if (app.volumes.length === 0) {
        return nothingToShow("This service has no volumes, so it stores nothing of its own.");
    }

    const ids = app.volumes.map((volume) => volume.id);
    const held = await volumeSizesAt(ids, to);
    const parts = app.volumes.flatMap<BreakdownPart>((volume) => {
        const used = held.get(volume.id);
        if (used === undefined) return [];
        return [
            {
                key: volume.id,
                label: volume.name,
                kind: "volume",
                detail: `Mounted at ${volume.mountPath}`,
                value: used,
                href: driveHref(app.id, volume.mountPath)
            }
        ];
    });
    if (parts.length === 0) {
        return nothingToShow(
            "Nothing has measured this service's volumes yet. They are read on a slower cadence than the chart."
        );
    }

    const total = wholeOf(null, parts);
    return {
        rows: ranked(parts, total),
        total,
        note: "Measured from inside the service, which is the one place every kind of volume resolves to a path.",
        unavailable: null,
        at: null
    };
}

/**
 * How full each volume was at the end of the window, in bytes.
 *
 * Reaching a day back from it for the reason the chart does: a volume is measured
 * every few minutes at best, because measuring one walks its whole tree - so a
 * window that opens between two measurements would find none of them and report a
 * service that stores nothing.
 *
 * The rollups are the fallback rather than the first read, and only where the raw
 * samples have already been swept: raw is kept for days and rollups for months, so
 * a breakdown of a window a fortnight ago has nothing else to read.
 */
async function volumeSizesAt(subjectIds: string[], to: Date): Promise<Map<string, number>> {
    const since = new Date(to.getTime() - 24 * 3_600_000);
    const rows = await prisma.metricSample.findMany({
        where: { subjectType: "volume", subjectId: { in: subjectIds }, ts: { gte: since, lte: to } },
        orderBy: { ts: "asc" },
        select: { subjectId: true, diskUsedBytes: true }
    });
    const held = new Map<string, number>();
    for (const row of rows) {
        if (row.diskUsedBytes != null) held.set(row.subjectId, Number(row.diskUsedBytes));
    }
    if (held.size > 0) return held;

    const buckets = await prisma.metricRollup.findMany({
        where: {
            subjectType: "volume",
            subjectId: { in: subjectIds },
            bucket: { gte: new Date(to.getTime() - 30 * 24 * 3_600_000), lte: to }
        },
        orderBy: { bucket: "asc" },
        select: { subjectId: true, diskUsedBytesAvg: true }
    });
    for (const row of buckets) {
        if (row.diskUsedBytesAvg != null) held.set(row.subjectId, Number(row.diskUsedBytesAvg));
    }
    return held;
}

/** The way into a volume's files: the service that mounts it, at the path it
 *  mounts it on. The same link the Files panel offers, from the other end. */
function driveHref(applicationId: string, mountPath: string): string {
    const path = mountPath.replace(/^\/+|\/+$/g, "");
    return `/drive?c=container:${applicationId}&p=${encodeURIComponent(path)}`;
}

// --- bandwidth --------------------------------------------------------------

/** Said when the window cannot be divided up: nothing of the reader's runs here,
 *  or nothing was read often enough inside it to turn a counter into a rate. */
const NOTHING_SENT =
    "Nothing was recorded for long enough in this window to say what sent it. A wider range will have more to go on.";

/**
 * Which services sent what, over the window on the chart.
 *
 * Derived from the counters already stored rather than measured again, which is
 * the only honest way to answer for a window that has already passed. Two things
 * follow from that and both are said on screen:
 *
 *   - A counter needs two readings to become a distance. A service sampled once
 *     inside the window contributes nothing and is left out, and a window where
 *     that is true of every service has no ranking at all rather than a made-up
 *     one.
 *   - The machine counted more than the services on it: anything running there
 *     that Polaris did not deploy has no series of its own. That gap is the
 *     leftover row, not a rounding error, and on a busy box it is the largest row
 *     in the list.
 */
async function machineTraffic(viewerId: string, request: BreakdownRequest): Promise<Breakdown> {
    const apps = await prisma.application.findMany({
        where: { environment: { project: { ownerId: viewerId } }, target: targetOn(request.id) },
        select: {
            id: true,
            name: true,
            environment: { select: { name: true, projectId: true, project: { select: { name: true } } } }
        }
    });
    // Nothing of the reader's runs here, so there is nothing to attribute the
    // machine's traffic to - and the machine's own total is not theirs to read
    // just because they know a server's address.
    if (apps.length === 0) return nothingToShow(NOTHING_SENT);

    const spanMs = request.to - request.from;
    const from = new Date(request.from);
    const to = new Date(request.to);
    const [moved, machine] = await Promise.all([
        sentBySubject("app", apps.map((app) => app.id), from, to, spanMs),
        sentBySubject("host", [hostSubject(request.id)], from, to, spanMs)
    ]);

    const parts = apps.flatMap<BreakdownPart>((app) => {
        const rate = ratePerSecond(moved.get(app.id) ?? null, spanMs);
        if (rate === null) return [];
        return [
            {
                key: app.id,
                label: app.name,
                kind: "container",
                detail: `${app.environment.project.name} / ${app.environment.name}`,
                value: rate,
                href: `/apps/deploy/${app.environment.projectId}?service=${app.id}`
            }
        ];
    });

    if (parts.length === 0) return nothingToShow(NOTHING_SENT);

    const machineRate = ratePerSecond(machine.get(hostSubject(request.id)) ?? null, spanMs);

    const total = wholeOf(machineRate, parts);
    const rest = remainder(total, parts, {
        key: "rest",
        label: "Everything else on this machine",
        detail: "Containers Polaris did not deploy, and the machine's own traffic."
    });
    return {
        rows: ranked(rest ? [...parts, rest] : parts, total),
        total,
        note: "Averaged over the window on the chart, from what each service's own container counted. A service read only once in the window has no rate and is left out.",
        unavailable: null,
        at: null
    };
}

/**
 * How far each subject's upload counter advanced inside the window, in bytes.
 *
 * The same two tables the chart itself reads, chosen the same way: a window the
 * raw samples still cover is differenced from them, and a wider one is summed
 * from the hourly rollups, whose network columns are already the ground each hour
 * covered. Reading raw for a 30-day window would find the last week and nothing
 * before it, which reads as a service that did not exist yet.
 */
async function sentBySubject(
    subjectType: "app" | "host",
    subjectIds: string[],
    from: Date,
    to: Date,
    spanMs: number
): Promise<Map<string, bigint>> {
    const sent = new Map<string, bigint>();
    if (spanMs <= RAW_MAX_SPAN_MS) {
        const rows = await prisma.metricSample.findMany({
            where: { subjectType, subjectId: { in: subjectIds }, ts: { gte: from, lte: to } },
            orderBy: { ts: "asc" },
            select: { subjectId: true, netTxBytes: true }
        });
        const readings = new Map<string, (bigint | null)[]>();
        for (const row of rows) {
            const held = readings.get(row.subjectId);
            if (held) held.push(row.netTxBytes);
            else readings.set(row.subjectId, [row.netTxBytes]);
        }
        for (const [subjectId, values] of readings) {
            const advance = counterAdvance(values);
            if (advance !== null) sent.set(subjectId, advance);
        }
        return sent;
    }

    const rows = await prisma.metricRollup.findMany({
        where: { subjectType, subjectId: { in: subjectIds }, bucket: { gte: from, lte: to } },
        select: { subjectId: true, netTxBytesSum: true }
    });
    for (const row of rows) {
        if (row.netTxBytesSum == null) continue;
        sent.set(row.subjectId, (sent.get(row.subjectId) ?? 0n) + row.netTxBytesSum);
    }
    return sent;
}
