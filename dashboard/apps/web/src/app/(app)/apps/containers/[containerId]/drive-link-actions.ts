"use server";

/**
 * The address the container page's "Open in Drive" leads to, worked out on the
 * server because both answers depend on what the viewer may open: a Deploy
 * service of theirs is a Drive source of its own, and a server is one only to
 * the account that enrolled it - or, for the machine Polaris runs on, to anybody
 * who manages servers. Null means no Drive location would open for this viewer,
 * and the page offers no button rather than one that ends in a refusal.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { getLocalHostId } from "@/lib/local-server";
import { servingReleases } from "@/lib/deploy/releases";
import { managesServers, reachesLocalHost } from "@/lib/drive-root";
import { driveHref, hostFolderFor } from "@/lib/container-drive-link";
import { HOST_DOCKER_PREFIX, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";
import { CONTAINER_CONNECTION_PREFIX, HOST_CONNECTION_PREFIX } from "@/lib/storage-service";

const inputSchema = z.object({
    connectionId: z.string().trim().min(1).max(200),
    containerName: z.string().trim().min(1).max(255),
    path: z.string().trim().max(4096).startsWith("/"),
    mounts: z
        .array(z.object({ source: z.string().max(4096), destination: z.string().max(4096) }))
        .max(200)
});

export async function containerDriveLinkAction(input: unknown): Promise<string | null> {
    const user = await requirePermission("deploy.read");
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return null;
    const { connectionId, containerName, path, mounts } = parsed.data;
    const name = containerName.replace(/^\/+/, "");

    let hostId: string | null = null;
    if (connectionId === LOCAL_DOCKER_CONNECTION_ID) {
        const service = await localServiceNamed(user.id, name);
        if (service) return driveHref(`${CONTAINER_CONNECTION_PREFIX}${service}`, path);
        hostId = await getLocalHostId();
    } else if (connectionId.startsWith(HOST_DOCKER_PREFIX)) {
        hostId = connectionId.slice(HOST_DOCKER_PREFIX.length);
    }
    if (!hostId) return null;

    const folder = hostFolderFor(mounts, path);
    if (folder === null) return null;
    if (!(await hostInDrive(user.id, hostId))) return null;
    return driveHref(`${HOST_CONNECTION_PREFIX}${hostId}`, folder);
}

/** The viewer's own Deploy service on this machine that this container is
 *  currently serving, the same set Drive opens as a container source. */
async function localServiceNamed(userId: string, name: string): Promise<string | null> {
    const apps = await prisma.application.findMany({
        where: {
            currentDeploymentId: { not: null },
            target: { kind: "local" },
            environment: { project: { ownerId: userId } }
        },
        select: {
            id: true,
            slug: true,
            currentDeploymentId: true,
            environment: { select: { project: { select: { slug: true } } } }
        }
    });
    if (apps.length === 0) return null;
    const releases = await servingReleases(apps);
    return apps.find((app) => releases.get(app.id)?.name === name)?.id ?? null;
}

/** Whether this server is among the viewer's Drive sources. */
async function hostInDrive(userId: string, hostId: string): Promise<boolean> {
    const host = await prisma.host.findUnique({ where: { id: hostId }, select: { ownerId: true } });
    if (!host) return false;
    if (host.ownerId === userId) return true;
    const localHostId = await getLocalHostId();
    if (localHostId !== hostId) return false;
    return reachesLocalHost({ localHostId, hostId, managesServers: await managesServers(userId) });
}
