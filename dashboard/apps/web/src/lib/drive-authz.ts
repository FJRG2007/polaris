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
import type { StorageDriver } from "@polaris/storage";
import type { DriveAction, Permission } from "@polaris/core";
import { effectiveCan, effectiveIsAdmin } from "@/lib/effective-access";
import { canAccessDrive, resolveDriveDecision } from "@/lib/drive-acl-service";
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
            // An organization's Drive, which belongs to no account at all. The
            // rules are asked first and asked always: they are what narrows the
            // roster to a folder only Legal opens, and a deny they carry has to
            // win here as it does everywhere else - consulting them only after
            // the roster has refused makes every deny written against a member
            // silently do nothing.
            const rules = await resolveDriveDecision(userId, connectionId, path, action);
            if (rules === "deny") throw new DriveAccessError();
            if (rules !== "allow" && !(await allowedInOrgDrive(userId, connection.orgId, action))) {
                // An allow is still the other way in, for somebody the roster
                // does not reach at all: a contractor given one directory.
                throw new DriveAccessError();
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
 *
 * Being answered by `resolveOrgAccess` is not the same question as being on the
 * roster, and the difference is a shelf full of company documents. A successor
 * the owner named is answered with a membership holding nothing at all so that
 * the one screen they may open has something to resolve; `org.read` is what
 * every roster role carries and what that one deliberately does not, so it is
 * what this asks.
 */
async function allowedInOrgDrive(
    userId: string,
    orgId: string,
    action: DriveAction
): Promise<boolean> {
    const { resolveOrgAccess, orgCan } = await import("@/lib/orgs/org-service");
    const access = await resolveOrgAccess({ id: userId, isAdmin: false }, orgId);
    if (!access) return false;
    if (!access.isOwner && !orgCan(access, "org.read")) return false;
    if (action === "read" || action === "download") return true;
    return orgCan(access, "drive.manage");
}

/**
 * Whether this account runs a connection's own rules: its access grants, its
 * locks, what is shared out of it.
 *
 * Ownership answers it for a storage somebody connected and for their own drive.
 * An organization's shelf is owned by no account, so the question there is the
 * organization's own - the same permission that lets somebody change what is on
 * it. Without this the company shelf offers Manage access and Share to every
 * member and then refuses all of them, and only an instance administrator can
 * write the per-folder rule that narrows a company's Drive.
 */
export async function canManageDriveConnection(
    userId: string,
    isAdmin: boolean,
    connectionId: string
): Promise<boolean> {
    if (isAdmin) return true;
    const connection = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { ownerId: true, orgId: true }
    });
    if (!connection) return false;
    if (connection.ownerId === userId) return true;
    if (!connection.orgId) return false;
    const { resolveOrgAccess, orgCan } = await import("@/lib/orgs/org-service");
    const access = await resolveOrgAccess({ id: userId, isAdmin: false }, connection.orgId);
    return orgCan(access, "drive.manage");
}

/**
 * Whether this account may see that a path is there, as a question rather than a
 * refusal.
 *
 * For the screens that list somebody's own things back to them - what they
 * starred, what they were given - where a path they may not open is not an error
 * to raise but a row to leave out. The same resolution as every read, so a deny
 * written on one folder of a company shelf holds on those screens too rather
 * than being a rule only the browser honours.
 *
 * The lock gate is deliberately skipped: a locked folder is one whose password
 * is asked for on the way in, not one whose existence is a secret from the
 * person who starred it.
 */
export async function mayReadDrive(
    userId: string,
    connectionId: string,
    path: string
): Promise<boolean> {
    try {
        await authorizeDrive(userId, connectionId, path, "read", { skipLock: true });
        return true;
    } catch (caught) {
        if (caught instanceof DriveAccessError) return false;
        throw caught;
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
