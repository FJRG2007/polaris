/**
 * Access locks - the "Polaris access gate". A lock puts a password in front of a
 * Drive path: listing, opening, or downloading anything at or under it first
 * requires unlocking with the password. The unlock is remembered in a signed,
 * per-lock session cookie (the same forge-proof HMAC scheme the share and drop
 * unlock cookies use), so a user unlocks once per session rather than per file.
 *
 * The password is stretched with the same slow, salted KDF as share/link
 * passwords (scrypt) rather than a new dependency - it is the same threat (a
 * low-entropy human secret at rest) and the same trusted primitive. Locking is a
 * second factor layered on top of ACLs: even a path's owner must unlock to read
 * it, though an owner/admin can always remove the lock outright.
 */

import { isUuid } from "./uuid";
import { prisma } from "@polaris/db";
import { normalizeRelPath } from "@polaris/core";
import { signUnlock, unlockCookieName, verifyUnlock } from "@/lib/link-guards";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";

/** The unlock-cookie namespace access locks are signed under. */
const LOCK_LINK_SCOPE = "lock";

/** A lock's identity and the path it guards. */
export interface LockInfo {
    id: string;
    path: string;
}

/** Every lock defined on a connection, for the management UI. */
export async function listLocks(connectionId: string): Promise<LockInfo[]> {
    // A non-UUID source (an ephemeral `container:<id>` connection) can hold no locks.
    if (!isUuid(connectionId)) return [];
    return prisma.accessLock.findMany({
        where: { connectionId },
        orderBy: { path: "asc" },
        select: { id: true, path: true }
    });
}

/**
 * The nearest lock at or above a path within a connection, or null if the path is
 * not gated. "Nearest" means the deepest matching ancestor, so a lock on a
 * subfolder takes precedence over one on its parent.
 */
export async function findLockForPath(connectionId: string, path: string): Promise<LockInfo | null> {
    if (!isUuid(connectionId)) return null;
    const locks = await prisma.accessLock.findMany({
        where: { connectionId },
        select: { id: true, path: true }
    });
    if (locks.length === 0) return null;
    const target = normalizeRelPath(path);
    let best: LockInfo | null = null;
    for (const lock of locks) {
        const covers = lock.path === "" || target === lock.path || target.startsWith(`${lock.path}/`);
        if (covers && (!best || lock.path.length > best.path.length)) best = lock;
    }
    return best;
}

/** Create or replace the lock on a path (one lock per path per connection). */
export async function createLock(
    connectionId: string,
    path: string,
    password: string,
    createdById: string
): Promise<void> {
    if (!password) throw new Error("Enter a password for the lock");
    const target = normalizeRelPath(path);
    const passwordHash = await hashLinkPassword(password);
    await prisma.accessLock.upsert({
        where: { connectionId_path: { connectionId, path: target } },
        create: { connectionId, path: target, passwordHash, createdById },
        update: { passwordHash, createdById }
    });
}

/** Remove a lock, scoped to its connection so an id alone cannot target another. */
export async function removeLock(connectionId: string, lockId: string): Promise<void> {
    await prisma.accessLock.deleteMany({ where: { id: lockId, connectionId } });
}

/** Constant-time check of a presented password against a lock's stored hash. */
export async function verifyLockPassword(lockId: string, presented: string): Promise<boolean> {
    const lock = await prisma.accessLock.findUnique({ where: { id: lockId }, select: { passwordHash: true } });
    if (!lock) return false;
    return verifyLinkPassword(presented, lock.passwordHash);
}

/** Cookie name recording that a lock has been unlocked this session. */
export function lockUnlockCookie(lockId: string): string {
    return unlockCookieName(LOCK_LINK_SCOPE, lockId);
}

/** Sign an unlock marker so the "lock solved" cookie cannot be forged. */
export function signLockUnlock(lockId: string, secret: string): string {
    return signUnlock(LOCK_LINK_SCOPE, lockId, secret);
}

/** Constant-time check of an unlock cookie against the expected signature. */
export function verifyLockUnlock(lockId: string, value: string | undefined, secret: string): boolean {
    return verifyUnlock(LOCK_LINK_SCOPE, lockId, value, secret);
}
