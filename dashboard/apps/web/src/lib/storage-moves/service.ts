/**
 * Storage locations and moving a service's volume between them - the server half.
 *
 * A location is this server (the machine the service runs on) or a NAS share
 * Polaris already knows how to mount: an SMB, NFS or UniFi storage connection,
 * its credentials kept encrypted the way every connection's are.
 *
 * A move is a row and a worker, like Drive's long jobs: the row says how far it
 * got, so a reload, a closed tab or a rollover of the dashboard costs it nothing -
 * the next pass of the `storage-moves` job picks it up where it stopped, and every
 * step is written so that doing it again is harmless. The copy itself runs in a
 * one-off container on the service's own machine, beside the files, never through
 * the dashboard. See `plan.ts` for the states and why no path loses data.
 *
 * Managed databases are not offered: their volumes are not service volumes, and a
 * database is moved with its own dump and restore, not by copying files.
 *
 * Server-only.
 */

import * as plan from "./plan";
import { prisma } from "@polaris/db";
import { parseContainerState } from "@polaris/deploy";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { restartFromKeptImage } from "@/lib/deploy-service";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { getDriver, getDriverForConnection, resolveMountTarget } from "@/lib/storage-service";
import { lastDiskReadings, readDisk, type DiskReading } from "@/lib/deploy/disk-watch";
import { gameForCatalogId, HOST_MOUNTABLE_KINDS, withTimeout, type StorageConfig } from "@polaris/core";

/** How often a running copy is looked at. */
const POLL_MS = 3_000;
/** How long a worker holds a move. Renewed on every look at the copy, so only a
 *  worker that died lets it go; long enough to cover pulling the copier's image. */
const LEASE_MS = 10 * 60_000;
/** How long the app may take to come up on its new location before the move is
 *  undone. A first start of a large game server is minutes, not seconds. */
const START_LIMIT_MS = 30 * 60_000;
/** Polls in a row the copier may be missing before the copy is called lost. */
const LOST_AFTER = 5;
/** How long a location's size may take to answer. */
const SPACE_TIMEOUT_MS = 20_000;

/** Why a move failed, as the screen words it. The detail is what the copy itself
 *  said, kept short. */
export interface MoveError {
    readonly code:
        | plan.CopyFailure
        | "mount"
        | "stillRunning"
        | "startFailed"
        | "gone"
        | "unexpected"
        | "cleanFailed";
    readonly detail?: string;
    readonly freeBytes?: number;
    readonly neededBytes?: number;
    /** The rollback could not start the app again. */
    readonly notRestarted?: boolean;
}

class MoveFailure extends Error {
    public constructor(public readonly reason: MoveError) {
        super(reason.code);
    }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export interface ServerLocationView {
    readonly machine: string;
    readonly name: string | null;
    readonly total: number;
    readonly free: number;
    readonly level: DiskReading["level"];
}

export interface NasLocationView {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    /** host and share or export, never a secret. */
    readonly address: string;
    readonly ownerName: string | null;
    readonly volumes: number;
}

export interface LocationsView {
    readonly servers: ServerLocationView[];
    readonly nas: NasLocationView[];
}

function addressOf(kind: string, configJson: string): string {
    try {
        const config = JSON.parse(configJson) as StorageConfig;
        if (config.kind === "smb") return `//${config.host}/${config.share}`;
        if (config.kind === "nfs") return `${config.host}:${config.exportPath}`;
        if (config.kind === "unifi-unas") return config.smbShare ? `//${config.host}/${config.smbShare}` : config.host;
    } catch {
        // A config that does not parse still has a name to show.
    }
    return kind;
}

export async function listLocations(): Promise<LocationsView> {
    let readings = await lastDiskReadings().catch(() => [] as DiskReading[]);
    if (readings.length === 0) {
        const local = await readDisk("local").catch(() => null);
        readings = local ? [local] : [];
    }
    const rows = await prisma.storageConnection.findMany({
        where: { kind: { in: [...HOST_MOUNTABLE_KINDS] } },
        select: { id: true, name: true, kind: true, config: true, ownerId: true },
        orderBy: { name: "asc" },
        take: 200
    });
    const [owners, counts] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.ownerId).filter((id): id is string => Boolean(id)))] } },
            select: { id: true, name: true }
        }),
        prisma.volume.groupBy({
            by: ["connectionId"],
            where: { kind: "nas", connectionId: { in: rows.map((row) => row.id) } },
            _count: { _all: true }
        })
    ]);
    const ownerName = new Map(owners.map((owner) => [owner.id, owner.name]));
    const used = new Map(counts.map((count) => [count.connectionId, count._count._all]));
    return {
        servers: readings.map((reading) => ({
            machine: reading.machine,
            name: reading.name,
            total: reading.total,
            free: reading.free,
            level: reading.level
        })),
        nas: rows.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            address: addressOf(row.kind, row.config),
            ownerName: row.ownerId ? (ownerName.get(row.ownerId) ?? null) : null,
            volumes: used.get(row.id) ?? 0
        }))
    };
}

