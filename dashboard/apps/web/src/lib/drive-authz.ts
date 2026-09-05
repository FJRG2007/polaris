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
import {
    CONTAINER_CONNECTION_PREFIX,
    getDriverForConnection,
    HOST_CONNECTION_PREFIX
} from "@/lib/storage-service";
import {
    connectionLocks,
    coveringLock,
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

/**
 * What a reader may actually do here.
 *
 * The gate below is the truth and stays the truth: nothing on a screen is allowed
 * to decide whether a write happens. But a screen that offers New folder, Rename
 * and Delete to somebody with read-only access is a screen that lies four times
 * and then shows an error - which reads as Polaris being broken rather than as a
 * permission they never had. The affordance and the refusal have to agree.
 *
 * So the same function that guards the write answers the question, and the answer
 * is what the controls are drawn from. Asked once per screen against the folder
 * being looked at, not once per row: it is a handful of queries, and a listing of
 * two hundred files would otherwise be six hundred.
 *
 * `skipLock` throughout, deliberately. A locked folder is a folder somebody has
 * not unlocked yet, and greying out its buttons would tell them their account
 * cannot do this when the answer is that the folder is closed - the unlock screen
 * says that far better.
 */
export interface DriveAbilities {
    readonly read: boolean;
    readonly write: boolean;
    readonly remove: boolean;
}

export async function driveAbilities(
    userId: string,
    connectionId: string,
    path: string
): Promise<DriveAbilities> {
    const allowed = async (action: DriveAction): Promise<boolean> => {
        try {
            await authorizeDrive(userId, connectionId, path, action, { skipLock: true });
            return true;
        } catch {
            // A refusal is the answer, not a failure. Anything else thrown in
            // there - a storage that will not answer - is also a "no" as far as
            // drawing a button goes, and the write itself still reports properly.
            return false;
        }
    };
    const [read, write, remove] = await Promise.all([
        allowed("read"),
        allowed("write"),
        allowed("delete")
    ]);
    return { read, write, remove };
}

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
    const gate = await lockGate(connectionId);
    return gate(path);
}

/**
 * The lock question for a connection, asked once and answered many times.
 *
 * Both halves of it are per connection rather than per path - the locks on it,
 * and which of them this browser has already unlocked - so a list of three
 * thousand paths that each read the lock table and the cookie jar was reading
 * the same two answers three thousand times.
 *
 * The matching itself is `findLockForPath`'s rule, kept here in one place: the
 * deepest lock whose path covers the target, with an empty path standing for the
 * whole connection.
 */
async function lockGate(connectionId: string): Promise<(path: string) => LockInfo | null> {
    const locks = await connectionLocks(connectionId);
    if (locks.length === 0) return () => null;
    const store = await cookies();
    const secret = loadEnv().POLARIS_AUTH_SECRET;
    // Which locks this browser has already answered, worked out once: verifying a
    // signature is cheap, and doing it per path per lock is not.
    const open = new Set(
        locks
            .filter((lock) => verifyLockUnlock(lock.id, store.get(lockUnlockCookie(lock.id))?.value, secret))
            .map((lock) => lock.id)
    );
    return (path: string) => {
        const lock = coveringLock(locks, path);
        return lock && !open.has(lock.id) ? lock : null;
    };
}

/**
 * What is left to decide once the reader and the connection are known.
 *
 * Splitting this out is what makes a list of paths affordable. Nearly everything
 * `authorizeDrive` asks - who is this, do they own it, are they an administrator,
 * do they hold the capability - has the same answer for every path in one call,
 * and asking it per path is how moving three thousand files to the trash became
 * fourteen thousand queries before the first byte moved. What genuinely varies
 * with the path is here, and only here.
 *
 * It is one description used by both entry points rather than two copies of the
 * rules. A second implementation of an access check is a second implementation
 * that can disagree with the first, and the one that is wrong is whichever
 * nobody is reading.
 */
