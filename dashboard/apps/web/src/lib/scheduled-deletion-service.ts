/**
 * Scheduled deletions. A user can mark a file or folder to be deleted at a future
 * time. Polaris has no always-on scheduler, so - like share/link expiry - due
 * rows are evaluated lazily: swept whenever the connection is next browsed, and by
 * an optional cron endpoint for exact timing. Each row carries its own owner, so
 * the sweep acts with the scheduler's rights, not the browser's. `permanent`
 * chooses a real delete over the recycle bin.
 */

import { baseName, normalizeRelPath } from "@polaris/core";
import { prisma } from "@polaris/db";
import { isUuid } from "@/lib/uuid";
import { getDriver } from "@/lib/storage-service";
import { moveToTrash } from "@/lib/trash-service";
import { recordAudit } from "@/lib/audit-service";

/** Rows processed per sweep, so a large backlog cannot hang a listing. */
const SWEEP_BATCH = 50;

/** Schedule a deletion, replacing any existing schedule for the same path. */
export async function createScheduledDeletion(entry: {
    ownerId: string;
    connectionId: string;
    path: string;
    permanent: boolean;
    deleteAt: Date;
}): Promise<{ id: string }> {
    const path = normalizeRelPath(entry.path);
    await prisma.scheduledDeletion.deleteMany({ where: { connectionId: entry.connectionId, path } });
    const row = await prisma.scheduledDeletion.create({
        data: {
            ownerId: entry.ownerId,
            connectionId: entry.connectionId,
            path,
            name: baseName(path) || path,
            permanent: entry.permanent,
            deleteAt: entry.deleteAt
        },
        select: { id: true }
    });
    return { id: row.id };
}

/** Cancel a scheduled deletion the caller owns (idempotent, IDOR-safe). */
export async function cancelScheduledDeletion(ownerId: string, id: string): Promise<void> {
    await prisma.scheduledDeletion.deleteMany({ where: { id, ownerId } });
}

/**
 * Execute every deletion whose time has come, optionally limited to one
 * connection. Returns how many were processed. Best-effort per row: a row is
 * always dropped afterwards (so a missing or un-deletable item never loops), and
 * a failed delete leaves the file in place - deletion fails safe toward keeping data.
 */
export async function sweepDueDeletions(connectionId?: string): Promise<number> {
    // A non-UUID source (an ephemeral `container:<id>` connection) schedules nothing.
    if (connectionId && !isUuid(connectionId)) return 0;
    const due = await prisma.scheduledDeletion.findMany({
        where: { deleteAt: { lte: new Date() }, ...(connectionId ? { connectionId } : {}) },
        orderBy: { deleteAt: "asc" },
        take: SWEEP_BATCH
    });

    for (const row of due) {
        let done = false;
        try {
            if (row.permanent) {
                const driver = await getDriver(row.connectionId, row.ownerId);
                try {
                    await driver.delete(normalizeRelPath(row.path), { recursive: true });
                } finally {
                    await driver.dispose();
                }
            } else {
                await moveToTrash(row.ownerId, row.connectionId, row.path);
            }
            done = true;
        } catch {
            done = false;
        }
        await prisma.scheduledDeletion.delete({ where: { id: row.id } });
        if (done) {
            await recordAudit({
                actorId: row.ownerId,
                action: row.permanent ? "drive.delete" : "drive.trash",
                targetType: "connection",
                targetId: row.connectionId,
                metadata: { path: row.path, scheduled: true }
            });
        }
    }
    return due.length;
}