export type SpaceResult =
    | { readonly ok: true; readonly total: number | null; readonly used: number | null; readonly free: number | null }
    | { readonly ok: false; readonly reason: "missing" | "unreachable" | "denied" | "notMounted"; readonly detail?: string };

/**
 * Connect to a NAS location and read its size. This is the connection test: it
 * goes the same way a move does - through the host mount where there is one.
 */
export async function locationSpace(connectionId: string): Promise<SpaceResult> {
    const row = await prisma.storageConnection.findFirst({
        where: { id: connectionId, kind: { in: [...HOST_MOUNTABLE_KINDS] } },
        select: { id: true, ownerId: true }
    });
    if (!row) return { ok: false, reason: "missing" };
    let driver;
    try {
        driver = await withTimeout(
            row.ownerId ? getDriver(row.id, row.ownerId) : getDriverForConnection(row.id),
            SPACE_TIMEOUT_MS,
            "timed out"
        );
    } catch (caught) {
        const code = (caught as { code?: unknown } | null)?.code;
        const detail = caught instanceof Error ? caught.message.slice(0, 200) : undefined;
        if (code === "permission_denied") return { ok: false, reason: "denied", detail };
        if (code === "capability_required") return { ok: false, reason: "notMounted", detail };
        return { ok: false, reason: "unreachable", detail };
    }
    try {
        const usage = driver.capabilities.usage
            ? await withTimeout(driver.usage(), SPACE_TIMEOUT_MS, "timed out").catch(() => ({}) as Record<string, never>)
            : {};
        const number = (value: bigint | undefined) => (value === undefined ? null : Number(value));
        const total = number((usage as { total?: bigint }).total);
        const free = number((usage as { free?: bigint }).free);
        const used = number((usage as { used?: bigint }).used) ?? (total !== null && free !== null ? total - free : null);
        return { ok: true, total, used, free };
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// What is stored where
// ---------------------------------------------------------------------------

export interface DestinationView {
    /** `server`, or a connection id. */
    readonly value: string;
    /** Null for the machine Polaris runs on, which the screen names itself. */
    readonly label: string | null;
}

export interface VolumeLocationView {
    readonly id: string;
    readonly name: string;
    readonly mountPath: string;
    readonly applicationId: string;
    readonly appName: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly game: boolean;
    readonly deployed: boolean;
    /** On a swarm, where a service's volume is on whichever node runs it. */
    readonly swarm: boolean;
    /** `server`, or the connection id it lives on. */
    readonly location: string;
    readonly locationLabel: string | null;
    readonly destinations: DestinationView[];
    /** A move of this app that has not ended, if any. */
    readonly busy: boolean;
}

/** The server a target names, or null for this one. */
function machineOf(target: { kind: string; hostId: string | null }): string {
    return target.kind === "local" || !target.hostId ? "local" : target.hostId;
}

/**
 * Every service volume, game servers first, with the locations each one can go
 * to. A NAS location is offered only to the services of the account it belongs
 * to: a service's shares are mounted as its owner on every deploy.
 */
export async function listVolumeLocations(): Promise<VolumeLocationView[]> {
    const volumes = await prisma.volume.findMany({
        where: { applicationId: { not: null } },
        select: {
            id: true,
            name: true,
            mountPath: true,
            kind: true,
            source: true,
            connectionId: true,
            application: {
                select: {
                    id: true,
                    name: true,
                    currentDeploymentId: true,
                    target: { select: { kind: true, hostId: true, runtime: true } },
                    environment: { select: { project: { select: { id: true, name: true, ownerId: true } } } }
                }
            }
        },
        orderBy: { createdAt: "asc" },
        take: 1000
    });
    const appIds = [...new Set(volumes.map((volume) => volume.application!.id))];
    const ownerIds = [...new Set(volumes.map((volume) => volume.application!.environment.project.ownerId))];
    const hostIds = [...new Set(volumes.map((volume) => volume.application!.target.hostId).filter((id): id is string => Boolean(id)))];
    const [installs, connections, busy, hosts] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { in: appIds } },
            select: { applicationId: true, catalogId: true }
        }),
        prisma.storageConnection.findMany({
            where: { ownerId: { in: ownerIds }, kind: { in: [...HOST_MOUNTABLE_KINDS] } },
            select: { id: true, name: true, ownerId: true },
            orderBy: { name: "asc" }
        }),
        prisma.storageMove.findMany({
            where: { applicationId: { in: appIds }, state: { in: [...plan.BLOCKING_STATES] } },
            select: { applicationId: true }
        }),
        prisma.host.findMany({ where: { id: { in: hostIds } }, select: { id: true, name: true } })
    ]);
    const hostName = new Map(hosts.map((host) => [host.id, host.name]));
    const serverName = (machine: string): string | null => (machine === "local" ? null : (hostName.get(machine) ?? null));
    const games = new Set(
        installs.filter((install) => gameForCatalogId(install.catalogId)).map((install) => install.applicationId)
    );
    const moving = new Set(busy.map((move) => move.applicationId));
    const connectionName = new Map(connections.map((connection) => [connection.id, connection.name]));

    const views: VolumeLocationView[] = [];
    for (const volume of volumes) {
        const app = volume.application!;
        const placement = plan.placementOf(volume);
        if (!placement) continue;
        const ownerId = app.environment.project.ownerId;
        const here = plan.locationOf(placement);
        const server = serverName(machineOf(app.target));
        const destinations: DestinationView[] = [];
        if (here.kind !== "server") destinations.push({ value: "server", label: server });
        for (const connection of connections) {
            if (connection.ownerId !== ownerId) continue;
            if (here.kind === "nas" && here.connectionId === connection.id) continue;
            destinations.push({ value: connection.id, label: connection.name });
        }
        views.push({
            id: volume.id,
            name: volume.name,
            mountPath: volume.mountPath,
            applicationId: app.id,
            appName: app.name,
            projectId: app.environment.project.id,
            projectName: app.environment.project.name,
            game: games.has(app.id),
            deployed: Boolean(app.currentDeploymentId),
            swarm: app.target.runtime === "swarm",
            location: here.kind === "server" ? "server" : here.connectionId,
            locationLabel:
                here.kind === "server" ? server : (connectionName.get(here.connectionId) ?? here.connectionId),
            destinations,
            busy: moving.has(app.id)
        });
    }
    return views.sort((left, right) => Number(right.game) - Number(left.game));
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

