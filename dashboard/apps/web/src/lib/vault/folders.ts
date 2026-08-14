/**
 * Folders: how one person arranges their own vault.
 *
 * Personal even for items an organization owns, because the name is encrypted
 * under the person's own key - there is no way for a folder to mean anything to
 * anybody else. Deleting one therefore never deletes what is in it; the items
 * simply stop being in a folder.
 */

import { prisma } from "@polaris/db";
import { bumpRevision } from "@/lib/vault/account";

/** One folder, in the shape a client reads. */
function toResponse(row: { id: string; name: string; revisionDate: Date }): Record<string, unknown> {
    return {
        object: "folder",
        id: row.id,
        name: row.name,
        revisionDate: row.revisionDate.toISOString()
    };
}

export async function listFolders(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.vaultFolder.findMany({
        where: { userId },
        orderBy: { revisionDate: "desc" },
        select: { id: true, name: true, revisionDate: true }
    });
    return rows.map(toResponse);
}

export async function createFolder(userId: string, name: string): Promise<Record<string, unknown>> {
    const row = await prisma.vaultFolder.create({
        data: { userId, name },
        select: { id: true, name: true, revisionDate: true }
    });
    await bumpRevision(userId);
    return toResponse(row);
}

export async function updateFolder(
    userId: string,
    folderId: string,
    name: string
): Promise<Record<string, unknown> | null> {
    const { count } = await prisma.vaultFolder.updateMany({
        where: { id: folderId, userId },
        data: { name, revisionDate: new Date() }
    });
    if (count === 0) return null;
    await bumpRevision(userId);
    const row = await prisma.vaultFolder.findUnique({
        where: { id: folderId },
        select: { id: true, name: true, revisionDate: true }
    });
    return row ? toResponse(row) : null;
}

/**
 * Delete a folder. Its items keep existing and lose their folder, which the
 * schema does with SetNull rather than this file walking them - the alternative
 * is a delete that quietly takes a vault's contents with it.
 */
export async function deleteFolder(userId: string, folderId: string): Promise<boolean> {
    const { count } = await prisma.vaultFolder.deleteMany({ where: { id: folderId, userId } });
    if (count === 0) return false;
    await bumpRevision(userId);
    return true;
}
