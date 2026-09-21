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

import { PERSONAL_KIND } from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";
import { publishMetricTick } from "./metrics-live";
import type { DockerDriver } from "@polaris/docker";
import { recordMachineCores } from "./machine-cores";
import { rememberSample } from "./container-stats-cache";
import { getPorts, type TargetRow } from "./deploy/runtime";
import { getServerMetrics } from "./server-metrics-service";
import { recordHostDockerId, recordLocalDockerId } from "./local-machine";
import { getDriverForConnection, getUnasMetrics } from "./storage-service";
import { currentReleaseRef, servingContainerNames } from "./deploy/releases";
import {
    hostDockerDriver,
    HOST_DOCKER_PREFIX,
    localDockerDriver,
    LOCAL_DOCKER_CONNECTION_ID
} from "./docker-service";
import {
    COLLECT_TICK_MS,
    counterAdvance,
    LOCAL_HOST_SUBJECT,
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

/**
 * Sample every deployed application's container (local via the host daemon,
 * remote via Docker over SSH). Stopped/unreachable containers are skipped.
 *
 * Grouped by the machine the service runs on, so a server carrying several of
 * them is opened once and its containers are read together, instead of one
 * connection and one blocking second per service.
 */
async function collectApps(ts: Date): Promise<SampleRow[]> {
    const apps = await prisma.application.findMany({
        where: { currentDeploymentId: { not: null } },
        include: { environment: { include: { project: true } }, target: true }
    });

    const byMachine = new Map<string, typeof apps>();
    for (const app of apps) {
        const key =
            app.target.kind === "local" || !app.target.hostId
                ? "local"
                : `host:${app.target.hostId}`;
        const group = byMachine.get(key);
        if (group) group.push(app);
        else byMachine.set(key, [app]);
    }

    const rows: SampleRow[] = [];
    for (const [key, group] of byMachine) {
        const first = group[0];
        if (!first) continue;
        let driver: DockerDriver | null = null;
        try {
            driver =
                key === "local"
                    ? localDockerDriver()
                    : await hostDockerDriver(
                          key.slice("host:".length),
                          first.environment.project.ownerId
                      );
            // The container serving each service right now, which is not the
            // service's own name once a release runs in a project of its own.
            const names = await servingContainerNames(group);
            const samples = await driver.statsMany([...names.values()]);
            for (const app of group) {
                const stats = samples.get(names.get(app.id) ?? "");
                // Not running this tick. That is an absent sample rather than a
                // zero: a gap in the chart reads as "not running", a zero as idle.
                if (!stats) continue;
                rows.push({
                    subjectType: "app",
                    subjectId: app.id,
                    ts,
                    cpuPercent: round2(stats.cpuPercent),
                    memUsedBytes: bigBytes(stats.memUsage),
                    memTotalBytes: bigBytes(stats.memLimit),
                    // The counters as the container reports them. Turning them
                    // into a rate needs two of these and the gap between them,
                    // which is the reader's job - see `metrics-history-service`.
                    netRxBytes: bigBytes(stats.netRx),
                    netTxBytes: bigBytes(stats.netTx)
                });
            }
        } catch {
            // Host unreachable this tick - its services contribute nothing.
        } finally {
            if (driver) await driver.dispose().catch(() => undefined);
        }
    }
    return rows;
}

/**
 * The machine's own disk, read from inside the container Polaris runs in.
 *
 * `/` in a container is an overlay whose upper layer lives on the machine's
 * filesystem, and `statfs` there reports that filesystem - the same figures `df`
 * gives on the box. It is the only reading of the disk available in every
 * edition: it needs no privileged daemon, no shell on the host and no new
 * transport, which is what a deployment that is only ever updated from a button
 * can be counted on to have.
 *
 * Used, not free-as-used: what is counted is what `df` calls used, so the number
 * beside the total is the number an operator would see on the machine.
 */
async function localDisk(): Promise<{ used: number; total: number } | null> {
    try {
        const { statfs } = await import("node:fs/promises");
        const info = await statfs("/");
        const size = Number(info.bsize);
        const total = Number(info.blocks) * size;
        const free = Number(info.bfree) * size;
        if (!Number.isFinite(total) || total <= 0) return null;
        return { total, used: Math.max(0, total - free) };
    } catch {
        // Not a filesystem this can be asked about (a dev run on Windows).
        return null;
    }
}

/**
 * What a machine says about itself, whichever way it was asked.
 *
 * Every field is best effort and independent of the others: a box that answers
 * about its memory but not its disk is measured for its memory, the same way the
 * probe behind a server's panel treats a missing number.
 */
interface MachineReading {
    cpuPercent: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    disk: { used: number; total: number } | null;
    cores: number | null;
    /** Interface counters since boot, where the machine could be asked for them. */
    net: { rx: number; tx: number } | null;
}

/**
 * How hard a machine is being worked, as a percentage of itself.
 *
 * The load average against the core count - the same reading the panel above the
 * chart puts on screen ("0.11 load of 2"), so the two cannot disagree about the
 * same machine. Clamped because the chart's ceiling is the whole machine: a load
 * past the core count is a queue, and how long that queue is belongs on a panel
 * that can say so rather than off the top of a chart.
 */
function loadPercent(load: number | null, cores: number | null): number | null {
    if (load == null || !cores) return null;
    return round2(Math.min(100, (load / cores) * 100));
}

/** One file of `/proc`, or null where there is no `/proc` to read (a dev run on
 *  Windows or macOS). */
async function readProc(path: string): Promise<string | null> {
    try {
        const { readFile } = await import("node:fs/promises");
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

function numberOf(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The machine Polaris runs on, read from `/proc`.
 *
 * A container gets neither its own `/proc/loadavg` nor its own `/proc/meminfo`:
 * both are the host's, the same figures `uptime` and `free` give on the box. So
 * the one server that has no login to probe is still measured, and measured as a
 * whole machine rather than as the sum of what Polaris happens to have deployed
 * on it.
 */
async function localMachine(): Promise<MachineReading | null> {
    const [loadavg, meminfo, disk] = await Promise.all([
        readProc("/proc/loadavg"),
        readProc("/proc/meminfo"),
        localDisk()
    ]);
    if (loadavg === null && meminfo === null && disk === null) return null;

    // Available, not free, for the same reason the probe uses it: free counts the
    // page cache as gone, which reports a healthy machine as nearly out of memory.
    const total = numberOf(/^MemTotal:\s+(\d+)/m.exec(meminfo ?? "")?.[1]);
    const available = numberOf(/^MemAvailable:\s+(\d+)/m.exec(meminfo ?? "")?.[1]);
    const { cpus } = await import("node:os");
    const cores = cpus().length || null;
    return {
        cpuPercent: loadPercent(numberOf(loadavg?.trim().split(/\s+/)[0]), cores),
        memUsedBytes: total !== null && available !== null ? (total - available) * 1024 : null,
        memTotalBytes: total === null ? null : total * 1024,
        disk,
        cores,
        // A container's `/proc/net/dev` is its own network namespace, so what it
        // reports is Polaris's own traffic under the heading of the whole box.
        // The containers are counted for this one instead.
        net: null
    };
}

/**
 * A registered server's own report of itself, over SSH.
 *
 * The same probe the server's page runs, and cached by it for half a tick, so a
 * page open on this machine and this collector share one session's answer rather
 * than each opening their own.
 */
async function probedMachine(hostId: string, ownerId: string): Promise<MachineReading | null> {
    try {
        const metrics = await getServerMetrics(hostId, ownerId);
        return {
            cpuPercent: loadPercent(metrics.loadAverage, metrics.cpuCount),
            memUsedBytes: metrics.memoryUsedBytes,
            memTotalBytes: metrics.memoryTotalBytes,
            disk:
                metrics.diskUsedBytes != null && metrics.diskTotalBytes != null
                    ? { used: metrics.diskUsedBytes, total: metrics.diskTotalBytes }
                    : null,
            cores: metrics.cpuCount,
            net:
                metrics.netRxBytes != null && metrics.netTxBytes != null
                    ? { rx: metrics.netRxBytes, tx: metrics.netTxBytes }
                    : null
        };
    } catch {
        // Off, unreachable, or without a login Polaris can use.
        return null;
    }
}

/**
 * How much the containers on one machine have moved, as a counter that only goes
 * up.
 *
 * Summing what each container reports would not do. That sum falls the moment one
 * of them stops or is replaced, and the reader turns a counter into a rate by
 * differencing it - a fall reads as "it restarted and has moved this much since",
 * so every deploy would draw a burst of traffic that never happened. What is kept
 * instead is each container's last reading and a total that only ever has forward
 * movement added to it.
 *
 * A container seen for the first time contributes nothing: it may have been
 * running for a month before this process started, and its counter is a position,
 * not something that moved during this tick.
 *
 * Held in memory, by the one process that collects. After a restart the total
 * begins again at zero, which the reader sees as a single fall followed by
 * ordinary rates rather than as a machine that sent everything at once.
 */
const traffic = new Map<
    string,
    { rx: bigint; tx: bigint; seen: Map<string, { rx: number; tx: number }> }
>();

function advanceTraffic(
    subjectId: string,
    readings: Map<string, { rx: number; tx: number }>
): { rx: bigint; tx: bigint } {
    const held = traffic.get(subjectId);
    let rx = held?.rx ?? 0n;
    let tx = held?.tx ?? 0n;
    for (const [id, now] of readings) {
        const before = held?.seen.get(id);
        if (!before) continue;
        // A counter below where it was is a container that started again.
        rx += bigBytes(now.rx >= before.rx ? now.rx - before.rx : now.rx) ?? 0n;
        tx += bigBytes(now.tx >= before.tx ? now.tx - before.tx : now.tx) ?? 0n;
    }
    traffic.set(subjectId, { rx, tx, seen: readings });
    return { rx, tx };
}

/**
 * Sample each server's load: the whole machine, and what of it the containers
 * running on it are using.
 *
 * The machine is asked about itself first - `/proc` for the box Polaris runs in,
 * the SSH probe for a registered server - because that is the only reading that
 * exists on a server with nothing deployed on it yet. A server carrying no
 * containers used to chart a flat zero under a panel reporting real load, which
 * reads as monitoring that does not work rather than as a machine at rest.
 *
 * The containers are still read on the same tick: they are what the Containers
 * screen serves, they carry the traffic counters where the machine cannot be
 * asked for its own, and they answer for a box whose `/proc` is not readable.
 *
 * The local machine is sampled first, because a registered server can turn out to
 * be that same machine reached over SSH; one that is gets no second series of its
 * own (see `lib/local-machine`).
 */
async function collectHosts(ts: Date): Promise<SampleRow[]> {
    const hosts = await prisma.host.findMany({
        // The daemon it answered with last time, for a server that cannot be
        // reached this tick but was already known to be this machine.
        select: { id: true, ownerId: true, dockerId: true }
    });
    const rows: SampleRow[] = [];

    const local = await sampleHost(LOCAL_HOST_SUBJECT, null, ts);
    if (local) {
        rows.push(local.row);
        if (local.dockerId) await recordLocalDockerId(local.dockerId);
    }

    for (const host of hosts) {
        const sample = await sampleHost(host.id, host.ownerId, ts);
        if (!sample) continue;
        if (sample.dockerId) await recordHostDockerId(host.id, sample.dockerId);
        // The same box, reached the long way round. Its load is already in this
        // tick under the local subject, and writing it again would produce a
        // second server that disagrees with the first about the same CPU.
        const daemon = sample.dockerId ?? host.dockerId;
        if (local?.dockerId && daemon && daemon === local.dockerId) continue;
        rows.push(sample.row);
    }
    return rows;
}

/** What the containers on one machine are using, added up, plus which daemon
 *  answered. Null when the machine has no reachable daemon. Each container it
 *  reads on the way is left in the Containers cache, so that screen has a reading
 *  to open on rather than a second pass over the same daemon. */
async function containersOn(
    subjectId: string,
    ownerId: string | null
): Promise<{
    dockerId: string;
    cores: number | null;
    memTotalBytes: number | null;
    cpuPercent: number;
    memUsedBytes: number;
    net: Map<string, { rx: number; tx: number }>;
} | null> {
    let driver: DockerDriver | null = null;
    try {
        driver =
            ownerId === null ? localDockerDriver() : await hostDockerDriver(subjectId, ownerId);
        const info = await driver.info();
        const running = (await driver.listContainers(false)).filter(
            (entry) => entry.state === "running"
        );

        // Concurrently: a stats read waits a second on the daemon for its second
        // CPU sample, so a machine with a dozen containers would otherwise spend
        // most of a tick waiting rather than measuring.
        const samples = await driver.statsMany(running.map((container) => container.id));
        // This pass has just read every container on the machine, one at a time,
        // to add them up. Handing each one to the Containers cache on the way past
        // costs nothing and is the difference between opening that screen on the
        // last minute's figures and opening it on blanks - so the readings there
        // come from this collector rather than from a second pass over the same
        // daemon asking it the same question.
        const connectionId =
            ownerId === null ? LOCAL_DOCKER_CONNECTION_ID : `${HOST_DOCKER_PREFIX}${subjectId}`;
        let cpu = 0;
        let memory = 0;
        const net = new Map<string, { rx: number; tx: number }>();
        for (const container of running) {
            const stats = samples.get(container.id);
            // A container that stopped between the list and the read.
            if (!stats) continue;
            rememberSample(connectionId, [container.id, container.name], stats);
            cpu += stats.cpuPercent;
            memory += stats.memUsage;
            net.set(container.id, { rx: stats.netRx, tx: stats.netTx });
        }
        return {
            dockerId: info.id,
            cores: info.ncpu || null,
            memTotalBytes: info.memTotal,
            // Already a share of the machine per container, so this sum is one
            // too and needs no core count. Clamped anyway: the samples are read
            // one container at a time over a moment, and a busy box can hand
            // back a set that adds up to a hair over the whole machine.
            cpuPercent: round2(Math.min(100, cpu)),
            memUsedBytes: memory,
            net
        };
    } catch {
        // Daemon absent or host unreachable this tick.
        return null;
    } finally {
        if (driver) await driver.dispose().catch(() => undefined);
    }
}

/**
 * One server's load this tick, plus which daemon answered if one did.
 *
 * The machine's own reading wins every column it could fill, and the containers
 * answer for the rest: a box whose `/proc` cannot be read or whose login does not
 * work is still measured for what Polaris runs on it, which is what this used to
 * be able to say and all it could say.
 *
 * Null only when neither could be read at all - that is a server that is off, and
 * a gap in its chart is the truth about it.
 */
async function sampleHost(
    subjectId: string,
    ownerId: string | null,
    ts: Date
): Promise<{ row: SampleRow; dockerId: string | null } | null> {
    const [machine, containers] = await Promise.all([
        ownerId === null ? localMachine() : probedMachine(subjectId, ownerId),
        containersOn(subjectId, ownerId)
    ]);
    if (!machine && !containers) return null;

    // What turns a service's share of this machine into cores, for billing. A
    // failed write costs the reading nothing.
    const cores = containers?.cores ?? machine?.cores ?? null;
    if (cores) await recordMachineCores(subjectId, cores).catch(() => undefined);

    // One source or the other, never both added together: the machine's counters
    // already include everything its containers moved. `advanceTraffic` keeps its
    // own total per server, so a machine that stops answering and leaves this
    // falling back to its containers contributes nothing that tick instead of the
    // difference between two unrelated counters.
    const moved = advanceTraffic(
        subjectId,
        machine?.net ? new Map([["machine", machine.net]]) : (containers?.net ?? new Map())
    );
    return {
        dockerId: containers?.dockerId ?? null,
        row: {
            subjectType: "host",
            subjectId,
            ts,
            cpuPercent: machine?.cpuPercent ?? containers?.cpuPercent ?? null,
            memUsedBytes: bigBytes(machine?.memUsedBytes ?? containers?.memUsedBytes),
            memTotalBytes: bigBytes(machine?.memTotalBytes ?? containers?.memTotalBytes),
            diskUsedBytes: bigBytes(machine?.disk?.used),
            diskTotalBytes: bigBytes(machine?.disk?.total),
            netRxBytes: moved.rx,
            netTxBytes: moved.tx
        }
    };
}

/**
 * Sample how full every attached volume is, measured from inside the service
 * that mounts it - the one place a named volume, a host bind and a NAS mount all
 * resolve to the same path. Only volumes on a deployed service can be read, so
 * the rest are skipped rather than written as an all-null row.
 *
 * `diskTotalBytes` carries the volume's declared cap where it has one, which is
 * what turns the chart from a rising line into a percentage of something.
 */
async function collectVolumes(ts: Date): Promise<SampleRow[]> {
    const volumes = await prisma.volume.findMany({
        where: { application: { currentDeploymentId: { not: null } } },
        include: {
            target: true,
            application: {
                include: {
                    environment: { include: { project: true } },
                    target: true,
                    volumes: { select: { id: true } }
                }
            }
        }
    });
    const rows: SampleRow[] = [];
    // One ports connection per target, not per volume: a server with a dozen
    // volumes would otherwise open a dozen SSH sessions every tick.
    const byTarget = new Map<string, typeof volumes>();
    for (const volume of volumes) {
        const group = byTarget.get(volume.targetId);
        if (group) group.push(volume);
        else byTarget.set(volume.targetId, [volume]);
    }

    for (const group of byTarget.values()) {
        const first = group[0];
        if (!first?.application) continue;
        const ownerId = first.application.environment.project.ownerId;
        let ports: Awaited<ReturnType<typeof getPorts>> | null = null;
        try {
            ports = await getPorts(first.target as TargetRow, ownerId);
            for (const volume of group) {
                if (!volume.application) continue;
                try {
                    const container = (await currentReleaseRef(volume.application)).name;
                    const used = await ports.diskUsage(container, volume.mountPath);
                    if (used == null) continue;
                    rows.push({
                        subjectType: "volume",
                        subjectId: volume.id,
                        ts,
                        diskUsedBytes: bigBytes(used),
                        diskTotalBytes: bigBytes(parseSizeLimit(volume.sizeLimit))
                    });
                } catch {
                    // One unreadable volume must not cost the others their sample.
                }
            }
        } catch {
            // Host unreachable this tick.
        } finally {
            if (ports) await ports.dispose().catch(() => undefined);
        }
    }
    return rows;
}

/** A declared cap like "10G" or "500M" as bytes, or null when there is none. */
export function parseSizeLimit(limit: string | null): number | null {
    if (!limit) return null;
    const match = /^(\d+(?:\.\d+)?)\s*(K|M|G|T)i?B?$/i.exec(limit.trim());
    if (!match) return null;
    const scale: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
    const factor = scale[(match[2] ?? "").toLowerCase()];
    return factor ? Number(match[1]) * factor : null;
}

/** Sample every storage connection: rich CPU/memory/disk for a UniFi UNAS, disk
 *  usage for any other backend that reports it. */
async function collectStorage(ts: Date): Promise<SampleRow[]> {
    const conns = await prisma.storageConnection.findMany({
        // Not personal drives: each one reports the disk it sits on, so sampling
        // them would be the same reading once per account, and would open a
        // connection to that disk once per account to take it.
        where: { kind: { not: PERSONAL_KIND } },
        select: { id: true, ownerId: true, kind: true }
    });
    const rows: SampleRow[] = [];
    for (const conn of conns) {
        // Drives Polaris made are already excluded by kind above, so every row
        // here is a storage somebody connected and has the account that
        // connected it. Checked rather than asserted, because the column stopped
        // being required the day an organization got a Drive of its own.
        if (!conn.ownerId) continue;
        try {
            if (conn.kind === "unifi-unas") {
                const metrics = await getUnasMetrics(conn.id, conn.ownerId);
                rows.push({
                    subjectType: "storage",
                    subjectId: conn.id,
                    ts,
                    cpuPercent:
                        metrics.system.cpuLoad != null
                            ? round2(metrics.system.cpuLoad * 100)
                            : null,
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
    rows.push(...(await collectHosts(ts)));
    // Volumes ride the slower cadence: measuring one walks its whole tree, which
    // is far too expensive to do every minute beside a container stats read.
    if (opts.storage) rows.push(...(await collectVolumes(ts)), ...(await collectStorage(ts)));
    if (rows.length === 0) return 0;
    // Every row in a tick shares one timestamp and each subject is unique, so the
    // composite PK never collides - no skipDuplicates needed (unsupported on the
    // SQLite-portable target anyway).
    await prisma.metricSample.createMany({ data: rows });
    // Open charts re-read now rather than on their next poll.
    publishMetricTick(rows);
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

interface AggregatedSample {
    cpuPercent: number | null;
    cpuTempC: number | null;
    memUsedBytes: bigint | null;
    memTotalBytes: bigint | null;
    diskUsedBytes: bigint | null;
    diskTotalBytes: bigint | null;
    netRxBytes: bigint | null;
    netTxBytes: bigint | null;
}

function aggregate(list: AggregatedSample[]) {
    return {
        cpuPercentAvg: avgNum(list.map((row) => row.cpuPercent)),
        cpuPercentMax: maxNum(list.map((row) => row.cpuPercent)),
        cpuTempCAvg: avgNum(list.map((row) => row.cpuTempC)),
        memUsedBytesAvg: avgBig(list.map((row) => row.memUsedBytes)),
        memTotalBytesAvg: avgBig(list.map((row) => row.memTotalBytes)),
        diskUsedBytesAvg: avgBig(list.map((row) => row.diskUsedBytes)),
        diskTotalBytesAvg: avgBig(list.map((row) => row.diskTotalBytes)),
        netRxBytesSum: counterAdvance(list.map((row) => row.netRxBytes)),
        netTxBytesSum: counterAdvance(list.map((row) => row.netTxBytes)),
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
            where: { ts: { gte: bucket, lt: new Date(start + 3_600_000) } },
            // In the order they were taken: the network columns are counters, and
            // how far one advanced across an hour is only readable in sequence.
            orderBy: { ts: "asc" }
        });
        if (samples.length === 0) continue;
        const groups = new Map<string, typeof samples>();
        for (const sample of samples) {
            const key = `${sample.subjectType}\u0000${sample.subjectId}`;
            const group = groups.get(key);
            if (group) group.push(sample);
            else groups.set(key, [sample]);
        }
        for (const [key, list] of groups) {
            const separator = key.indexOf("\u0000");
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
    await prisma.metricSample.deleteMany({
        where: { ts: { lt: new Date(now.getTime() - RAW_RETENTION_MS) } }
    });
    await prisma.metricRollup.deleteMany({
        where: { bucket: { lt: new Date(now.getTime() - ROLLUP_RETENTION_MS) } }
    });
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
