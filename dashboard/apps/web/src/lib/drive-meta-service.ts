/**
 * Drive item metadata. Stores per-path presentation state a user sets on a
 * browsed item - a custom icon or a hidden flag - without mirroring the remote
 * tree: a row exists only once an item is customized. All writes verify the
 * connection belongs to the caller, so one user can never annotate another's
 * files. Keyed by (connectionId, path).
 */

import { isUuid } from "./uuid";
import { prisma } from "@polaris/db";

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
        select: { ownerId: true, orgId: true }
    });
    if (!connection) return;
    // Whoever the connection belongs to, which is an account for a personal
    // drive and an organization for the company's. It is an index rather than a
    // relation, and `creatorId` beside it is the one that answers "who put this
    // here" - which is the question worth asking on a shelf several people
    // write to.
    const owner = connection.ownerId ?? connection.orgId;
    if (!owner) return;
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId: owner, connectionId, path, creatorId },
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

/**
 * Establish that this account may customize the connection, and answer who the
 * resulting row belongs to.
 *
 * Ownership is not the question, because an organization's shelf is owned by no
 * account: asking `ownerId === userId` there refuses the organization's own
 * owner, every member of it and every instance administrator alike, and it
 * refuses them on a star - which the browser applies optimistically and then
 * silently rolls back, so nothing on screen ever says no.
 *
 * The row that comes out is filed under whoever the connection belongs to,
 * which is an account for a personal drive and the organization for a company
 * one. A star on the company shelf is therefore the company's, the same way the
 * files on it are - the person who put it there is `creatorId`, beside it.
 */
async function assertMayCustomize(userId: string, connectionId: string): Promise<string> {
    if (!isUuid(connectionId)) throw new Error("This source cannot be customized");
    const connection = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { ownerId: true, orgId: true }
    });
    const owner = connection?.ownerId ?? connection?.orgId;
    if (!connection || !owner) throw new Error("Connection not found");
    const { canManageDriveConnection } = await import("@/lib/drive-authz");
    if (!(await canManageDriveConnection(userId, false, connectionId))) {
        throw new Error("Connection not found");
    }
    return owner;
}

/** Set (or clear) an item's hidden flag. */
export async function setItemHidden(
    userId: string,
    connectionId: string,
    path: string,
    hidden: boolean
): Promise<void> {
    const ownerId = await assertMayCustomize(userId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, hidden },
        update: { hidden }
    });
}

/** Star or unstar an item (mark it a favorite). */
export async function setItemFavorite(
    userId: string,
    connectionId: string,
    path: string,
    favorite: boolean
): Promise<void> {
    const ownerId = await assertMayCustomize(userId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, favorite },
        update: { favorite }
    });
}

/** Set (or clear, with nulls) an item's custom icon and color. */
export async function setItemIcon(
    userId: string,
    connectionId: string,
    path: string,
    icon: string | null,
    iconColor: string | null
): Promise<void> {
    const ownerId = await assertMayCustomize(userId, connectionId);
    await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId, connectionId, path, icon, iconColor },
        update: { icon, iconColor }
    });
}

/** Set (or clear with null/empty) a free-text note on an item. */
export async function setItemNote(
    userId: string,
    connectionId: string,
    path: string,
    note: string | null
): Promise<void> {
    const ownerId = await assertMayCustomize(userId, connectionId);
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

/** A starred item, with the connection it lives on, for the Favorites view. */
export interface FavoriteItem {
    connectionId: string;
    connectionName: string;
    path: string;
}

/**
 * Every item starred on a shelf this account reaches, newest first.
 *
 * Their own drives are filed under them; a company's are filed under the
 * organization, because that is who the shelf belongs to. Both are asked for,
 * or a star put on the company shelf goes into Favourites for nobody - the one
 * place it was put there to appear.
 */
export async function listFavorites(userId: string): Promise<FavoriteItem[]> {
    const { memberOrgIds } = await import("@/lib/orgs/org-service");
    const owners = [userId, ...(await memberOrgIds(userId))];
    const rows = await prisma.driveItemMeta.findMany({
        where: { ownerId: { in: owners }, favorite: true },
        orderBy: { updatedAt: "desc" },
        select: { connectionId: true, path: true, connection: { select: { name: true } } }
    });
    return rows.map((row) => ({
        connectionId: row.connectionId,
        connectionName: row.connection.name,
        path: row.path
    }));
}