export interface MoveView {
    readonly id: string;
    readonly volumeId: string;
    readonly applicationId: string;
    readonly state: plan.MoveState;
    readonly originLabel: string;
    readonly targetLabel: string;
    readonly appName: string;
    readonly volumeName: string;
    readonly percent: number | null;
    readonly totalBytes: number | null;
    readonly copiedBytes: number | null;
    readonly fileCount: number | null;
    readonly error: MoveError | null;
    readonly originRemoved: boolean | null;
    readonly createdAt: string;
    readonly finishedAt: string | null;
}

function errorOf(json: string | null): MoveError | null {
    if (!json) return null;
    try {
        return JSON.parse(json) as MoveError;
    } catch {
        return { code: "unexpected" };
    }
}

export async function listMoves(): Promise<MoveView[]> {
    const rows = await prisma.storageMove.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
    const [apps, volumes] = await Promise.all([
        prisma.application.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.applicationId))] } },
            select: { id: true, name: true }
        }),
        prisma.volume.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.volumeId))] } },
            select: { id: true, name: true }
        })
    ]);
    const appName = new Map(apps.map((app) => [app.id, app.name]));
    const volumeName = new Map(volumes.map((volume) => [volume.id, volume.name]));
    return rows.map((row) => {
        const total = row.totalBytes === null ? null : Number(row.totalBytes);
        const copied = row.copiedBytes === null ? null : Number(row.copiedBytes);
        const state = plan.isMoveState(row.state) ? row.state : "failed";
        return {
            id: row.id,
            volumeId: row.volumeId,
            applicationId: row.applicationId,
            state,
            originLabel: row.originLabel,
            targetLabel: row.targetLabel,
            appName: appName.get(row.applicationId) ?? "",
            volumeName: volumeName.get(row.volumeId) ?? "",
            percent: state === "copying" ? plan.progressPercent(copied, total) : null,
            totalBytes: total,
            copiedBytes: copied,
            fileCount: row.fileCount,
            error: errorOf(row.error),
            originRemoved: row.originRemoved,
            createdAt: row.createdAt.toISOString(),
            finishedAt: row.finishedAt?.toISOString() ?? null
        };
    });
}

