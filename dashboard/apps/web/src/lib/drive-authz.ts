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

import { prisma } from "@polaris/db";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { effectiveCan, effectiveIsAdmin } from "@/lib/effective-access";
import type { StorageDriver } from "@polaris/storage";
import { canAccessDrive } from "@/lib/drive-acl-service";
import type { DriveAction, Permission } from "@polaris/core";
import { CONTAINER_CONNECTION_PREFIX, getDriverForConnection, HOST_CONNECTION_PREFIX } from "@/lib/storage-service";
import {
    findLockForPath,
    lockUnlockCookie,
    verifyLockUnlock,
    type LockInfo
} from "@/lib/access-lock-service";

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
        if (!(await effectiveIsAdmin(userId, user?.isAdmin === true))) {
            if (app.environment.project.ownerId !== userId) throw new DriveAccessError();
            if (!(await effectiveCan(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
        }
        return;
    }

    // A registered server browsed over SFTP. Like a container source it has no
    // StorageConnection row - its id is `host:<uuid>`, which is not even a value
    // that column can hold - so ownership of the Host plus the global Drive
    // capability is the whole gate, and there are no ACLs or locks to consult.
    if (connectionId.startsWith(HOST_CONNECTION_PREFIX)) {
        const hostId = connectionId.slice(HOST_CONNECTION_PREFIX.length);
        const [user, host] = await Promise.all([
            prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
            prisma.host.findUnique({ where: { id: hostId }, select: { ownerId: true } })
        ]);
        if (!host) throw new DriveAccessError();
        if (!(await effectiveIsAdmin(userId, user?.isAdmin === true))) {
            if (host.ownerId !== userId) throw new DriveAccessError();
            if (!(await effectiveCan(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
        }
        return;
    }

    const [user, connection] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.storageConnection.findUnique({
            where: { id: connectionId },
            select: { ownerId: true, orgId: true }
        })
    ]);
    if (!connection) throw new DriveAccessError();

    if (!(await effectiveIsAdmin(userId, user?.isAdmin === true))) {
        if (connection.orgId) {
            // An organization's Drive, which belongs to no account at all.
            if (!(await allowedInOrgDrive(userId, connection.orgId, action))) {
                // Still one more way in: an access rule may name this person for
                // this folder even when the roster does not reach them, which is
                // how a contractor is given one directory and nothing else.
                if (!(await canAccessDrive(userId, connectionId, path, action))) {
                    throw new DriveAccessError();
                }
            }
        } else if (connection.ownerId === userId) {
            // Owner: gated by the coarse global capability, as the app always has.
            if (!(await effectiveCan(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
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

/**
 * What being in an organization gets somebody in its Drive.
 *
 * Reading follows from the roster and nothing else. Not a permission, and that
 * is deliberate: a permission no existing role holds is a shelf that is empty
 * for every organization that already exists, with no screen anywhere saying
 * why. Being let in is what being a member of the company means.
 *
 * Changing anything is a permission, so one member cannot quietly replace the
 * company's documents, and an organization that wants somebody to be able to
 * grants it on their role. The owner and the seeded administrator hold it
 * already, so an organization is usable the moment its Drive exists.
 *
 * Anything narrower than that - a folder only Legal opens - is the per-folder
 * access rules Drive already has, which sit on top of this.
 */
async function allowedInOrgDrive(
    userId: string,
    orgId: string,
    action: DriveAction
): Promise<boolean> {
    const { resolveOrgAccess, orgCan } = await import("@/lib/orgs/org-service");
    const access = await resolveOrgAccess({ id: userId, isAdmin: false }, orgId);
    if (!access) return false;
    if (action === "read" || action === "download") return true;
    return orgCan(access, "drive.manage");
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
