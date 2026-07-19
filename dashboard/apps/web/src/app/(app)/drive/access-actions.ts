"use server";

/**
 * Drive access-control server actions: managing per-path ACL grants and access
 * locks on a connection, plus unlocking a gated path. Granting access and setting
 * locks are ownership-level operations, so they require the caller to own the
 * connection (or be an admin) - a grantee with a plain read/write ACL cannot
 * re-grant or re-lock. Unlocking only needs the presented password and is rate
 * limited per user and lock so it cannot be brute-forced.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { DRIVE_ACTIONS, normalizeRelPath, type DriveAction } from "@polaris/core";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { authorizeDrive } from "@/lib/drive-authz";
import { listDriveAcls, removeDriveAcl, setDriveAcl } from "@/lib/drive-acl-service";
import {
    createLock,
    listLocks,
    lockUnlockCookie,
    removeLock,
    signLockUnlock,
    verifyLockPassword
} from "@/lib/access-lock-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { recordAudit } from "@/lib/audit-service";
import type { AccessPrincipal, AccessSettings } from "./access-types";

/** Ensure the caller owns the connection (or is an admin). Returns the user id. */
async function requireConnectionManager(connectionId: string): Promise<string> {
    const user = await requireUser();
    if (user.isAdmin) return user.id;
    const owns = await prisma.storageConnection.count({ where: { id: connectionId, ownerId: user.id } });
    if (owns === 0) throw new Error("You do not manage this connection");
    return user.id;
}

/** Load the ACLs, locks, and available principals for a connection's access dialog. */
export async function getAccessSettingsAction(connectionId: string): Promise<AccessSettings> {
    await requireConnectionManager(connectionId);
    const [acls, locks, users, groups] = await Promise.all([
        listDriveAcls(connectionId),
        listLocks(connectionId),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
        prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
    ]);
    const principals: AccessPrincipal[] = [
        ...groups.map((group) => ({ type: "group" as const, id: group.id, label: group.name })),
        ...users.map((user) => ({ type: "user" as const, id: user.id, label: user.name, sublabel: user.email }))
    ];
    return { acls, locks, principals };
}

/** Create or replace an ACL grant on a path. Owner/admin only. */
export async function setDriveAclAction(input: {
    connectionId: string;
    path: string;
    principalType: "user" | "group";
    principalId: string;
    actions: DriveAction[];
    effect: "allow" | "deny";
}): Promise<{ error?: string }> {
    const userId = await requireConnectionManager(input.connectionId);
    const actions = input.actions.filter((action) => (DRIVE_ACTIONS as readonly string[]).includes(action));
    if (actions.length === 0) return { error: "Select at least one action" };
    if (!input.principalId) return { error: "Choose who to grant access to" };
    try {
        await setDriveAcl({ ...input, actions, createdById: userId });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the grant" };
    }
    await recordAudit({
        actorId: userId,
        action: "drive.acl.set",
        targetType: "connection",
        targetId: input.connectionId,
        metadata: { path: normalizeRelPath(input.path), principal: `${input.principalType}:${input.principalId}` }
    });
    revalidatePath("/drive");
    return {};
}

/** Remove an ACL grant. Owner/admin only. */
export async function removeDriveAclAction(connectionId: string, aclId: string): Promise<void> {
    const userId = await requireConnectionManager(connectionId);
    await removeDriveAcl(connectionId, aclId);
    await recordAudit({ actorId: userId, action: "drive.acl.remove", targetType: "connection", targetId: connectionId, metadata: { aclId } });
    revalidatePath("/drive");
}

/** Put a password lock on a path (or replace an existing one). Owner/admin only. */
export async function lockPathAction(
    connectionId: string,
    path: string,
    password: string
): Promise<{ error?: string }> {
    const userId = await requireConnectionManager(connectionId);
    if (!password || password.length < 4) return { error: "Use a password of at least 4 characters" };
    try {
        await createLock(connectionId, path, password, userId);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not set the lock" };
    }
    await recordAudit({ actorId: userId, action: "drive.lock.set", targetType: "connection", targetId: connectionId, metadata: { path: normalizeRelPath(path) } });
    revalidatePath("/drive");
    return {};
}

/** Remove a lock outright. Owner/admin only (no password needed to remove). */
export async function removeLockAction(connectionId: string, lockId: string): Promise<void> {
    const userId = await requireConnectionManager(connectionId);
    await removeLock(connectionId, lockId);
    await recordAudit({ actorId: userId, action: "drive.lock.remove", targetType: "connection", targetId: connectionId, metadata: { lockId } });
    revalidatePath("/drive");
}

/**
 * Unlock a gated path for this session by presenting its password. Any user who
 * can otherwise reach the connection may try; attempts are rate limited per user
 * and lock. On success a signed, session-scoped cookie records the unlock.
 */
export async function unlockPathAction(
    connectionId: string,
    lockId: string,
    password: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    // The user must be able to reach the connection at all, ignoring the lock itself.
    try {
        await authorizeDrive(user.id, connectionId, "", "read", { skipLock: true });
    } catch {
        return { error: "You do not have access to this item" };
    }

    const limitKey = `lock-unlock:${lockId}:${user.id}`;
    if (!(await rateLimit(limitKey, 10, 15 * 60 * 1000)).ok) {
        return { error: "Too many attempts. Please wait a few minutes and try again." };
    }
    if (!(await verifyLockPassword(lockId, password))) {
        return { error: "Incorrect password." };
    }
    await resetRateLimit(limitKey);

    const env = loadEnv();
    const store = await cookies();
    store.set(lockUnlockCookie(lockId), signLockUnlock(lockId, env.POLARIS_AUTH_SECRET), {
        httpOnly: true,
        sameSite: "lax",
        secure: env.POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: 60 * 60 * 12
    });
    revalidatePath("/drive");
    return {};
}