export type StartRefusal = "missing" | "notDeployed" | "busy" | "sameLocation" | "notOffered" | "swarm";

/**
 * Queue a move of one volume to `destination` (`server` or a connection id) and
 * hand it to a worker. Refused with a reason the screen words.
 */
export async function startMove(input: {
    volumeId: string;
    destination: string;
    actorId: string;
    /** What the screen calls the machine Polaris runs on. */
    serverLabel: string;
}): Promise<{ id: string } | { refused: StartRefusal }> {
    const volume = await prisma.volume.findUnique({
        where: { id: input.volumeId },
        select: {
            id: true,
            name: true,
            kind: true,
            source: true,
            connectionId: true,
            applicationId: true,
            connection: { select: { name: true } },
            application: {
                select: {
                    id: true,
                    currentDeploymentId: true,
                    target: { select: { kind: true, hostId: true, runtime: true } },
                    environment: { select: { project: { select: { slug: true, ownerId: true } } } }
                }
            }
        }
    });
    const app = volume?.application;
    if (!volume || !app) return { refused: "missing" };
    if (!app.currentDeploymentId) return { refused: "notDeployed" };
    if (app.target.runtime === "swarm") return { refused: "swarm" };
    const origin = plan.placementOf(volume);
    if (!origin) return { refused: "missing" };
    const ownerId = app.environment.project.ownerId;
    const machine = machineOf(app.target);
    const server =
        machine === "local"
            ? input.serverLabel
            : ((await prisma.host.findUnique({ where: { id: machine }, select: { name: true } }))?.name ?? input.serverLabel);

    let location: plan.Location;
    let targetLabel: string;
    if (input.destination === "server") {
        location = { kind: "server" };
        targetLabel = server;
    } else {
        const connection = await prisma.storageConnection.findFirst({
            where: { id: input.destination, ownerId, kind: { in: [...HOST_MOUNTABLE_KINDS] } },
            select: { id: true, name: true }
        });
        if (!connection) return { refused: "notOffered" };
        location = { kind: "nas", connectionId: connection.id };
        targetLabel = connection.name;
    }
    if (plan.sameLocation(plan.locationOf(origin), location)) return { refused: "sameLocation" };
    const originLabel = origin.kind === "nas" ? (volume.connection?.name ?? server) : server;

    const created = await prisma.$transaction(async (tx) => {
        const running = await tx.storageMove.findFirst({
            where: { applicationId: app.id, state: { in: [...plan.BLOCKING_STATES] } },
            select: { id: true }
        });
        if (running) return null;
        const id = crypto.randomUUID();
        const destination = plan.destinationPlacement(location, {
            projectSlug: app.environment.project.slug,
            volumeName: volume.name,
            moveId: id
        });
        return tx.storageMove.create({
            data: {
                id,
                volumeId: volume.id,
                applicationId: app.id,
                ownerId,
                actorId: input.actorId,
                origin: JSON.stringify(origin),
                destination: JSON.stringify(destination),
                originLabel,
                targetLabel
            },
            select: { id: true }
        });
    });
    if (!created) return { refused: "busy" };
    void runMove(created.id).catch((caught: unknown) => console.error("polaris: storage move failed to run:", caught));
    return { id: created.id };
}

