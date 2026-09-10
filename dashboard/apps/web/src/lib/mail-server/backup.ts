/**
 * Backing a mail server up, through Backups rather than beside it.
 *
 * The server is protected as one thing: a copy is the engine's own export, taken
 * with the engine stopped for as long as the export runs, so every mailbox, the
 * queue and the keys are caught at one moment rather than mid-write (see the
 * `mail-server` backup source). Backups schedules, keeps, seals and restores it
 * like anything else it protects.
 *
 * Servers protected before this had their two volumes copied as files while the
 * engine ran. Those stay protected and restorable where they are; they are only
 * counted here, so the screen can say they exist.
 */

import { MailServerAccessError } from "./access";
import { recordAudit } from "@/lib/audit-service";
import { prisma, type MailServer } from "@polaris/db";
import { protectResource } from "@/lib/backups/manage";
import { targetSelector } from "@/lib/backups/schemas";

export interface MailBackupView {
    /** The protected resource, when the server is protected. */
    readonly resourceId: string | null;
    readonly status: string | null;
    readonly lastBackupAt: string | null;
    readonly lastStatus: string | null;
    readonly lastError: string | null;
    readonly copyCount: number;
    /** Volume copies from before, still protected on their own. */
    readonly volumeResources: readonly { readonly id: string; readonly name: string }[];
    /** Whether setup has made the engine a service yet. */
    readonly ready: boolean;
}

/** How the server is protected. */
export async function mailBackups(server: MailServer): Promise<MailBackupView> {
    const volumes = server.applicationId
        ? await prisma.volume.findMany({ where: { applicationId: server.applicationId }, select: { id: true } })
        : [];
    const [resource, volumeResources] = await Promise.all([
        prisma.protectedResource.findFirst({
            where: { ownerId: server.ownerId, selector: targetSelector({ kind: "mail-server", serverId: server.id }) },
            select: { id: true, status: true, lastBackupAt: true, lastStatus: true, lastError: true, copyCount: true }
        }),
        prisma.protectedResource.findMany({
            where: {
                ownerId: server.ownerId,
                selector: { in: volumes.map((volume) => targetSelector({ kind: "deploy-volume", volumeId: volume.id })) }
            },
            select: { id: true, name: true }
        })
    ]);
    return {
        resourceId: resource?.id ?? null,
        status: resource?.status ?? null,
        lastBackupAt: resource?.lastBackupAt?.toISOString() ?? null,
        lastStatus: resource?.lastStatus ?? null,
        lastError: resource?.lastError ?? null,
        copyCount: resource?.copyCount ?? 0,
        volumeResources,
        ready: Boolean(server.applicationId)
    };
}

/** Protect the server on the default plan. Protecting it twice is one row. */
export async function protectMailServer(actorId: string, server: MailServer): Promise<string> {
    if (!server.applicationId) {
        throw new MailServerAccessError("This mail server is not running yet. Finish setting it up first.");
    }
    const created = await protectResource(server.ownerId, {
        target: { kind: "mail-server", serverId: server.id },
        name: `Mail ${server.hostname}`
    });
    await recordAudit({
        actorId,
        action: "mailserver.backup.protect",
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined
    });
    return created.id;
}
