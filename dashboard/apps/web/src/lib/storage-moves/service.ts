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
import { storageHeld } from "./hold";
import { parseContainerState } from "@polaris/deploy";
import { currentReleaseRef, serviceRef } from "@/lib/deploy/releases";
import { restartFromKeptImage } from "@/lib/deploy-service";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { getDriver, getDriverForConnection, resolveMountTarget } from "@/lib/storage-service";
import { lastDiskReadings, readDisk, type DiskReading } from "@/lib/deploy/disk-watch";
import {
    gameForCatalogId,
    HOST_MOUNTABLE_KINDS,
    withTimeout,
    type StorageConfig
} from "@polaris/core";

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
        | "cleanFailed"
        | "originShared";
    readonly detail?: string;
    /** The file a failed copy is about, relative to the volume: the one that did
     *  not match, or a link the destination could not store. */
    readonly file?: string;
    readonly freeBytes?: number;
    readonly neededBytes?: number;
    /** The rollback could not start the app again. */
    readonly notRestarted?: boolean;
    /** The rollback could not point the volume back at the original. */
    readonly notRestored?: boolean;
}

class MoveFailure extends Error {
    public constructor(public readonly reason: MoveError) {
        super(reason.code);
    }
}

/** Another worker took the move over; this one stops without writing anything. */
class LeaseLost extends Error {}

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
        if (config.kind === "unifi-unas")
            return config.smbShare ? `//${config.host}/${config.smbShare}` : config.host;
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
            where: {
                id: {
                    in: [
                        ...new Set(
                            rows.map((row) => row.ownerId).filter((id): id is string => Boolean(id))
                        )
                    ]
                }
            },
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
    | {
          readonly ok: true;
          readonly total: number | null;
          readonly used: number | null;
          readonly free: number | null;
      }
    | {
          readonly ok: false;
          readonly reason: "missing" | "unreachable" | "denied" | "notMounted";
          readonly detail?: string;
      };

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
            ? await withTimeout(driver.usage(), SPACE_TIMEOUT_MS, "timed out").catch(
                  () => ({}) as Record<string, never>
              )
            : {};
        const number = (value: bigint | undefined) => (value === undefined ? null : Number(value));
        const total = number((usage as { total?: bigint }).total);
        const free = number((usage as { free?: bigint }).free);
        const used =
            number((usage as { used?: bigint }).used) ??
            (total !== null && free !== null ? total - free : null);
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
    /** The app's storage mode (`placement.ts`), null when nobody chose one. */
    readonly mode: string | null;
    /** Whether the app has this one volume only, so `park` can be offered. */
    readonly single: boolean;
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
                    storageMode: true,
                    target: { select: { kind: true, hostId: true, runtime: true } },
                    environment: {
                        select: { project: { select: { id: true, name: true, ownerId: true } } }
                    }
                }
            }
        },
        orderBy: { createdAt: "asc" },
        take: 1000
    });
    const appIds = [...new Set(volumes.map((volume) => volume.application!.id))];
    const perApp = new Map<string, number>();
    for (const volume of volumes)
        perApp.set(volume.application!.id, (perApp.get(volume.application!.id) ?? 0) + 1);
    const ownerIds = [
        ...new Set(volumes.map((volume) => volume.application!.environment.project.ownerId))
    ];
    const hostIds = [
        ...new Set(
            volumes
                .map((volume) => volume.application!.target.hostId)
                .filter((id): id is string => Boolean(id))
        )
    ];
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
    const serverName = (machine: string): string | null =>
        machine === "local" ? null : (hostName.get(machine) ?? null);
    const games = new Set(
        installs
            .filter((install) => gameForCatalogId(install.catalogId))
            .map((install) => install.applicationId)
    );
    const moving = new Set(busy.map((move) => move.applicationId));
    const connectionName = new Map(
        connections.map((connection) => [connection.id, connection.name])
    );

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
                here.kind === "server"
                    ? server
                    : (connectionName.get(here.connectionId) ?? here.connectionId),
            destinations,
            busy: moving.has(app.id),
            mode: app.storageMode,
            single: perApp.get(app.id) === 1
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
    /** Another volume still uses the original, so it may only be kept. */
    readonly originShared: boolean;
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
    const shared = new Set(
        (
            await Promise.all(
                rows
                    .filter((row) => row.state === "moved")
                    .map(async (row) =>
                        (await originShared(row, plan.parsePlacement(row.origin))) ? row.id : null
                    )
            )
        ).filter((id): id is string => id !== null)
    );
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
            originShared: shared.has(row.id),
            createdAt: row.createdAt.toISOString(),
            finishedAt: row.finishedAt?.toISOString() ?? null
        };
    });
}

