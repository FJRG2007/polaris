/**
 * Drive item metadata. Stores per-path presentation state a user sets on a
 * browsed item - a custom icon or a hidden flag - without mirroring the remote
 * tree: a row exists only once an item is customized. All writes verify the
 * connection belongs to the caller, so one user can never annotate another's
 * files. Keyed by (connectionId, path).
 */

import { prisma } from "@polaris/db";
import { isUuid } from "./uuid";

export interface ItemMeta {
    hidden: boolean;
    favorite: boolean;
    icon: string | null;
    iconColor: string | null;
    note: string | null;
    creatorId: string | null;
}

/** Metadata for the given paths in a connection, as a path -> meta map. */
export async function getMetaMap(connectionId: string, paths: string[]): Promise<Map<string, ItemMeta>> {
    if (paths.length === 0 || !isUuid(connectionId)) return new Map();
    const rows = await prisma.driveItemMeta.findMany({
        where: { connectionId, path: { in: paths } },
        select: { path: true, hidden: true, favorite: true, icon: true, iconColor: true, note: true, creatorId: true }
    });
    return new Map(
        rows.map((row) => [
            row.path,
            {
                hidden: row.hidden,
                favorite: row.favorite,
                icon: row.icon,
                iconColor: row.iconColor,
                note: row.note,
                creatorId: row.creatorId
            }
        ])
    );
}

/**
 * Record who created/uploaded an item (a creation event, not a user-set flag), so
 * the browser can show its owner. Not ownership-asserted - it is a system fact
 * that also holds for items on connections shared to a grantee - so the meta row's
 * ownerId is set to the connection's actual owner. No-op without a creator id.
 */
export async function recordItemCreator(
    connectionId: string,
    path: string,
    creatorId: string | null
): Promise<void> {
    if (!creatorId || !isUuid(connectionId)) return;
    const connection = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { ownerId: true }
    });
    if (!connection) return;
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId: connection.ownerId, connectionId, path, creatorId },
        update: { creatorId }
    });
}

/** Resolve a set of user ids to a display-name map (for showing item owners). */
export async function resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((user) => [user.id, user.name]));
}

/** Assert the connection is owned by the user (throws otherwise). */
async function assertOwns(ownerId: string, connectionId: string): Promise<void> {
    if (!isUuid(connectionId)) throw new Error("This source cannot be customized");
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

/** Star or unstar an item (mark it a favorite). */
export async function setItemFavorite(
    ownerId: string,
    connectionId: string,
    path: string,
    favorite: boolean
): Promise<void> {
    await assertOwns(ownerId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, favorite },
        update: { favorite }
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

/** Set (or clear with null/empty) a free-text note on an item. */
export async function setItemNote(
    ownerId: string,
    connectionId: string,
    path: string,
    note: string | null
): Promise<void> {
    await assertOwns(ownerId, connectionId);
    const value = note && note.trim() ? note.trim() : null;
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, note: value },
        update: { note: value }
    });
}

/** Re-point metadata to a new path after a move/rename so it follows the item. */
export async function moveItemMeta(connectionId: string, from: string, to: string): Promise<void> {
    if (!isUuid(connectionId)) return;
    await prisma.driveItemMeta.updateMany({ where: { connectionId, path: from }, data: { path: to } });
}