/** The person's answer to a finished move: empty the original, or keep it. */
export async function answerMove(id: string, answer: "remove" | "keep"): Promise<boolean> {
    const next = plan.nextState("moved", answer);
    const updated = await prisma.storageMove.updateMany({
        where: { id, state: "moved" },
        data: answer === "keep" ? { state: next, originRemoved: false, finishedAt: new Date() } : { state: next, error: null }
    });
    if (updated.count === 0) return false;
    if (answer === "remove")
        void runMove(id).catch((caught: unknown) => console.error("polaris: storage clean-up failed to run:", caught));
    return true;
}

/** The cron backstop: every move a worker should be holding and is not. */
export async function sweepStorageMoves(): Promise<{ resumed: number }> {
    const rows = await prisma.storageMove.findMany({
        where: {
            state: { in: [...plan.WORKING_STATES] },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
        },
        select: { id: true },
        take: 10
    });
    // Not awaited: a copy can take hours, and the pass is only the kick. Each move
    // runs under its own lease, so a second pass finds nothing to take.
    for (const row of rows)
        void runMove(row.id).catch((caught: unknown) => console.error("polaris: storage move failed to run:", caught));
    return { resumed: rows.length };
}

async function takeLease(id: string): Promise<boolean> {
    const now = new Date();
    const taken = await prisma.storageMove.updateMany({
        where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS) }
    });
    return taken.count === 1;
}