/** A move still under way, or waiting for somebody to say what happens to the
 *  original, as the servers screen and the disk warning show it. */
export interface ActiveMoveView {
    readonly id: string;
    readonly phase: plan.MovePhase;
    readonly volumeName: string;
    readonly appName: string;
    readonly targetLabel: string;
    readonly totalBytes: number | null;
    readonly copiedBytes: number | null;
    readonly percent: number | null;
    /** The machine whose disk the original is on, or null for one on a NAS. */
    readonly machine: string | null;
    /** The containers a move runs, as the volumes list names their holders. */
    readonly containers: readonly string[];
    /** The docker name of the original, once the copy found it. */
    readonly dockerName: string | null;
    /** Polaris started it, and empties the original itself once the app runs on
     *  the copy; otherwise the original waits for a person. */
    readonly auto: boolean;
}

/**
 * Every move that is not over, newest first. A move that reached `moved` is here
 * too: its original still holds every byte until somebody answers, so the disk
 * it is on gets nothing back until then.
 */
export async function activeMoves(): Promise<ActiveMoveView[]> {
    const rows = await prisma.storageMove.findMany({
        where: { state: { in: [...plan.BLOCKING_STATES] } },
        select: {
            id: true,
            state: true,
            volumeId: true,
            applicationId: true,
            origin: true,
            targetLabel: true,
            auto: true,
            totalBytes: true,
            copiedBytes: true
        },
        orderBy: { createdAt: "desc" },
        take: 20
    });
    if (rows.length === 0) return [];
    const [apps, volumes] = await Promise.all([
        prisma.application.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.applicationId))] } },
            select: { id: true, name: true, target: { select: { kind: true, hostId: true } } }
        }),
        prisma.volume.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.volumeId))] } },
            select: { id: true, name: true }
        })
    ]);
    const appOf = new Map(apps.map((app) => [app.id, app]));
    const volumeName = new Map(volumes.map((volume) => [volume.id, volume.name]));
    return rows.flatMap((row) => {
        const state = plan.isMoveState(row.state) ? row.state : null;
        const total = row.totalBytes === null ? null : Number(row.totalBytes);
        const copied = row.copiedBytes === null ? null : Number(row.copiedBytes);
        const phase = state ? plan.movePhase(state, total, copied) : null;
        if (!phase) return [];
        let origin: plan.Placement | null = null;
        try {
            origin = plan.parsePlacement(row.origin);
        } catch {
            origin = null;
        }
        const app = appOf.get(row.applicationId);
        const copier = plan.copierName(row.id);
        return [
            {
                id: row.id,
                phase,
                volumeName: volumeName.get(row.volumeId) ?? "",
                appName: app?.name ?? "",
                targetLabel: row.targetLabel,
                totalBytes: total,
                copiedBytes: copied,
                percent: phase === "copying" ? plan.progressPercent(copied, total) : null,
                machine:
                    origin && origin.kind !== "nas" && app?.target ? machineOf(app.target) : null,
                containers: [copier, `${copier}-clean`],
                dockerName: recordedDockerName(row.origin) ?? null,
                auto: row.auto
            }
        ];
    });
}

/** The app a volume belongs to, or null. */
export async function volumeApplication(volumeId: string): Promise<string | null> {
    const row = await prisma.volume.findUnique({
        where: { id: volumeId },
        select: { applicationId: true }
    });
    return row?.applicationId ?? null;
}

export type StartRefusal =
    | "missing"
    | "notDeployed"
    | "busy"
    | "sameLocation"
    | "notOffered"
    | "swarm";

/**
 * Queue a move of one volume to `destination` (`server` or a connection id) and
 * hand it to a worker. Refused with a reason the screen words.
 */
