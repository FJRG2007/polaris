/**
 * Drive access-control lists. A connection is owned by one user, but its owner
 * (or an admin) can grant other users and groups access to specific subtrees with
 * a chosen set of Drive verbs. This module persists those grants and, crucially,
 * resolves the per-request decision: given a user, a connection, a path, and a
 * verb, may it proceed?
 *
 * The decision composes three inputs into the pure engine from @polaris/core:
 *   1. Ownership - the connection's owner (and any admin) is always allowed.
 *   2. ACL rows for the user and their groups, as subtree-scoped statements.
 *   3. Policy statements attached to the user/groups/roles (so an admin can write
 *      a broad drive policy), which may allow or explicitly deny.
 * A user's global role permissions (e.g. "drive.read") are deliberately excluded
 * here: they gate whether Drive is usable at all, not which connections a user
 * may read, so cross-connection isolation holds by default.
 */

import {
    DRIVE_ACTIONS,
    driveResource,
    driveResourcePatterns,
    evaluateStatements,
    normalizeRelPath,
    type AuthzDecision,
    type DriveAction,
    type PolicyStatement
} from "@polaris/core";
import { getUserGroupIds, resolvePrincipalPolicyStatements } from "@polaris/auth";
import { prisma } from "@polaris/db";

/** A stored ACL grant, with its verbs decoded. */
export interface DriveAclRow {
    id: string;
    path: string;
    principalType: string;
    principalId: string;
    actions: DriveAction[];
    effect: "allow" | "deny";
    /** When it stops applying; null is indefinite. */
    expiresAt: Date | null;
    /** What the sender wanted the recipient to know. */
    note: string | null;
}

/**
 * The rows that still apply, for a set of principals.
 *
 * A grant with a date on it is over when that date passes: nothing sweeps the
 * table, so every read has to say so. Written once here because getting it wrong
 * anywhere means a share that was given until Friday still opens on Monday.
 */
export function liveGrants(principals: Array<{ principalType: string; principalId: string }>) {
    return {
        OR: principals,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }]
    };
}

/** Decode a stored actions JSON string into known Drive verbs (drops unknowns). */
function parseActions(raw: string): DriveAction[] {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is DriveAction =>
            typeof value === "string" && (DRIVE_ACTIONS as readonly string[]).includes(value)
        );
    } catch {
        return [];
    }
}

/** Every ACL grant defined on a connection, for the owner's management UI. */
export async function listDriveAcls(connectionId: string): Promise<DriveAclRow[]> {
    const rows = await prisma.driveAcl.findMany({
        where: { connectionId },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            path: true,
            principalType: true,
            principalId: true,
            actions: true,
            effect: true,
            expiresAt: true,
            note: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        path: row.path,
        principalType: row.principalType,
        principalId: row.principalId,
        actions: parseActions(row.actions),
        effect: row.effect === "deny" ? "deny" : "allow",
        expiresAt: row.expiresAt,
        note: row.note
    }));
}

/** Create or replace a grant for one (path, principal) pair on a connection. */
export async function setDriveAcl(input: {
    connectionId: string;
    path: string;
    principalType: "user" | "group";
    principalId: string;
    actions: DriveAction[];
    effect: "allow" | "deny";
    createdById: string;
    /** When it should stop applying. Null (or absent) is indefinite. */
    expiresAt?: Date | null;
    /** A line for the recipient, shown beside the item in their shared list. */
    note?: string | null;
}): Promise<void> {
    const path = normalizeRelPath(input.path);
    const actions = input.actions.filter((action) => (DRIVE_ACTIONS as readonly string[]).includes(action));
    if (actions.length === 0) throw new Error("Select at least one action");
    // One grant per (connection, path, principal): replace any existing row rather
    // than stacking duplicates that would be confusing to reason about.
    const existing = await prisma.driveAcl.findFirst({
        where: {
            connectionId: input.connectionId,
            path,
            principalType: input.principalType,
            principalId: input.principalId
        },
        select: { id: true }
    });
    const data = {
        connectionId: input.connectionId,
        path,
        principalType: input.principalType,
        principalId: input.principalId,
        actions: JSON.stringify(actions),
        effect: input.effect,
        createdById: input.createdById,
        expiresAt: input.expiresAt ?? null,
        note: input.note?.trim() || null
    };
    if (existing) {
        await prisma.driveAcl.update({ where: { id: existing.id }, data });
    } else {
        await prisma.driveAcl.create({ data });
    }
}

