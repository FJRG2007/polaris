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
import { deployVolumeInputSchema, normalizeVolumeSource, UnsafePathError, type DeployVolumeInput } from "@polaris/core";

export interface VolumeView {
    id: string;
    name: string;
    mountPath: string;
    kind: "volume" | "bind" | "nas";
    source: string;
    connectionId: string | null;
    connectionName: string | null;
}

/** List an application's volumes, ownership-checked. */
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
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        mountPath: row.mountPath,
        kind: row.kind === "bind" ? "bind" : row.kind === "nas" ? "nas" : "volume",
        source: row.source ?? row.name,
        connectionId: row.connectionId,
        connectionName: row.connection?.name ?? null
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
        select: { id: true, targetId: true }
    });
    if (!app) throw new Error("Application not found");

    // A nas volume must point at a hostd-mounted storage connection the owner
    // controls; that is the only way its bind source resolves onto the NAS.
    if (parsed.kind === "nas") {
        const connection = await prisma.storageConnection.findFirst({
            where: { id: parsed.connectionId, ownerId },
            select: { id: true, requiresHostd: true, status: true }
        });
        if (!connection) throw new Error("Storage connection not found");
        if (!connection.requiresHostd) throw new Error("This storage connection is not host-mounted, so it cannot back a NAS volume");
        if (connection.status !== "active") throw new Error("The storage connection is not active");
    }

    let source: string;
    try {
        source = normalizeVolumeSource(parsed.kind, parsed.source);
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
            connectionId: parsed.kind === "nas" ? parsed.connectionId : null
        },
        include: { connection: { select: { name: true } } }
    });
    return {
        id: created.id,
        name: created.name,
        mountPath: created.mountPath,
        kind: parsed.kind,
        source,
        connectionId: created.connectionId,
        connectionName: created.connection?.name ?? null
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
