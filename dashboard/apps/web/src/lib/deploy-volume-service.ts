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
import {
    canHostMount,
    deployVolumeInputSchema,
    normalizeVolumeSource,
    UnsafePathError,
    type DeployVolumeInput,
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

/** Delete a volume, ownership-checked via its target. */
export async function deleteVolume(id: string, ownerId: string): Promise<void> {
    const volume = await prisma.volume.findFirst({
        where: { id, target: { ownerId } },
        select: { id: true }
    });
    if (!volume) throw new Error("Volume not found");
    await prisma.volume.delete({ where: { id } });
}