/** Remove an ACL grant, scoped to its connection. */
export async function removeDriveAcl(connectionId: string, aclId: string): Promise<void> {
    await prisma.driveAcl.deleteMany({ where: { id: aclId, connectionId } });
}

/** Compile a user's ACL rows on a connection into engine statements. */
async function aclStatements(userId: string, connectionId: string): Promise<PolicyStatement[]> {
    const groupIds = await getUserGroupIds(userId);
    const principals = [
        { principalType: "user", principalId: userId },
        ...groupIds.map((id) => ({ principalType: "group", principalId: id }))
    ];
    const rows = await prisma.driveAcl.findMany({
        where: { connectionId, ...liveGrants(principals) },
        select: { path: true, actions: true, effect: true }
    });
    return rows.map((row) => ({
        effect: row.effect === "deny" ? ("deny" as const) : ("allow" as const),
        actions: parseActions(row.actions).map((action) => `drive.${action}`),
        resources: driveResourcePatterns(connectionId, row.path)
    }));
}

/**
 * Resolve whether a user may perform a Drive verb on a path in a connection.
 * Admins and the connection owner are always allowed; everyone else is decided by
 * ACL and policy statements with deny-by-default and explicit-deny-override.
 */
export async function resolveDriveDecision(
    userId: string,
    connectionId: string,
    path: string,
    action: DriveAction
): Promise<AuthzDecision> {
    const [user, connection] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.storageConnection.findUnique({ where: { id: connectionId }, select: { ownerId: true } })
    ]);
    if (!connection) return "implicit-deny";
    if (user?.isAdmin || connection.ownerId === userId) return "allow";

    const [acls, policies] = await Promise.all([
        aclStatements(userId, connectionId),
        resolvePrincipalPolicyStatements(userId)
    ]);
    return evaluateStatements(
        [...acls, ...policies],
        `drive.${action}`,
        driveResource(connectionId, normalizeRelPath(path))
    );
}

/** True if the user may perform the verb (convenience over resolveDriveDecision). */
export async function canAccessDrive(
    userId: string,
    connectionId: string,
    path: string,
    action: DriveAction
): Promise<boolean> {
    return (await resolveDriveDecision(userId, connectionId, path, action)) === "allow";
}

/**
 * The shallowest path a user was actually given on a connection, or null.
 *
 * What somebody was given is a folder, not a storage: opening its root would
 * refuse them, and a location in the rail that refuses whoever clicks it is
 * worse than no location at all. This is where such a location opens.
 */
export async function grantedRootPath(
    userId: string,
    connectionId: string
): Promise<string | null> {
    const groupIds = await getUserGroupIds(userId);
    const principals = [
        { principalType: "user", principalId: userId },
        ...groupIds.map((id) => ({ principalType: "group", principalId: id }))
    ];
    const rows = await prisma.driveAcl.findMany({
        where: { connectionId, effect: "allow", ...liveGrants(principals) },
        select: { path: true }
    });
    if (rows.length === 0) return null;
    // Shallowest wins: somebody holding both a folder and something inside it
    // should land on the folder.
    return rows
        .map((row) => row.path)
        .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0] ?? null;
}

/** Connection ids (beyond those they own) a user has an allow ACL on. */
export async function grantedConnectionIds(userId: string): Promise<string[]> {
    const groupIds = await getUserGroupIds(userId);
    const principals = [
        { principalType: "user", principalId: userId },
        ...groupIds.map((id) => ({ principalType: "group", principalId: id }))
    ];
    const rows = await prisma.driveAcl.findMany({
        where: { effect: "allow", ...liveGrants(principals) },
        select: { connectionId: true }
    });
    return [...new Set(rows.map((row) => row.connectionId))];
}
