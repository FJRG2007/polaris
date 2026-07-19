/**
 * Polaris-managed recycle bin. "Move to Trash" relocates an item into a hidden
 * trash folder on the same connection and records where it came from, so it can
 * be listed, restored to its original location, or permanently deleted. This is
 * backend-agnostic (it just uses the driver's move/delete), so it works for any
 * NAS or server. UniFi UNAS keeps its own trash; that can be reused later without
 * changing these call sites.
 */

import { randomBytes } from "node:crypto";
import { baseName, normalizeRelPath } from "@polaris/core";
import { prisma } from "@polaris/db";
import { getDriver } from "@/lib/storage-service";
import { POLARIS_DIR, TRASH_DIR } from "@/lib/system-paths";

export { TRASH_DIR };

type Driver = Awaited<ReturnType<typeof getDriver>>;

/** Whether a path exists on a driver. */
async function exists(driver: Driver, path: string): Promise<boolean> {
    try {
        await driver.stat(path);
        return true;
    } catch {
        return false;
    }
}

/** A non-colliding restore destination (appends "-restored" as needed). */
async function freeDestination(driver: Driver, path: string): Promise<string> {
    if (!(await exists(driver, path))) return path;
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${dir}${stem}-restored-${randomBytes(3).toString("hex")}${ext}`;
}

/** Move an item into the connection's trash folder and record it. */
export async function moveToTrash(ownerId: string, connectionId: string, path: string): Promise<void> {
    const source = normalizeRelPath(path);
    // Never trash Polaris's own hidden folder (the bin, quarantine, ...).
    if (!source || source === POLARIS_DIR || source.startsWith(`${POLARIS_DIR}/`)) return;
    const driver = await getDriver(connectionId, ownerId);
    try {
        const stat = await driver.stat(source);
        const name = baseName(source) || source;
        const trashPath = `${TRASH_DIR}/${randomBytes(6).toString("hex")}-${name}`;
        try {
            await driver.mkdir(TRASH_DIR);
        } catch {
            // Trash folder already exists (or the driver made it implicitly).
        }
        await driver.move(source, trashPath);
        await prisma.trashItem.create({
            data: { ownerId, connectionId, name, originalPath: source, trashPath, kind: stat.kind, size: stat.size }
        });
    } finally {
        await driver.dispose();
    }
}

/** Every trashed item owned by the user, newest first, with its connection name. */
export async function listTrash(ownerId: string) {
    return prisma.trashItem.findMany({
        where: { ownerId },
        orderBy: { deletedAt: "desc" },
        include: { connection: { select: { name: true } } }
    });
}

/** Restore a trashed item to its original path (renamed if that path is taken). */
export async function restoreTrash(ownerId: string, id: string): Promise<void> {
    const row = await prisma.trashItem.findFirst({ where: { id, ownerId } });
    if (!row) return;
    const driver = await getDriver(row.connectionId, ownerId);
    try {
        const destination = await freeDestination(driver, row.originalPath);
        await driver.move(row.trashPath, destination);
    } finally {
        await driver.dispose();
    }
    await prisma.trashItem.delete({ where: { id: row.id } });
}

/** Permanently delete a single trashed item. */
export async function deleteTrashForever(ownerId: string, id: string): Promise<void> {
    const row = await prisma.trashItem.findFirst({ where: { id, ownerId } });
    if (!row) return;
    const driver = await getDriver(row.connectionId, ownerId);
    try {
        await driver.delete(row.trashPath, { recursive: true });
    } catch {
        // Already gone; drop the record regardless.
    } finally {
        await driver.dispose();
    }
    await prisma.trashItem.delete({ where: { id: row.id } });
}

/** Permanently delete every trashed item the user owns. */
export async function emptyTrash(ownerId: string): Promise<void> {
    const rows = await prisma.trashItem.findMany({ where: { ownerId } });
    const byConnection = new Map<string, typeof rows>();
    for (const row of rows) {
        const list = byConnection.get(row.connectionId) ?? [];
        list.push(row);
        byConnection.set(row.connectionId, list);
    }
    for (const [connectionId, items] of byConnection) {
        const driver = await getDriver(connectionId, ownerId);
        try {
            for (const item of items) {
                try {
                    await driver.delete(item.trashPath, { recursive: true });
                } catch {
                    // Best effort per item.
                }
            }
        } finally {
            await driver.dispose();
        }
    }
    await prisma.trashItem.deleteMany({ where: { ownerId } });
}
