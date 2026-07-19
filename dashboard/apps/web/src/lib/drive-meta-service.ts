/**
 * Drive item metadata. Stores per-path presentation state a user sets on a
 * browsed item - a custom icon or a hidden flag - without mirroring the remote
 * tree: a row exists only once an item is customized. All writes verify the
 * connection belongs to the caller, so one user can never annotate another's
 * files. Keyed by (connectionId, path).
 */

import { prisma } from "@polaris/db";

export interface ItemMeta {
    hidden: boolean;
    icon: string | null;
    iconColor: string | null;
}

/** Metadata for the given paths in a connection, as a path -> meta map. */
export async function getMetaMap(connectionId: string, paths: string[]): Promise<Map<string, ItemMeta>> {
    if (paths.length === 0) return new Map();
    const rows = await prisma.driveItemMeta.findMany({
        where: { connectionId, path: { in: paths } },
        select: { path: true, hidden: true, icon: true, iconColor: true }
    });
    return new Map(rows.map((row) => [row.path, { hidden: row.hidden, icon: row.icon, iconColor: row.iconColor }]));
}

/** Assert the connection is owned by the user (throws otherwise). */
async function assertOwns(ownerId: string, connectionId: string): Promise<void> {
    const owns = await prisma.storageConnection.count({ where: { id: connectionId, ownerId } });
    if (owns === 0) throw new Error("Connection not found");
}

/** Set (or clear) an item's hidden flag. */
export async function setItemHidden(
    ownerId: string,
    connectionId: string,
    path: string,
    hidden: boolean
): Promise<void> {
    await assertOwns(ownerId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, hidden },
        update: { hidden }
    });
}

/** Set (or clear, with nulls) an item's custom icon and color. */
export async function setItemIcon(
    ownerId: string,
    connectionId: string,
    path: string,
    icon: string | null,
    iconColor: string | null
): Promise<void> {
    await assertOwns(ownerId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, icon, iconColor },
        update: { icon, iconColor }
    });
}

/** Re-point metadata to a new path after a move/rename so it follows the item. */
export async function moveItemMeta(connectionId: string, from: string, to: string): Promise<void> {
    await prisma.driveItemMeta.updateMany({ where: { connectionId, path: from }, data: { path: to } });
}
