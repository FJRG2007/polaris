/**
 * A badge that clears once somebody has opened the screen it points at.
 *
 * Management's badge counts things a person has to act on: an update nothing
 * will install by itself, reports and cases nobody has settled. Opening the
 * Update screen and seeing the update is being told; a badge that stays after
 * that repeats something already known, on every screen, until the work is
 * done. So by default opening the screen marks what is there as seen, and only
 * something newer - another build, another report - raises the badge again.
 *
 * Some people want the opposite, a badge that stays as a to-do until the work
 * is done, and that is one switch under Notifications (`badgesClearOnVisit`).
 * The marks are written either way, so turning it back on does not bring back
 * a badge for something the reader already looked at.
 */

import { prisma } from "@polaris/db";

/** The screens whose badge a visit clears, and the mark each one keeps. */
export const BADGE_SCREENS = {
    "/admin/settings": "admin.update",
    "/admin/safety": "admin.safety"
} as const;

export type BadgeScreen = keyof typeof BADGE_SCREENS;
export type BadgeKey = (typeof BADGE_SCREENS)[BadgeScreen];

export function isBadgeScreen(value: unknown): value is BadgeScreen {
    return typeof value === "string" && Object.hasOwn(BADGE_SCREENS, value);
}

/** Opening a screen clears its badge unless the account said otherwise. */
export function clearsOnVisit(stored: boolean | null | undefined): boolean {
    return stored ?? true;
}

/** What one account has seen, when opening a screen clears its badge; null when
 *  the account keeps badges until the work is done. */
export async function seenMarks(
    userId: string
): Promise<ReadonlyMap<BadgeKey, string> | null> {
    const [user, rows] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { badgesClearOnVisit: true } }),
        prisma.userBadgeSeen.findMany({ where: { userId }, select: { key: true, mark: true } })
    ]);
    if (!clearsOnVisit(user?.badgesClearOnVisit)) return null;
    return new Map(rows.map((row) => [row.key as BadgeKey, row.mark]));
}

/** Record that an account has seen what a screen's badge is about. `mark` is
 *  the announced build for the update, and now for a queue. */
export async function markSeen(userId: string, key: BadgeKey, mark: string): Promise<void> {
    await prisma.userBadgeSeen.upsert({
        where: { userId_key: { userId, key } },
        update: { mark },
        create: { userId, key, mark }
    });
}
