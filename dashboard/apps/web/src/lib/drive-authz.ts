/**
 * The single choke point for Drive resource access. Every server action and route
 * that touches a connection's files runs through `authorizeDrive` (or the
 * driver-returning `requireDriveDriver`), so authorization and the password gate
 * are enforced in exactly one place instead of being re-derived per call site.
 *
 * Two independent checks must both pass:
 *   1. Resource authorization. The owner of a connection may act on it subject to
 *      the same global capability the app has always required (so a viewer who
 *      owns a connection stays read-only); a non-owner needs an explicit ACL or
 *      policy allow. Admins bypass this check. Explicit deny always wins.
 *   2. The access gate. If the path (or an ancestor) is locked, a valid unlock
 *      cookie must be present. This applies even to the owner - that is the point
 *      of a password gate - but lock management uses `skipLock` so an owner is
 *      never shut out of removing their own lock.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import type { DriveAction, Permission } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { CONTAINER_CONNECTION_PREFIX, getDriverForConnection } from "@/lib/storage-service";
import { canAccessDrive } from "@/lib/drive-acl-service";
import {
    findLockForPath,
    lockUnlockCookie,
    verifyLockUnlock,
    type LockInfo
} from "@/lib/access-lock-service";
import type { StorageDriver } from "@polaris/storage";

/** The global capability an owner must hold to perform each Drive verb. */
const OWNER_CAPABILITY: Record<DriveAction, Permission> = {
    read: "drive.read",
    download: "drive.read",
    write: "drive.write",
    rename: "drive.write",
    copy: "drive.write",
    delete: "drive.delete"
};

/** Raised when a user is not authorized for a Drive resource. Maps to 403. */
export class DriveAccessError extends Error {
    public constructor() {
        super("You do not have access to this item");
        this.name = "DriveAccessError";
    }
}

/** Raised when a path is gated by an access lock that has not been unlocked. Maps to 423. */
export class DriveLockedError extends Error {
    public readonly lockId: string;
    public readonly lockPath: string;
    public constructor(lock: LockInfo) {
        super("This location is locked");
        this.name = "DriveLockedError";
        this.lockId = lock.id;
        this.lockPath = lock.path;
    }
}

/** The lock guarding a path if it is currently gated (not unlocked), else null. */
async function lockedGate(connectionId: string, path: string): Promise<LockInfo | null> {
    const lock = await findLockForPath(connectionId, path);
    if (!lock) return null;
    const store = await cookies();
    const value = store.get(lockUnlockCookie(lock.id))?.value;
    return verifyLockUnlock(lock.id, value, loadEnv().POLARIS_AUTH_SECRET) ? null : lock;
}

/**
 * Assert a user may perform a Drive verb on a path, throwing DriveAccessError or
 * DriveLockedError otherwise. Pass `skipLock` for lock-management operations,
 * which must run even while the path is locked.
 */
export async function authorizeDrive(
    userId: string,
    connectionId: string,
    path: string,
    action: DriveAction,
    opts?: { skipLock?: boolean }
): Promise<void> {
    // A container source is a deployed service's filesystem, owned by whoever owns
    // the app's project. It has no StorageConnection row, ACLs, or access locks:
    // ownership (or admin) plus the global Drive capability is the whole gate.
    if (connectionId.startsWith(CONTAINER_CONNECTION_PREFIX)) {
        const appId = connectionId.slice(CONTAINER_CONNECTION_PREFIX.length);
        const [user, app] = await Promise.all([
            prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
            prisma.application.findFirst({
                where: { id: appId },
                select: { environment: { select: { project: { select: { ownerId: true } } } } }
            })
        ]);
        if (!app) throw new DriveAccessError();
        if (!user?.isAdmin) {
            if (app.environment.project.ownerId !== userId) throw new DriveAccessError();
            if (!(await userHasPermission(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
        }
        return;
    }

    const [user, connection] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.storageConnection.findUnique({ where: { id: connectionId }, select: { ownerId: true } })
    ]);
    if (!connection) throw new DriveAccessError();

    if (!user?.isAdmin) {
        if (connection.ownerId === userId) {
            // Owner: gated by the coarse global capability, as the app always has.
            if (!(await userHasPermission(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
        } else if (!(await canAccessDrive(userId, connectionId, path, action))) {
            // Non-owner: needs an explicit ACL/policy allow for this resource.
            throw new DriveAccessError();
        }
    }

    if (!opts?.skipLock) {
        const gate = await lockedGate(connectionId, path);
        if (gate) throw new DriveLockedError(gate);
    }
}

/** Authorize, then return a connected driver for the connection. */
export async function requireDriveDriver(
    userId: string,
    connectionId: string,
    path: string,
    action: DriveAction,
    opts?: { skipLock?: boolean }
): Promise<StorageDriver> {
    await authorizeDrive(userId, connectionId, path, action, opts);
    return getDriverForConnection(connectionId);
}