export async function startMove(input: {
    volumeId: string;
    destination: string;
    actorId: string | null;
    /** What the screen calls the machine Polaris runs on. */
    serverLabel: string;
    /** Polaris following the app's storage mode, not a person: the original is
     *  emptied without asking once the app is on the checked copy. */
    auto?: boolean;
    /** Start the app on the copy whatever state it was found in - a stopped app
     *  somebody just started, whose data had to come home first. */
    startAfter?: boolean;
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
    if (storageHeld(app.id)) return { refused: "busy" };
    const origin = plan.placementOf(volume);
    if (!origin) return { refused: "missing" };
    const ownerId = app.environment.project.ownerId;
    const machine = machineOf(app.target);
    const server =
        machine === "local"
            ? input.serverLabel
            : ((await prisma.host.findUnique({ where: { id: machine }, select: { name: true } }))
                  ?.name ?? input.serverLabel);

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
        // Two starts for one app wait for each other here, so the second sees the
        // first one's move.
        await tx.$queryRaw`SELECT "id" FROM "Application" WHERE "id" = ${app.id}::uuid FOR UPDATE`;
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
                targetLabel,
                auto: input.auto ?? false,
                ...(input.startAfter ? { wasRunning: true } : {})
            },
            select: { id: true }
        });
    });
    if (!created) return { refused: "busy" };
    void runMove(created.id).catch((caught: unknown) =>
        console.error("polaris: storage move failed to run:", caught)
    );
    return { id: created.id };
}

/** The move a sharing question is asked for: whose volume, and where it was. */
interface MoveScope {
    readonly volumeId: string;
    readonly applicationId: string;
    /** The move's stored origin, which carries the docker name the copy found. */
    readonly origin: string;
}

/**
 * Whether another volume still reaches the files at `placement`: the same named
 * volume, or a folder that is, holds or sits inside it. Emptying the original
 * would take those files from it.
 * Named volumes are scoped to their app (`plan.volumesReaching`).
 */
async function originShared(move: MoveScope, placement: plan.Placement): Promise<boolean> {
    const candidates = await prisma.volume.findMany({
        where: {
            id: { not: move.volumeId },
            ...plan.volumesReaching(placement, {
                applicationId: move.applicationId,
                dockerName: recordedDockerName(move.origin)
            })
        },
        select: { kind: true, source: true, name: true, connectionId: true },
        take: 50
    });
    // A named volume's filter is already exact - the same app's name, or the
    // docker name itself, which the stored source never spells the same way.
    if (placement.kind === "volume") return candidates.length > 0;
    return candidates.some((row) => {
        const found = plan.placementOf(row);
        return found !== null && plan.placementsOverlap(placement, found);
    });
}

/** The person's answer to a finished move: empty the original, or keep it. */
export async function answerMove(
    id: string,
    answer: "remove" | "keep"
): Promise<"ok" | "gone" | "shared"> {
    if (answer === "remove") {
        const row = await prisma.storageMove.findFirst({
            where: { id, state: "moved" },
            select: { volumeId: true, applicationId: true, origin: true }
        });
        if (!row) return "gone";
        if (await originShared(row, plan.parsePlacement(row.origin))) return "shared";
    }
    const next = plan.nextState("moved", answer);
    const updated = await prisma.storageMove.updateMany({
        where: { id, state: "moved" },
        data:
            answer === "keep"
                ? { state: next, originRemoved: false, finishedAt: new Date() }
                : { state: next, error: null }
    });
    if (updated.count === 0) return "gone";
    if (answer === "remove")
        void runMove(id).catch((caught: unknown) =>
            console.error("polaris: storage clean-up failed to run:", caught)
        );
    return "ok";
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
        void runMove(row.id).catch((caught: unknown) =>
            console.error("polaris: storage move failed to run:", caught)
        );
    return { resumed: rows.length };
}

/** Take a free or lapsed lease, answering the token that holds it. */
async function takeLease(id: string): Promise<string | null> {
    const now = new Date();
    const token = crypto.randomUUID();
    const taken = await prisma.storageMove.updateMany({
        where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseToken: token }
    });
    return taken.count === 1 ? token : null;
}