type PathCheck =
    /** Nothing further to ask: an administrator, an owner who holds the
     *  capability, or a source with no per-path rules at all. */
    | { readonly kind: "settled" }
    /** An organization's Drive: the folder rules decide, with membership as the
     *  fallback when they say nothing. */
    | { readonly kind: "org"; readonly memberAllowed: boolean }
    /** Somebody who is not the owner: they need an explicit allow for the path. */
    | { readonly kind: "acl" };

/**
 * Who this is and what this connection allows them, before any path is named.
 *
 * Throws exactly where `authorizeDrive` always threw: a connection that is not
 * there, an owner without the capability. What it does not do is look at a path.
 */
async function resolveReader(
    userId: string,
    connectionId: string,
    action: DriveAction
): Promise<PathCheck> {
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
        return { kind: "settled" };
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
        return { kind: "settled" };
    }

    const [user, connection] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.storageConnection.findUnique({
            where: { id: connectionId },
            select: { ownerId: true, orgId: true }
        })
    ]);
    if (!connection) throw new DriveAccessError();

    if (await effectiveIsAdmin(userId, user?.isAdmin === true)) return { kind: "settled" };

    if (connection.orgId) {
        // An organization's Drive, which belongs to no account at all. The rules
        // are asked first and asked always - they are what narrows the roster to
        // a folder only Legal opens - so what membership answers is carried
        // alongside them rather than instead of them.
        return {
            kind: "org",
            memberAllowed: await allowedInOrgDrive(userId, connection.orgId, action)
        };
    }
    if (connection.ownerId === userId) {
        // Owner: gated by the coarse global capability, as the app always has.
        if (!(await effectiveCan(userId, OWNER_CAPABILITY[action]))) throw new DriveAccessError();
        return { kind: "settled" };
    }
    // Non-owner: needs an explicit ACL/policy allow, and that is per path.
    return { kind: "acl" };
}

/** The part of the check that is about this path, given what the reader is. */
async function checkPath(
    check: PathCheck,
    userId: string,
    connectionId: string,
    path: string,
    action: DriveAction
): Promise<void> {
    if (check.kind === "org") {
        const rules = await resolveDriveDecision(userId, connectionId, path, action);
        if (rules === "deny") throw new DriveAccessError();
        // An allow is still the other way in, for somebody the roster does not
        // reach at all: a contractor given one directory.
        if (rules !== "allow" && !check.memberAllowed) throw new DriveAccessError();
        return;
    }
    if (check.kind === "acl" && !(await canAccessDrive(userId, connectionId, path, action))) {
        throw new DriveAccessError();
    }
}

/**
 * Assert a user may perform a Drive verb on every one of these paths.
 *
 * For the jobs. Moving three thousand files to the trash is three thousand
 * authorizations, and each one used to re-read the account, the connection, the
 * capability and the entire lock table - so the button sat there for a minute
 * before a single file moved, which is the cost the job was written to remove.
 * Here the reader is resolved once and the locks are read once, and what a path
 * costs is the check that is genuinely about that path: for the common case -
 * your own connection, no locks - nothing at all.
 *
 * Every path, not a sample of them: a list somebody may not have read to the end
 * has its one untouchable file in the middle, and that is exactly what this is
 * for.
 */
export async function authorizeDrivePaths(
    userId: string,
    connectionId: string,
    paths: readonly string[],
    action: DriveAction
): Promise<void> {
    if (paths.length === 0) return;
    const check = await resolveReader(userId, connectionId, action);
    // The lock table and the cookie jar do not change between two paths of one
    // request, so they are read once and matched in memory.
    const gate = await lockGate(connectionId);
    for (const path of paths) {
        await checkPath(check, userId, connectionId, path, action);
        const locked = gate(path);
        if (locked) throw new DriveLockedError(locked);
    }
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
    const check = await resolveReader(userId, connectionId, action);
    await checkPath(check, userId, connectionId, path, action);
    if (!opts?.skipLock) {
        const locked = await lockedGate(connectionId, path);
        if (locked) throw new DriveLockedError(locked);
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
