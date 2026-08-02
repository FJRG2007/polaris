/**
 * Deploy volume CRUD. A volume attaches a persistent path to a service so data
 * (e.g. a `secrets` folder of files) survives redeploys. Three kinds, all
 * confined by the daemon - never an arbitrary host path:
 *   - volume: a named docker volume.
 *   - bind:   a subpath under the host volume root (server-local).
 *   - nas:    a subpath under a storage connection's host mount, so the folder
 *             physically lives on the NAS/UNAS and can also be managed in Drive.
 * A volume lives on the same server as its application (targetId = app.targetId),
 * because a bind must resolve on the host where the container runs.
 */

import { prisma } from "@polaris/db";
import { slugify } from "@polaris/deploy";
import { getDriver } from "./storage-service";
import { currentReleaseRef } from "./deploy/releases";
import { getPorts, type TargetRow } from "./deploy/runtime";
import {
    canHostMount,
    withTimeout,
    deployVolumeInputSchema,
    deployVolumeUpdateSchema,
    normalizeVolumeSource,
    UnsafePathError,
    type DeployVolumeInput,
    type DeployVolumeUpdateInput,
    type StorageProviderKind
} from "@polaris/core";

export interface VolumeView {
    id: string;
    name: string;
    mountPath: string;
    kind: "volume" | "bind" | "nas";
    source: string;
    connectionId: string | null;
    connectionName: string | null;
    sizeLimit: string | null;
}

/** Create a nas volume's folder tree on its connection, so it exists and is
 *  browsable in Drive. mkdir builds parents and is idempotent; a failure (NAS
 *  unreachable) is swallowed - the caller must never depend on this succeeding. */
async function ensureNasFolder(connectionId: string, source: string, ownerId: string): Promise<void> {
    try {
        const driver = await getDriver(connectionId, ownerId);
        await driver.mkdir(source);
    } catch (error) {
        console.error(`volume: could not ensure NAS folder ${source} on ${connectionId}:`, error);
    }
}

/** List an application's volumes, ownership-checked. Also self-heals: makes sure
 *  every nas volume's folder exists on its connection (volumes created before the
 *  folder was auto-generated, or a folder the user removed), so Drive can browse it. */
export async function listVolumes(applicationId: string, ownerId: string): Promise<VolumeView[]> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
    const rows = await prisma.volume.findMany({
        where: { applicationId },
        orderBy: { createdAt: "asc" },
        include: { connection: { select: { name: true } } }
    });
    await Promise.all(
        rows
            .filter((row) => row.kind === "nas" && row.connectionId && row.source)
            .map((row) => ensureNasFolder(row.connectionId as string, row.source as string, ownerId))
    );
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        mountPath: row.mountPath,
        kind: row.kind === "bind" ? "bind" : row.kind === "nas" ? "nas" : "volume",
        source: row.source ?? row.name,
        connectionId: row.connectionId,
        connectionName: row.connection?.name ?? null,
        sizeLimit: row.sizeLimit
    }));
}

/** Create a volume for an application. Validates input, ownership, and (for nas)
 *  the backing storage connection, then persists a normalized, confined source. */
export async function createVolume(ownerId: string, input: DeployVolumeInput): Promise<VolumeView> {
    const result = deployVolumeInputSchema.safeParse(input);
    if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid volume");
    const parsed = result.data;

    const app = await prisma.application.findFirst({
        where: { id: parsed.applicationId, environment: { project: { ownerId } } },
        select: { id: true, targetId: true, slug: true, environment: { select: { project: { select: { slug: true } } } } }
    });
    if (!app) throw new Error("Application not found");

    // A nas volume must point at a hostd-mounted storage connection the owner
    // controls; that is the only way its bind source resolves onto the NAS.
    if (parsed.kind === "nas") {
        const connection = await prisma.storageConnection.findFirst({
            where: { id: parsed.connectionId, ownerId },
            select: { id: true, kind: true, status: true }
        });
        if (!connection) throw new Error("Storage connection not found");
        if (!canHostMount(connection.kind as StorageProviderKind))
            throw new Error("This storage connection cannot be host-mounted, so it cannot back a NAS volume");
        if (connection.status !== "active") throw new Error("The storage connection is not active");
    }

    // A named docker volume derives its source from the name. For bind/nas, use the
    // path the user typed or picked; when omitted, generate a structured one under
    // polaris/deploy/<project>/<app>/<name> so volumes stay organized on the NAS/host.
    const explicit = parsed.source?.trim();
    const raw =
        parsed.kind === "volume"
            ? parsed.name
            : explicit || `polaris/deploy/${app.environment.project.slug}/${app.slug}/${slugify(parsed.name)}`;
    let source: string;
    try {
        source = normalizeVolumeSource(parsed.kind, raw);
    } catch (error) {
        if (error instanceof UnsafePathError) throw new Error("The volume source path is invalid");
        throw error;
    }

    const duplicate = await prisma.volume.findFirst({
        where: { applicationId: parsed.applicationId, mountPath: parsed.mountPath },
        select: { id: true }
    });
    if (duplicate) throw new Error("A volume is already mounted at that path");

    const created = await prisma.volume.create({
        data: {
            targetId: app.targetId,
            applicationId: parsed.applicationId,
            name: parsed.name,
            mountPath: parsed.mountPath,
            kind: parsed.kind,
            source,
            connectionId: parsed.kind === "nas" ? parsed.connectionId : null,
            sizeLimit: parsed.sizeLimit ?? null
        },
        include: { connection: { select: { name: true } } }
    });

    // Create the folder on the NAS now (via the userspace driver, which works even
    // before the kernel mount is wired), so it exists and is browsable in Drive
    // right away - the same folder the container binds to at deploy.
    if (parsed.kind === "nas" && parsed.connectionId) {
        await ensureNasFolder(parsed.connectionId, source, ownerId);
    }

    return {
        id: created.id,
        name: created.name,
        mountPath: created.mountPath,
        kind: parsed.kind,
        source,
        connectionId: created.connectionId,
        connectionName: created.connection?.name ?? null,
        sizeLimit: created.sizeLimit
    };
}