/** Extend this worker's lease; throws when another worker has taken it over. */
async function renewLease(id: string, token: string): Promise<void> {
    const renewed = await prisma.storageMove.updateMany({
        where: { id, leaseToken: token },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) }
    });
    if (renewed.count === 0) throw new LeaseLost();
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
    /** The token of the lease this worker holds. */
    readonly lease: string;
}

async function contextOf(row: MoveRow, lease: string): Promise<MoveContext> {
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
        mountPath: volume.mountPath,
        lease
    };
}

/**
 * Work one move as far as it can go. Takes the lease or leaves it to whoever has
 * it; every step is safe to repeat, so a worker that died anywhere is replaced by
 * one that carries on.
 */
export async function runMove(id: string): Promise<void> {
    const lease = await takeLease(id);
    if (!lease) return;
    const held = { id, leaseToken: lease };
    try {
        for (;;) {
            const row = await prisma.storageMove.findFirst({ where: held });
            if (!row || !plan.isMoveState(row.state) || !plan.WORKING_STATES.includes(row.state))
                return;
            const state = row.state;
            try {
                await step(row, state, lease);
                let next = plan.nextState(state, "ok");
                // A move Polaris made by itself does not wait for anybody: the app is
                // on the checked copy, so the original is emptied - or kept, when
                // another volume still reaches the same files.
                let kept = false;
                if (next === "moved" && row.auto) {
                    kept = await originShared(row, plan.parsePlacement(row.origin));
                    next = plan.nextState("moved", kept ? "keep" : "remove");
                }
                const advanced = await prisma.storageMove.updateMany({
                    where: held,
                    data: {
                        state: next,
                        ...(kept ? { originRemoved: false, finishedAt: new Date() } : {}),
                        ...(state === "cleaning"
                            ? { originRemoved: true, finishedAt: new Date() }
                            : {}),
                        ...(state === "rolling-back" ? { finishedAt: new Date() } : {})
                    }
                });
                if (advanced.count === 0) return;
            } catch (caught) {
                if (caught instanceof LeaseLost) return;
                const reason: MoveError =
                    caught instanceof MoveFailure
                        ? caught.reason
                        : { code: state === "cleaning" ? "cleanFailed" : "unexpected" };
                if (!(caught instanceof MoveFailure))
                    console.error(`polaris: storage move ${id} failed at ${state}:`, caught);
                if (state === "rolling-back") {
                    // The rollback could not finish; what it could not do is said beside the
                    // first reason rather than replacing it. A volume still switched means
                    // putting it back failed; otherwise it was starting the app again.
                    const first = errorOf(row.error) ?? reason;
                    const after = await prisma.storageMove.findFirst({
                        where: held,
                        select: { switched: true }
                    });
                    if (!after) return;
                    await prisma.storageMove.updateMany({
                        where: held,
                        data: {
                            state: "failed",
                            finishedAt: new Date(),
                            error: JSON.stringify({
                                ...first,
                                ...(after.switched
                                    ? { notRestored: true }
                                    : row.wasRunning
                                      ? { notRestarted: true }
                                      : {})
                            })
                        }
                    });
                    return;
                }
                const failed = await prisma.storageMove.updateMany({
                    where: held,
                    data: { state: plan.nextState(state, "fail"), error: JSON.stringify(reason) }
                });
                if (failed.count === 0) return;
            }
            await renewLease(id, lease);
        }
    } catch (caught) {
        if (!(caught instanceof LeaseLost)) throw caught;
    } finally {
        await prisma.storageMove
            .updateMany({ where: held, data: { leaseUntil: null, leaseToken: null } })
            .catch(() => undefined);
    }
}

async function step(row: MoveRow, state: plan.MoveState, lease: string): Promise<void> {
    if (state === "queued") return;
    const context = await contextOf(row, lease);
    if (state === "stopping") return stopApp(context);
    if (state === "copying") return copy(context);
    if (state === "switching") return switchVolume(context);
    if (state === "starting") return startApp(context, false);
    if (state === "cleaning") return cleanOrigin(context);
    if (state === "rolling-back") return rollBack(context);
}

