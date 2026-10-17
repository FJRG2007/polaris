/**
 * Folders and tags on the automations list: folders belong to a shelf (one
 * level, a name each), tags are words on an automation. Reading follows
 * `mayReadShelf`, every change `mayEditShelf`, the same checks the list uses to
 * hide what it would refuse. Nothing here touches a graph or a run.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { mayEditShelf, mayReadShelf, type Shelf } from "./runner";
import { AutomationAccessError, load, shelfWhere } from "./service";

const L = core.AUTOMATION_ORGANIZE_LIMITS;

export interface FolderRow {
    readonly id: string;
    readonly name: string;
}

export async function listFolders(actor: RunActor, shelf: Shelf): Promise<FolderRow[]> {
    if (!(await mayReadShelf(actor, shelf))) return [];
    return prisma.automationFolder.findMany({ where: shelfWhere(shelf), orderBy: { name: "asc" }, take: L.foldersPerShelf, select: { id: true, name: true } });
}

async function editableShelf(actor: RunActor, shelf: Shelf): Promise<void> {
    if (!(await mayEditShelf(actor, shelf))) throw new AutomationAccessError("forbidden");
}

async function folderFor(actor: RunActor, folderId: string): Promise<{ id: string; orgId: string | null; userId: string | null }> {
    const folder = await prisma.automationFolder.findUnique({ where: { id: folderId }, select: { id: true, orgId: true, userId: true } });
    if (!folder || !(await mayReadShelf(actor, folder))) throw new AutomationAccessError("notFound");
    await editableShelf(actor, folder);
    return folder;
}

export async function createFolder(actor: RunActor, shelf: Shelf, name: string): Promise<FolderRow> {
    await editableShelf(actor, shelf);
    if ((await prisma.automationFolder.count({ where: shelfWhere(shelf) })) >= L.foldersPerShelf) throw new AutomationAccessError("limit");
    return prisma.automationFolder.create({ data: { orgId: shelf.orgId, userId: shelf.orgId ? null : shelf.userId, name }, select: { id: true, name: true } });
}

export async function renameFolder(actor: RunActor, folderId: string, name: string): Promise<void> {
    await folderFor(actor, folderId);
    await prisma.automationFolder.update({ where: { id: folderId }, data: { name } });
}

/** Delete a folder; what was in it stays, out of any folder. */
export async function deleteFolder(actor: RunActor, folderId: string): Promise<void> {
    const folder = await folderFor(actor, folderId);
    await prisma.automation.updateMany({ where: { folderId, ...shelfWhere(folder) }, data: { folderId: null } });
    await prisma.automationFolder.deleteMany({ where: { id: folderId } });
}

/** Put an automation in a folder of its own shelf, or in none (null). */
export async function moveToFolder(actor: RunActor, automationId: string, folderId: string | null): Promise<void> {
    const row = await load(actor, automationId, true);
    if (folderId) {
        const folder = await prisma.automationFolder.findUnique({ where: { id: folderId }, select: { orgId: true, userId: true } });
        const same = folder && (row.orgId ? folder.orgId === row.orgId : folder.orgId === null && folder.userId === row.userId);
        if (!same) throw new AutomationAccessError("notFound");
    }
    await prisma.automation.update({ where: { id: automationId }, data: { folderId } });
}

export async function setTags(actor: RunActor, automationId: string, tags: string[]): Promise<void> {
    await load(actor, automationId, true);
    await prisma.automation.update({ where: { id: automationId }, data: { tags } });
}