/** Update an existing volume (paths, size cap, and for nas the backing connection).
 *  `kind` is fixed at create. Ownership-checked via the target. Re-normalizes the
 *  source and, for nas, ensures the (possibly new) folder exists on the connection. */
export async function updateVolume(ownerId: string, input: DeployVolumeUpdateInput): Promise<VolumeView> {
    const result = deployVolumeUpdateSchema.safeParse(input);
    if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid volume");
    const patch = result.data;

    const existing = await prisma.volume.findFirst({
        where: { id: patch.id, target: { ownerId } },
        select: { id: true, kind: true, applicationId: true, source: true, connectionId: true, mountPath: true }
    });
    if (!existing) throw new Error("Volume not found");
    const kind = existing.kind === "bind" ? "bind" : existing.kind === "nas" ? "nas" : "volume";

    // Resolve the backing connection (nas only), validating it can be host-mounted.
    const connectionId = kind === "nas" ? (patch.connectionId ?? existing.connectionId) : null;
    if (kind === "nas") {
        if (!connectionId) throw new Error("A storage connection is required for NAS volumes");
        const connection = await prisma.storageConnection.findFirst({
            where: { id: connectionId, ownerId },
            select: { kind: true, status: true }
        });
        if (!connection) throw new Error("Storage connection not found");
        if (!canHostMount(connection.kind as StorageProviderKind))
            throw new Error("This storage connection cannot be host-mounted, so it cannot back a NAS volume");
        if (connection.status !== "active") throw new Error("The storage connection is not active");
    }

    // Re-normalize the source when the path changed (named volumes track the name).
    let source = existing.source ?? "";
    if (patch.source !== undefined || (kind === "volume" && patch.name !== undefined)) {
        const raw = kind === "volume" ? (patch.name ?? existing.source ?? "") : (patch.source ?? existing.source ?? "");
        try {
            source = normalizeVolumeSource(kind, raw);
        } catch (error) {
            if (error instanceof UnsafePathError) throw new Error("The volume source path is invalid");
            throw error;
        }
    }

    // A moved mount path must not collide with another volume on the same service.
    if (patch.mountPath && patch.mountPath !== existing.mountPath) {
        const clash = await prisma.volume.findFirst({
            where: { applicationId: existing.applicationId, mountPath: patch.mountPath, id: { not: existing.id } },
            select: { id: true }
        });
        if (clash) throw new Error("A volume is already mounted at that path");
    }

    const updated = await prisma.volume.update({
        where: { id: existing.id },
        data: {
            name: patch.name ?? undefined,
            mountPath: patch.mountPath ?? undefined,
            source,
            connectionId,
            // "" clears the cap; a value sets it; undefined leaves it unchanged.
            sizeLimit: patch.sizeLimit === undefined ? undefined : patch.sizeLimit === "" ? null : patch.sizeLimit
        },
        include: { connection: { select: { name: true } } }
    });

    if (kind === "nas" && connectionId) await ensureNasFolder(connectionId, source, ownerId);

    return {
        id: updated.id,
        name: updated.name,
        mountPath: updated.mountPath,
        kind,
        source,
        connectionId: updated.connectionId,
        connectionName: updated.connection?.name ?? null,
        sizeLimit: updated.sizeLimit
    };
}

/**
 * Delete a volume, ownership-checked via its target.
 *
 * `wipe` destroys the data as well as detaching the mount. It defaults to off:
 * removing a volume from a service and destroying what is inside it are two
 * different intentions, and only one of them is recoverable.
 */