async function withPorts<T>(
    context: MoveContext,
    work: (ports: Awaited<ReturnType<typeof getPorts>>) => Promise<T>
): Promise<T> {
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
        if (status === "running" || status === "restarting")
            throw new MoveFailure({ code: "stillRunning" });
    });
}

/** The real docker name of a named volume: what the app's container mounts at the
 *  volume's path, project prefix and all. */
async function dockerNameOf(
    context: MoveContext,
    ports: Awaited<ReturnType<typeof getPorts>>
): Promise<string | undefined> {
    if (context.origin.kind !== "volume") return undefined;
    const inspect = await ports.inspect(await appContainer(context)).catch(() => null);
    // A stopped app whose container was removed still has its volume: the one its
    // project created, named after it. Should that guess be wrong the copy cannot
    // start - the copier declares the volume external - so nothing is copied from
    // a volume that is not the app's.
    if (inspect === null)
        return plan.projectVolumeName(
            serviceRef(context.app.environment.project.slug, context.app.slug, context.app.id)
                .project,
            context.origin.source
        );
    const mounts = (inspect as { Mounts?: unknown } | null)?.Mounts;
    if (Array.isArray(mounts)) {
        for (const mount of mounts) {
            const entry = mount as { Type?: unknown; Name?: unknown; Destination?: unknown };
            if (
                entry.Type === "volume" &&
                entry.Destination === context.mountPath &&
                typeof entry.Name === "string"
            )
                return entry.Name;
        }
    }
    throw new MoveFailure({ code: "unreadable" });
}

/** Mount the shares either end lives on, on the service's machine. */
async function mountShares(
    context: MoveContext,
    ports: Awaited<ReturnType<typeof getPorts>>
): Promise<void> {
    for (const placement of [context.origin, context.destination]) {
        if (placement.kind !== "nas") continue;
        const spec = await resolveMountTarget(placement.connectionId, context.row.ownerId).catch(
            () => null
        );
        if (!spec) throw new MoveFailure({ code: "mount" });
        await ports.ensureMount(spec).catch((caught: unknown) => {
            throw new MoveFailure({
                code: "mount",
                detail: caught instanceof Error ? caught.message.slice(0, 200) : undefined
            });
        });
    }
}

async function logsOf(
    ports: Awaited<ReturnType<typeof getPorts>>,
    container: string
): Promise<string> {
    const parts: Buffer[] = [];
    await ports
        .logs(container, (chunk) => void parts.push(Buffer.from(chunk)), { tail: 40 })
        .catch(() => undefined);
    return Buffer.concat(parts).toString("utf8");
}

/** Run a one-off container to the end. Resumes one already running - a worker that
 *  died mid-copy left it going - instead of starting it over. */
async function runOneShot(
    context: { readonly row: { readonly id: string }; readonly lease: string },
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
        await renewLease(context.row.id, context.lease);
        await sleep(POLL_MS);
    }
}

/**
 * Empty the copies earlier failed moves of this volume left behind. Each sits in
 * a folder of its own move that the volume never pointed at (`switched` stayed
 * false), so nothing reads it; a rollback that could not empty one (an SMB share
 * skips files while a folder is deleted under it) left it holding NAS space, and
 * trying again is the moment to finish that. Best effort: it never fails a move.
 */
async function clearEarlierCopies(
    context: MoveContext,
    ports: Awaited<ReturnType<typeof getPorts>>
): Promise<void> {
    const earlier = await prisma.storageMove.findMany({
        where: {
            volumeId: context.row.volumeId,
            id: { not: context.row.id },
            state: "failed",
            switched: false,
            copySettledAt: null
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, destination: true },
        take: 5
    });
    for (const move of earlier) {
        try {
            const left = plan.parsePlacement(move.destination);
            if (left.kind === "volume") continue;
            if (plan.placementsOverlap(left, context.origin)) continue;
            if (plan.placementsOverlap(left, context.destination)) continue;
            if (await originShared(context.row, left)) continue;
            await emptyCopy(context, ports, move.id, left, context.row.ownerId);
        } catch (caught) {
            console.error(`polaris: storage move ${move.id} still holds its copy:`, caught);
        }
    }
}

/**
 * Empty the folder a move copied into, and record that it is gone. Throws when
 * the share cannot be mounted or the folder could not be emptied, so the move
 * stays on the list of copies to try again.
 */