async function renewLease(id: string): Promise<void> {
    await prisma.storageMove.update({ where: { id }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MoveRow = NonNullable<Awaited<ReturnType<typeof prisma.storageMove.findUnique>>>;

interface MoveContext {
    readonly row: MoveRow;
    readonly origin: plan.Placement;
    readonly destination: plan.Placement;
    readonly app: {
        id: string;
        slug: string;
        desiredState: string;
        currentDeploymentId: string | null;
        environment: { project: { slug: string } };
        target: TargetRow;
    };
    readonly mountPath: string;
}

async function contextOf(row: MoveRow): Promise<MoveContext> {
    const [app, volume] = await Promise.all([
        prisma.application.findUnique({
            where: { id: row.applicationId },
            select: {
                id: true,
                slug: true,
                desiredState: true,
                currentDeploymentId: true,
                environment: { select: { project: { select: { slug: true } } } },
                target: true
            }
        }),
        prisma.volume.findUnique({ where: { id: row.volumeId }, select: { mountPath: true } })
    ]);
    if (!app || !volume) throw new MoveFailure({ code: "gone" });
    return {
        row,
        origin: plan.parsePlacement(row.origin),
        destination: plan.parsePlacement(row.destination),
        app: { ...app, target: app.target as TargetRow },
        mountPath: volume.mountPath
    };
}

/**
 * Work one move as far as it can go. Takes the lease or leaves it to whoever has
 * it; every step is safe to repeat, so a worker that died anywhere is replaced by
 * one that carries on.
 */
export async function runMove(id: string): Promise<void> {
    if (!(await takeLease(id))) return;
    try {
        for (;;) {
            const row = await prisma.storageMove.findUnique({ where: { id } });
            if (!row || !plan.isMoveState(row.state) || !plan.WORKING_STATES.includes(row.state)) return;
            const state = row.state;
            try {
                await step(row, state);
                await prisma.storageMove.update({
                    where: { id },
                    data: {
                        state: plan.nextState(state, "ok"),
                        ...(state === "cleaning" ? { originRemoved: true, finishedAt: new Date() } : {}),
                        ...(state === "rolling-back" ? { finishedAt: new Date() } : {})
                    }
                });
            } catch (caught) {
                const reason: MoveError =
                    caught instanceof MoveFailure ? caught.reason : { code: state === "cleaning" ? "cleanFailed" : "unexpected" };
                if (!(caught instanceof MoveFailure)) console.error(`polaris: storage move ${id} failed at ${state}:`, caught);
                if (state === "rolling-back") {
                    // The rollback could not finish; what it could not do is said beside the
                    // first reason rather than replacing it.
                    const first = errorOf(row.error) ?? reason;
                    await prisma.storageMove.update({
                        where: { id },
                        data: {
                            state: "failed",
                            finishedAt: new Date(),
                            error: JSON.stringify({ ...first, notRestarted: true })
                        }
                    });
                    return;
                }
                await prisma.storageMove.update({
                    where: { id },
                    data: { state: plan.nextState(state, "fail"), error: JSON.stringify(reason) }
                });
            }
            await renewLease(id);
        }
    } finally {
        await prisma.storageMove.update({ where: { id }, data: { leaseUntil: null } }).catch(() => undefined);
    }
}

async function step(row: MoveRow, state: plan.MoveState): Promise<void> {
    if (state === "queued") return;
    const context = await contextOf(row);
    if (state === "stopping") return stopApp(context);
    if (state === "copying") return copy(context);
    if (state === "switching") return switchVolume(context);
    if (state === "starting") return startApp(context, false);
    if (state === "cleaning") return cleanOrigin(context);
    if (state === "rolling-back") return rollBack(context);
}

async function withPorts<T>(context: MoveContext, work: (ports: Awaited<ReturnType<typeof getPorts>>) => Promise<T>): Promise<T> {
    const ports = await getPorts(context.app.target, context.row.ownerId);
    try {
        return await work(ports);
    } finally {
        await ports.dispose().catch(() => undefined);
    }
}

async function appContainer(context: MoveContext): Promise<string> {
    return (await currentReleaseRef(context.app)).name;
}

/** The app's container, stopped. Whether it was meant to be running is written
 *  down first, once, so a rollback can leave it the way it was found. */
async function stopApp(context: MoveContext): Promise<void> {
    let wasRunning = context.row.wasRunning;
    if (wasRunning === null) {
        wasRunning = context.app.desiredState === "running";
        await prisma.storageMove.update({ where: { id: context.row.id }, data: { wasRunning } });
    }
    // Recorded before the container is touched, like a stop from the app's page:
    // a reconcile must not start it again in the middle of the copy.
    await prisma.application.update({
        where: { id: context.app.id },
        data: { desiredState: "stopped", asleepSince: null }
    });
    const container = await appContainer(context);
    await withPorts(context, async (ports) => {
        await ports.container(container, "stop").catch(() => undefined);
        const status = parseContainerState(await ports.inspect(container).catch(() => null)).status;
        if (status === "running" || status === "restarting") throw new MoveFailure({ code: "stillRunning" });
    });
}

/** The real docker name of a named volume: what the app's container mounts at the
 *  volume's path, project prefix and all. */
async function dockerNameOf(context: MoveContext, ports: Awaited<ReturnType<typeof getPorts>>): Promise<string | undefined> {
    if (context.origin.kind !== "volume") return undefined;
    const inspect = await ports.inspect(await appContainer(context)).catch(() => null);
    const mounts = (inspect as { Mounts?: unknown } | null)?.Mounts;
    if (Array.isArray(mounts)) {
        for (const mount of mounts) {
            const entry = mount as { Type?: unknown; Name?: unknown; Destination?: unknown };
            if (entry.Type === "volume" && entry.Destination === context.mountPath && typeof entry.Name === "string")
                return entry.Name;
        }
    }
    throw new MoveFailure({ code: "unreadable" });
}

/** Mount the shares either end lives on, on the service's machine. */
async function mountShares(context: MoveContext, ports: Awaited<ReturnType<typeof getPorts>>): Promise<void> {
    for (const placement of [context.origin, context.destination]) {
        if (placement.kind !== "nas") continue;
        const spec = await resolveMountTarget(placement.connectionId, context.row.ownerId).catch(() => null);
        if (!spec) throw new MoveFailure({ code: "mount" });
        await ports.ensureMount(spec).catch((caught: unknown) => {
            throw new MoveFailure({ code: "mount", detail: caught instanceof Error ? caught.message.slice(0, 200) : undefined });
        });
    }
}

async function logsOf(ports: Awaited<ReturnType<typeof getPorts>>, container: string): Promise<string> {
    const parts: Buffer[] = [];
    await ports.logs(container, (chunk) => void parts.push(Buffer.from(chunk)), { tail: 40 }).catch(() => undefined);
    return Buffer.concat(parts).toString("utf8");
}

/** Run a one-off container to the end. Resumes one already running - a worker that
 *  died mid-copy left it going - instead of starting it over. */
async function runOneShot(
    context: MoveContext,
    ports: Awaited<ReturnType<typeof getPorts>>,
    spec: ReturnType<typeof plan.copySpec>,
    onTick?: (name: string) => Promise<void>
): Promise<{ exitCode: number; log: string }> {
    const name = spec.services[0]!.name;
    let status = parseContainerState(await ports.inspect(name).catch(() => null)).status;
    if (status !== "running" && status !== "exited") {
        await ports.composeDown(spec.project).catch(() => undefined);
        await ports.composeUp(spec);
    }
    let missing = 0;
    for (;;) {
        const state = parseContainerState(await ports.inspect(name).catch(() => null));
        status = state.status;
        if (status === "exited" || status === "dead") {
            const log = await logsOf(ports, name);
            await ports.composeDown(spec.project).catch(() => undefined);
            return { exitCode: state.exitCode ?? -1, log };
        }
        if (status === "unknown") {
            missing += 1;
            if (missing >= LOST_AFTER) throw new MoveFailure({ code: "copy" });
        } else {
            missing = 0;
            if (onTick) await onTick(name);
        }
        await renewLease(context.row.id);
        await sleep(POLL_MS);
    }
}

async function copy(context: MoveContext): Promise<void> {
    await withPorts(context, async (ports) => {
        await mountShares(context, ports);
        const dockerName = await dockerNameOf(context, ports);
        // Kept with the move: once the app is on the copy, nothing else knows
        // what the original volume was called, and emptying it needs the name.
        if (dockerName)
            await prisma.storageMove.update({
                where: { id: context.row.id },
                data: { origin: JSON.stringify({ ...context.origin, dockerName }) }
            });
        const spec = plan.copySpec(context.row.id, context.origin, context.destination, dockerName);
        const { exitCode, log } = await runOneShot(context, ports, spec, async (name) => {
            const report = plan.parseCopyLog(await logsOf(ports, name));
            const copied = await ports.diskUsage(name, "/to");
            await prisma.storageMove.update({
                where: { id: context.row.id },
                data: {
                    ...(report.sourceBytes !== undefined ? { totalBytes: BigInt(report.sourceBytes) } : {}),
                    ...(report.sourceFiles !== undefined ? { fileCount: report.sourceFiles } : {}),
                    ...(copied !== null ? { copiedBytes: BigInt(copied) } : {})
                }
            });
        });
        const report = plan.parseCopyLog(log);
        await prisma.storageMove.update({
            where: { id: context.row.id },
            data: {
                ...(report.sourceBytes !== undefined ? { totalBytes: BigInt(report.sourceBytes) } : {}),
                ...(report.sourceFiles !== undefined ? { fileCount: report.sourceFiles } : {}),
                ...(report.copiedBytes !== undefined ? { copiedBytes: BigInt(report.copiedBytes) } : {})
            }
        });
        const outcome = plan.copyOutcome(exitCode, report);
        if (!outcome.ok) {
            const said = log
                .split("\n")
                .filter((line) => line.trim() && !line.startsWith("POLARIS_"))
                .slice(-3)
                .join(" ")
                .slice(0, 300);
            throw new MoveFailure({
                code: outcome.failure,
                ...(said ? { detail: said } : {}),
                ...(outcome.failure === "noSpace"
                    ? { freeBytes: report.freeBytes, neededBytes: report.sourceBytes }
                    : {})
            });
        }
    });
}

async function switchVolume(context: MoveContext): Promise<void> {
    // Nothing may have started the app since the copy: anything it wrote would
    // be on the original and missing from the copy.
    const container = await appContainer(context);
    await withPorts(context, async (ports) => {
        const status = parseContainerState(await ports.inspect(container).catch(() => null)).status;
        if (status === "running" || status === "restarting") throw new MoveFailure({ code: "stillRunning" });
    });
    await setPlacement(context.row.volumeId, context.destination);
    await prisma.storageMove.update({ where: { id: context.row.id }, data: { switched: true } });
}

async function setPlacement(volumeId: string, placement: plan.Placement): Promise<void> {
    await prisma.volume.update({
        where: { id: volumeId },
        data: { kind: placement.kind, source: placement.source, connectionId: placement.connectionId }
    });
}

/**
 * Start the app again and wait for its deploy to settle. Starting recreates the
 * container from the current volume rows, which is what makes it mount the copy.
 */
async function startApp(context: MoveContext, rollingBack: boolean): Promise<void> {
    if (!context.row.wasRunning) return;
    const deploymentId = await restartFromKeptImage(context.app.id, context.row.ownerId, context.row.actorId, "settings");
    await prisma.application.update({ where: { id: context.app.id }, data: { desiredState: "running" } });
    const deadline = Date.now() + START_LIMIT_MS;
    for (;;) {
        const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } });
        if (deployment?.status === "running") return;
        if (!deployment || deployment.status === "failed" || deployment.status === "cancelled" || Date.now() > deadline)
            throw rollingBack ? new Error("The app did not start again") : new MoveFailure({ code: "startFailed" });
        await renewLease(context.row.id);
        await sleep(POLL_MS);
    }
}

