/**
 * Backing a mail server up, through Backups rather than beside it.
 *
 * The engine keeps everything in two volumes: its configuration and its data
 * store (every mailbox, the queue, the DKIM keys). Both are ordinary Deploy
 * volumes, which Backups already copies, schedules, keeps and restores - so
 * protecting a mail server is protecting those two, and restoring one is the
 * restore Backups already offers for a volume.
 *
 * A copy is taken of the files while the engine runs. The engine's store is
 * written to all the time, so a copy is only as consistent as the moment it was
 * taken; the engine has an export tool of its own for a consistent snapshot,
 * which Polaris does not drive yet.
 */

import { MailServerAccessError } from "./access";
import { recordAudit } from "@/lib/audit-service";
import { prisma, type MailServer } from "@polaris/db";
import { protectResource } from "@/lib/backups/manage";
import { targetSelector } from "@/lib/backups/schemas";

export interface MailBackupView {
    readonly volumeId: string;
    readonly volume: string;
    readonly mountPath: string;
    /** The protected resource, when the volume is protected. */
    readonly resourceId: string | null;
    readonly status: string | null;
    readonly lastBackupAt: string | null;
    readonly lastStatus: string | null;
    readonly lastError: string | null;
    readonly copyCount: number;
}

async function volumesOf(server: MailServer) {
    if (!server.applicationId) return [];
    return prisma.volume.findMany({
        where: { applicationId: server.applicationId },
        select: { id: true, name: true, mountPath: true },
        orderBy: { name: "asc" }
    });
}

/** The server's volumes, and how each is protected. */
export async function mailBackups(server: MailServer): Promise<MailBackupView[]> {
    const volumes = await volumesOf(server);
    const resources = await prisma.protectedResource.findMany({
        where: {
            ownerId: server.ownerId,
            selector: { in: volumes.map((volume) => targetSelector({ kind: "deploy-volume", volumeId: volume.id })) }
        },
        select: { id: true, selector: true, status: true, lastBackupAt: true, lastStatus: true, lastError: true, copyCount: true }
    });
    const bySelector = new Map(resources.map((resource) => [resource.selector, resource]));
    return volumes.map((volume) => {
        const resource = bySelector.get(targetSelector({ kind: "deploy-volume", volumeId: volume.id }));
        return {
            volumeId: volume.id,
            volume: volume.name,
            mountPath: volume.mountPath,
            resourceId: resource?.id ?? null,
            status: resource?.status ?? null,
            lastBackupAt: resource?.lastBackupAt?.toISOString() ?? null,
            lastStatus: resource?.lastStatus ?? null,
            lastError: resource?.lastError ?? null,
            copyCount: resource?.copyCount ?? 0
        };
    });
}

/** Protect both volumes, on the default plan. Protecting one twice is one row. */
export async function protectMailServer(actorId: string, server: MailServer): Promise<number> {
    const volumes = await volumesOf(server);
    if (volumes.length === 0) throw new MailServerAccessError("This mail server has no volumes yet. Finish setting it up first.");
    for (const volume of volumes) {
        await protectResource(server.ownerId, {
            target: { kind: "deploy-volume", volumeId: volume.id },
            name: `Mail ${server.hostname} - ${volume.name}`
        });
    }
    await recordAudit({
        actorId,
        action: "mailserver.backup.protect",
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined
    });
    return volumes.length;
}