async function emptyCopy(
    held: { readonly row: { readonly id: string }; readonly lease: string },
    ports: Awaited<ReturnType<typeof getPorts>>,
    moveId: string,
    copy: plan.Placement,
    ownerId: string
): Promise<void> {
    if (copy.kind === "nas") {
        const mount = await resolveMountTarget(copy.connectionId, ownerId);
        if (!mount) throw new Error("the share is no longer set up");
        await ports.ensureMount(mount);
    }
    const spec = plan.cleanupSpec(`${moveId}-copy`, copy);
    const { exitCode, log } = await runOneShot(held, ports, spec);
    if (exitCode !== 0) throw new Error(log.trim().slice(-300) || `exit ${exitCode}`);
    await prisma.storageMove.update({ where: { id: moveId }, data: { copySettledAt: new Date() } });
}

/**
 * Empty what failed moves left behind when nobody moves the same volume again,
 * the only other time it is tried. A rollback that could not empty its copy (an
 * SMB share skips files while a folder is deleted under it, or the share was
 * away) would otherwise hold that space on the NAS for good, and it can be the
 * size of the whole volume. Each move is worked under its own lease, so this
 * never races the move itself or a second runner.
 */
export async function sweepLeftCopies(now: Date = new Date()): Promise<{ cleared: number }> {
    const rows = await prisma.storageMove.findMany({
        where: {
            state: "failed",
            switched: false,
            copySettledAt: null,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
        },
        orderBy: { updatedAt: "asc" },
        select: LEFT_COPY_FIELDS,
        take: 5
    });
    let cleared = 0;
    for (const row of rows) {
        const lease = await takeLease(row.id);
        if (!lease) continue;
        try {
            if (await clearLeftCopy(row, lease, now)) cleared += 1;
        } catch (caught) {
            console.error(`polaris: storage move ${row.id} still holds its copy:`, caught);
        } finally {
            await prisma.storageMove
                .updateMany({
                    where: { id: row.id, leaseToken: lease },
                    data: { leaseUntil: null, leaseToken: null }
                })
                .catch(() => undefined);
        }
    }
    return { cleared };
}

const LEFT_COPY_FIELDS = {
    id: true,
    volumeId: true,
    applicationId: true,
    ownerId: true,
    origin: true,
    destination: true,
    copyTriedAt: true
} as const;

/** This machine, for work that belongs to no app any more. */
const LOCAL_TARGET: TargetRow = {
    id: "local",
    kind: "local",
    hostId: null,
    runtime: "compose",
    proxyNetwork: ""
};

/** One failed move's copy: emptied, left, or given up on. True when emptied. */
async function clearLeftCopy(
    row: {
        id: string;
        volumeId: string;
        applicationId: string;
        ownerId: string;
        origin: string;
        destination: string;
        copyTriedAt: Date | null;
    },
    lease: string,
    now: Date
): Promise<boolean> {
    const settle = () =>
        prisma.storageMove.update({ where: { id: row.id }, data: { copySettledAt: now } });
    // A volume being moved right now may be copying into the same folder again.
    const busy = await prisma.storageMove.findFirst({
        where: { volumeId: row.volumeId, state: { in: [...plan.BLOCKING_STATES] } },
        select: { id: true }
    });
    if (busy) return false;
    const [volume, app] = await Promise.all([
        prisma.volume.findUnique({
            where: { id: row.volumeId },
            select: { kind: true, source: true, name: true, connectionId: true }
        }),
        prisma.application.findUnique({
            where: { id: row.applicationId },
            select: { target: true }
        })
    ]);
    const copy = plan.parsePlacement(row.destination);
    const action = plan.leftCopyAction({
        copy,
        origin: plan.parsePlacement(row.origin),
        current: volume ? plan.placementOf(volume) : null,
        firstTriedAt: row.copyTriedAt,
        now
    });
    if (action === "keep" || (await originShared(row, copy))) {
        await settle();
        return false;
    }
    // A folder on a server is only reachable through the app's machine, and once
    // the app is gone nothing says which machine that was. A share can be mounted
    // from this one.
    const target = app?.target
        ? (app.target as TargetRow)
        : copy.kind === "nas"
          ? LOCAL_TARGET
          : null;
    if (action === "give-up" || !target) {
        console.error(`polaris: storage move ${row.id} left a copy that cannot be emptied`);
        await settle();
        return false;
    }
    if (!row.copyTriedAt) {
        await prisma.storageMove.update({ where: { id: row.id }, data: { copyTriedAt: now } });
    }
    const ports = await getPorts(target, row.ownerId);
    try {
        await emptyCopy({ row, lease }, ports, row.id, copy, row.ownerId);
    } finally {
        await ports.dispose().catch(() => undefined);
    }
    return true;
}