async function rollBack(context: MoveContext): Promise<void> {
    for (const action of plan.rollbackSteps({ switched: context.row.switched, wasRunning: context.row.wasRunning })) {
        if (action === "remove-copier") {
            const spec = plan.copySpec(context.row.id, context.origin, context.destination, "unused");
            await withPorts(context, (ports) => ports.composeDown(spec.project)).catch(() => undefined);
        }
        if (action === "clear-copy") {
            // Best effort: what is left is a folder of this move's own, and failing
            // to empty it must not stop the app from being started again.
            const spec = plan.cleanupSpec(`${context.row.id}-copy`, context.destination);
            await withPorts(context, async (ports) => {
                if (context.destination.kind === "nas") {
                    const mount = await resolveMountTarget(context.destination.connectionId, context.row.ownerId);
                    if (!mount) return;
                    await ports.ensureMount(mount);
                }
                await runOneShot(context, ports, spec);
            }).catch((caught: unknown) => console.error(`polaris: storage move ${context.row.id} left its copy:`, caught));
        }
        if (action === "restore-volume") {
            await setPlacement(context.row.volumeId, context.origin);
            await prisma.storageMove.update({ where: { id: context.row.id }, data: { switched: false } });
        }
        if (action === "start-app") await startApp(context, true);
    }
}

async function cleanOrigin(context: MoveContext): Promise<void> {
    await withPorts(context, async (ports) => {
        if (context.origin.kind === "nas") {
            const spec = await resolveMountTarget(context.origin.connectionId, context.row.ownerId).catch(() => null);
            if (!spec) throw new MoveFailure({ code: "cleanFailed" });
            await ports.ensureMount(spec);
        }
        // A named volume is mounted by the name it had; the app no longer holds it,
        // so its name is the one recorded when the copy found it.
        const dockerName = recordedDockerName(context.row.origin);
        if (context.origin.kind === "volume" && !dockerName) throw new MoveFailure({ code: "cleanFailed" });
        const spec = plan.cleanupSpec(context.row.id, context.origin, dockerName);
        const { exitCode, log } = await runOneShot(context, ports, spec);
        if (exitCode !== 0) throw new MoveFailure({ code: "cleanFailed", detail: log.trim().slice(-300) || undefined });
    });
}

function recordedDockerName(originJson: string): string | undefined {
    try {
        const value = (JSON.parse(originJson) as { dockerName?: unknown }).dockerName;
        return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}