export async function deleteVolume(id: string, ownerId: string, options?: { wipe?: boolean }): Promise<void> {
    const volume = await prisma.volume.findFirst({
        where: { id, target: { ownerId } },
        select: { id: true }
    });
    if (!volume) throw new Error("Volume not found");
    // Wipe before detaching: once the row is gone there is nothing left that
    // knows where the data was.
    if (options?.wipe) await wipeVolume(id, ownerId);
    await prisma.volume.delete({ where: { id } });
}

// --- usage and wiping -------------------------------------------------------

/** A volume with everything the detail panel shows, including where it lives. */
export interface VolumeDetail extends VolumeView {
    applicationId: string | null;
    applicationName: string | null;
    /** The server it is stored on - Railway calls this the volume's region. */
    serverName: string;
    serverKind: string;
    /** True when the service it is attached to is currently deployed, which is
     *  what decides whether usage can be measured or the data reached at all. */
    serviceRunning: boolean;
}

export async function getVolume(id: string, ownerId: string): Promise<VolumeDetail> {
    const row = await prisma.volume.findFirst({
        where: { id, target: { ownerId } },
        include: {
            connection: { select: { name: true } },
            target: { select: { name: true, kind: true } },
            application: { select: { id: true, name: true, currentDeploymentId: true } }
        }
    });
    if (!row) throw new Error("Volume not found");
    return {
        id: row.id,
        name: row.name,
        mountPath: row.mountPath,
        kind: row.kind === "bind" ? "bind" : row.kind === "nas" ? "nas" : "volume",
        source: row.source ?? row.name,
        connectionId: row.connectionId,
        connectionName: row.connection?.name ?? null,
        sizeLimit: row.sizeLimit,
        applicationId: row.application?.id ?? null,
        applicationName: row.application?.name ?? null,
        serverName: row.target.name,
        serverKind: row.target.kind,
        serviceRunning: Boolean(row.application?.currentDeploymentId)
    };
}

/**
 * The container a volume's data is reachable through, plus the ports to reach it
 * with. A volume is measured and emptied from inside the service that mounts it,
 * because that is the one place all three kinds resolve to the same path - a
 * named volume, a host bind and a NAS mount all appear at `mountPath` there.
 */
async function volumeRuntime(id: string, ownerId: string) {
    const volume = await prisma.volume.findFirst({
        where: { id, target: { ownerId } },
        include: {
            target: true,
            application: {
                include: { environment: { include: { project: true } }, target: true, volumes: { select: { id: true } } }
            }
        }
    });
    if (!volume) throw new Error("Volume not found");
    if (!volume.application) throw new Error("This volume is not attached to a service");
    if (!volume.application.currentDeploymentId) {
        throw new Error("The service is not running, so its volume cannot be reached");
    }
    const ref = await currentReleaseRef(volume.application);
    return { volume, container: ref.name, target: volume.target as TargetRow };
}

/**
 * How long a single measurement may take before it is reported as unmeasurable.
 * `du` walks the whole tree, and on a NAS share that has stopped answering it
 * never comes back at all - so a caller a person is waiting on gets an answer
 * either way rather than a panel that loads forever.
 */
const USAGE_TIMEOUT_MS = 15_000;

/**
 * Bytes currently used by a volume, or null when it cannot be measured right now
 * (the service is not up, the image has no `du`, or the walk ran past its
 * budget). Never throws for the ordinary "nothing running" case - a chart with
 * no data is the honest answer.
 */
export async function measureVolumeUsage(id: string, ownerId: string): Promise<number | null> {
    let runtime;
    try {
        runtime = await volumeRuntime(id, ownerId);
    } catch {
        return null;
    }
    const ports = await getPorts(runtime.target, ownerId);
    try {
        return await withTimeout(
            ports.diskUsage(runtime.container, runtime.volume.mountPath),
            USAGE_TIMEOUT_MS,
            "measuring the volume took too long"
        );
    } catch {
        return null;
    } finally {
        await ports.dispose();
    }
}

/**
 * Destroy everything inside a volume, keeping the volume itself. The mount point
 * survives so the service has somewhere to write when it comes back; only the
 * contents go.
 */
export async function wipeVolume(id: string, ownerId: string): Promise<void> {
    const runtime = await volumeRuntime(id, ownerId);
    const ports = await getPorts(runtime.target, ownerId);
    try {
        await ports.wipePath(runtime.container, runtime.volume.mountPath);
    } finally {
        await ports.dispose();
    }
    // A NAS volume is also a Drive folder, and Drive keeps its own size cache -
    // leaving it behind would report the old figure until something else evicts it.
    if (runtime.volume.kind === "nas" && runtime.volume.connectionId && runtime.volume.source) {
        await prisma.driveFolderSize
            .deleteMany({
                where: { connectionId: runtime.volume.connectionId, path: { startsWith: runtime.volume.source } }
            })
            .catch(() => undefined);
    }
}
