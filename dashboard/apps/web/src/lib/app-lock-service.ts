/**
 * Where PIN locks on apps are kept and checked. Server-only.
 *
 * The locks are the account's (`UserSecurity.lockedApps`); the unlocks are the
 * browser session's (`SessionState.appUnlocks`), so signing in elsewhere never
 * inherits an unlock, and signing out drops them all. Locks are only enforced
 * while the account has a PIN: without one there is nothing to unlock with.
 */

import { prisma } from "@polaris/db";
import * as locks from "@/lib/app-locks";

export interface AppLocks {
    readonly locked: string[];
    readonly hasPin: boolean;
}

export async function getAppLocks(userId: string): Promise<AppLocks> {
    const row = await prisma.userSecurity.findUnique({
        where: { userId },
        select: { lockedApps: true, pinHash: true }
    });
    return {
        locked: (row?.lockedApps ?? []).filter(locks.lockableApp),
        hasPin: Boolean(row?.pinHash)
    };
}

/** Lock or unlock an app for this account. Refused (false) without a PIN. */
export async function setAppLock(userId: string, appId: string, locked: boolean): Promise<boolean> {
    if (locked && !locks.lockableApp(appId)) return false;
    const current = await getAppLocks(userId);
    if (locked && !current.hasPin) return false;
    const next = locked
        ? [...new Set([...current.locked, appId])]
        : current.locked.filter((id) => id !== appId);
    await prisma.userSecurity.upsert({
        where: { userId },
        create: { userId, lockedApps: next },
        update: { lockedApps: next }
    });
    return true;
}

/**
 * The lock screen's address when `pathname` is a locked app this session has
 * not unlocked recently, else null. A fresh unlock is kept fresh here, written
 * back at most once a minute.
 */
export async function appLockRedirect(
    userId: string,
    sessionId: string,
    pathname: string,
    now = Date.now()
): Promise<string | null> {
    const { locked, hasPin } = await getAppLocks(userId);
    if (!hasPin) return null;
    const appId = locks.lockedAppForPath(pathname, locked);
    if (!appId) return null;
    const state = await prisma.sessionState.findUnique({
        where: { sessionId },
        select: { appUnlocks: true }
    });
    const unlocks = locks.readUnlocks(state?.appUnlocks);
    if (!locks.unlockFresh(unlocks, appId, now)) return locks.appLockHref(appId, pathname);
    if (now - unlocks[appId]! >= locks.APP_UNLOCK_TOUCH_MS) {
        await prisma.sessionState.updateMany({
            where: { sessionId },
            data: { appUnlocks: { ...unlocks, [appId]: now } }
        });
    }
    return null;
}

/** Record that this session unlocked an app now. */
export async function recordAppUnlock(sessionId: string, appId: string, now = Date.now()): Promise<void> {
    const state = await prisma.sessionState.findUnique({
        where: { sessionId },
        select: { appUnlocks: true }
    });
    const unlocks = locks.readUnlocks(state?.appUnlocks);
    // Expired entries go on every write, so the column never grows past the
    // apps unlocked in the last window.
    const kept = Object.fromEntries(
        Object.entries(unlocks).filter(([id]) => locks.unlockFresh(unlocks, id, now))
    );
    await prisma.sessionState.updateMany({
        where: { sessionId },
        data: { appUnlocks: { ...kept, [appId]: now } }
    });
}