/**
 * Forget moves that are long over. Nothing reads them past the Storage history,
 * which shows the latest few, and the latest move of each app, which its storage
 * card shows; without this every move ever made, including those of apps since
 * deleted, stays a row for good.
 */
export async function pruneMoveHistory(now: Date = new Date()): Promise<{ forgotten: number }> {
    const rows = await prisma.storageMove.findMany({
        where: {
            state: { in: ["finished", "failed"] },
            finishedAt: { lt: new Date(now.getTime() - plan.MOVE_HISTORY_MS) }
        },
        orderBy: { finishedAt: "asc" },
        select: {
            id: true,
            applicationId: true,
            state: true,
            finishedAt: true,
            switched: true,
            copySettledAt: true
        },
        take: 500
    });
    if (rows.length === 0) return { forgotten: 0 };
    const appIds = [...new Set(rows.map((row) => row.applicationId))];
    const [apps, latest] = await Promise.all([
        prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true } }),
        prisma.storageMove.findMany({
            where: { applicationId: { in: appIds } },
            orderBy: { createdAt: "desc" },
            distinct: ["applicationId"],
            select: { id: true }
        })
    ]);
    const live = new Set(apps.map((app) => app.id));
    const newest = new Set(latest.map((move) => move.id));
    const ids = rows
        .filter((row) =>
            plan.moveForgettable({
                state: row.state,
                finishedAt: row.finishedAt,
                copySettled: row.copySettledAt !== null,
                switched: row.switched,
                latestOfLiveApp: live.has(row.applicationId) && newest.has(row.id),
                now
            })
        )
        .map((row) => row.id);
    if (ids.length === 0) return { forgotten: 0 };
    const { count } = await prisma.storageMove.deleteMany({
        where: { id: { in: ids }, state: { in: ["finished", "failed"] } }
    });
    return { forgotten: count };
}

async function copy(context: MoveContext): Promise<void> {
    await withPorts(context, async (ports) => {
        await mountShares(context, ports);
        await clearEarlierCopies(context, ports);
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
            // Once the copy printed its own figures there is nothing left to measure.
            const copied = plan.copiedSoFar(
                report.copiedBytes === undefined ? await ports.diskUsage(name, "/to") : null,
                report
            );
            await prisma.storageMove.update({
                where: { id: context.row.id },
                data: {
                    ...(report.sourceBytes !== undefined
                        ? { totalBytes: BigInt(report.sourceBytes) }
                        : {}),
                    ...(report.sourceFiles !== undefined ? { fileCount: report.sourceFiles } : {}),
                    ...(copied !== null ? { copiedBytes: BigInt(copied) } : {})
                }
            });
        });
        const report = plan.parseCopyLog(log);
        await prisma.storageMove.update({
            where: { id: context.row.id },
            data: {
                ...(report.sourceBytes !== undefined
                    ? { totalBytes: BigInt(report.sourceBytes) }
                    : {}),
                ...(report.sourceFiles !== undefined ? { fileCount: report.sourceFiles } : {}),
                ...(report.copiedBytes !== undefined
                    ? { copiedBytes: BigInt(report.copiedBytes) }
                    : {})
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
            const file = outcome.failure === "noLinks" ? report.noLinks : report.differ;
            throw new MoveFailure({
                code: outcome.failure,
                ...(said ? { detail: said } : {}),
                ...(file ? { file } : {}),
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
        if (status === "running" || status === "restarting")
            throw new MoveFailure({ code: "stillRunning" });
    });
    await setPlacement(context, context.destination, true);
}

/** Point the volume at `placement` and record whether that is the copy, together:
 *  a rollback decides from `switched` whether the copy may be emptied. */
async function setPlacement(
    context: MoveContext,
    placement: plan.Placement,
    switched: boolean
): Promise<void> {
    await prisma.$transaction([
        prisma.volume.update({
            where: { id: context.row.volumeId },
            data: {
                kind: placement.kind,
                source: placement.source,
                connectionId: placement.connectionId
            }
        }),
        prisma.storageMove.update({ where: { id: context.row.id }, data: { switched } })
    ]);
}

/**
 * Start the app again and wait for its deploy to settle. Starting recreates the
 * container from the current volume rows, which is what makes it mount the copy.
 */
async function startApp(context: MoveContext, rollingBack: boolean): Promise<void> {
    if (!context.row.wasRunning) return;
    const deploymentId = await restartFromKeptImage(
        context.app.id,
        context.row.ownerId,
        context.row.actorId,
        "settings"
    );
    await prisma.application.update({
        where: { id: context.app.id },
        data: { desiredState: "running" }
    });
    const deadline = Date.now() + START_LIMIT_MS;
    for (;;) {
        const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { status: true }
        });
        if (deployment?.status === "running") return;
        if (
            !deployment ||
            deployment.status === "failed" ||
            deployment.status === "cancelled" ||
            Date.now() > deadline
        )
            throw rollingBack
                ? new Error("The app did not start again")
                : new MoveFailure({ code: "startFailed" });
        await renewLease(context.row.id, context.lease);
        await sleep(POLL_MS);
    }
}

async function rollBack(context: MoveContext): Promise<void> {
    for (const action of plan.rollbackSteps({
        switched: context.row.switched,
        wasRunning: context.row.wasRunning
    })) {
        if (action === "remove-copier") {
            const spec = plan.copySpec(
                context.row.id,
                context.origin,
                context.destination,
                "unused"
            );
            await withPorts(context, (ports) => ports.composeDown(spec.project)).catch(
                () => undefined
            );
        }
        if (action === "clear-copy") {
            // Best effort: what is left is a folder of this move's own, and failing
            // to empty it must not stop the app from being started again.
            const spec = plan.cleanupSpec(`${context.row.id}-copy`, context.destination);
            await withPorts(context, async (ports) => {
                if (context.destination.kind === "nas") {
                    const mount = await resolveMountTarget(
                        context.destination.connectionId,
                        context.row.ownerId
                    );
                    if (!mount) return;
                    await ports.ensureMount(mount);
                }
                const { exitCode, log } = await runOneShot(context, ports, spec);
                if (exitCode !== 0) throw new Error(log.trim().slice(-300) || `exit ${exitCode}`);
                await prisma.storageMove.update({
                    where: { id: context.row.id },
                    data: { copySettledAt: new Date() }
                });
            }).catch((caught: unknown) =>
                console.error(`polaris: storage move ${context.row.id} left its copy:`, caught)
            );
        }
        if (action === "restore-volume") {
            await setPlacement(context, context.origin, false);
        }
        if (action === "start-app") await startApp(context, true);
    }
}

async function cleanOrigin(context: MoveContext): Promise<void> {
    await withPorts(context, async (ports) => {
        if (context.origin.kind === "nas") {
            const spec = await resolveMountTarget(
                context.origin.connectionId,
                context.row.ownerId
            ).catch(() => null);
            if (!spec) throw new MoveFailure({ code: "cleanFailed" });
            await ports.ensureMount(spec);
        }
        // A named volume is mounted by the name it had; the app no longer holds it,
        // so its name is the one recorded when the copy found it.
        const dockerName = recordedDockerName(context.row.origin);
        if (context.origin.kind === "volume" && !dockerName)
            throw new MoveFailure({ code: "cleanFailed" });
        if (await originShared(context.row, context.origin))
            throw new MoveFailure({ code: "originShared" });
        const spec = plan.cleanupSpec(context.row.id, context.origin, dockerName);
        const { exitCode, log } = await runOneShot(context, ports, spec);
        if (exitCode !== 0)
            throw new MoveFailure({
                code: "cleanFailed",
                detail: log.trim().slice(-300) || undefined
            });
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
