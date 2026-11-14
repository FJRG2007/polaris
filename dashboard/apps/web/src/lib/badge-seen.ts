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
    "/admin/updates": "admin.update",
    "/admin/safety": "admin.safety"
} as const;

export type BadgeScreen = keyof typeof BADGE_SCREENS;
export type BadgeKey = (typeof BADGE_SCREENS)[BadgeScreen];

/**
 * What somebody said they have seen from the app menu, by the Management entry
 * it was said about.
 *
 * Kept apart from the visit marks above because it is a different act: a visit
 * clears the badge only for an account that lets it (`badgesClearOnVisit`),
 * while pressing "mark seen" is the account saying so in as many words, and is
 * honoured whichever way that switch is set. The same table and the same kind
 * of mark - the build for the update, a moment for a queue - so a newer build or
 * a newer report counts again exactly as it does after a visit.
 */
export const DISMISSED_KEYS = {
    reports: "dismissed.admin.reports",
    cases: "dismissed.admin.cases",
    update: "dismissed.admin.update",
    apis: "dismissed.admin.apis"
} as const;

export type DismissedKey = (typeof DISMISSED_KEYS)[keyof typeof DISMISSED_KEYS];

/**
 * How far somebody has cleared an app's badge from the app list, by app.
 *
 * Marking an app read from the app list is the phone's gesture: the number on
 * the icon goes, and what is inside the app does not. The conversations and the
 * mail behind it are still unread when the app is opened, and stay so until
 * they are opened there. So the mark is a moment, kept here and nowhere in the
 * app's own data: the badge counts only what arrived after it, and anything new
 * raises it again. An account that never marked keeps the count it always had.
 */
export const APP_BADGE_KEYS = {
    chat: "cleared.chat",
    mail: "cleared.mail"
} as const;

export type BadgeClearedApp = keyof typeof APP_BADGE_KEYS;
export type AppBadgeKey = (typeof APP_BADGE_KEYS)[BadgeClearedApp];

export function isBadgeScreen(value: unknown): value is BadgeScreen {
    return typeof value === "string" && Object.hasOwn(BADGE_SCREENS, value);
}

/** Opening a screen clears its badge unless the account said otherwise. */
export function clearsOnVisit(stored: boolean | null | undefined): boolean {
    return stored ?? true;
}

/** Every mark one account keeps: what its visits saw - null when the account
 *  keeps badges until the work is done - and what it marked seen from the menu,
 *  which counts either way. One read of each table. */
export async function badgeMarks(userId: string): Promise<{
    readonly seen: ReadonlyMap<string, string> | null;
    readonly dismissed: ReadonlyMap<string, string>;
}> {
    const [user, rows] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { badgesClearOnVisit: true } }),
        prisma.userBadgeSeen.findMany({ where: { userId }, select: { key: true, mark: true } })
    ]);
    const all = new Map(rows.map((row) => [row.key, row.mark]));
    return { seen: clearsOnVisit(user?.badgesClearOnVisit) ? all : null, dismissed: all };
}

/** What one account has seen, when opening a screen clears its badge; null when
 *  the account keeps badges until the work is done. */
export async function seenMarks(userId: string): Promise<ReadonlyMap<string, string> | null> {
    return (await badgeMarks(userId)).seen;
}

/** Record that an account has seen what a screen's badge is about. `mark` is
 *  the announced build for the update, and now for a queue. */
export async function markSeen(
    userId: string,
    key: BadgeKey | DismissedKey | AppBadgeKey,
    mark: string
): Promise<void> {
    await prisma.userBadgeSeen.upsert({
        where: { userId_key: { userId, key } },
        update: { mark },
        create: { userId, key, mark }
    });
}

/** The later of an item's own read mark and an app's badge mark: what the badge
 *  counts from. Either may be missing. */
export function laterMark(read: Date | null | undefined, cleared: Date | null): Date | null {
    if (!read) return cleared;
    if (!cleared) return read;
    return read.getTime() >= cleared.getTime() ? read : cleared;
}

/** When an account last cleared an app's badge from the app list, or null if it
 *  never has - which counts everything, exactly as before the mark existed. */
export async function badgeClearedAt(userId: string, app: BadgeClearedApp): Promise<Date | null> {
    const row = await prisma.userBadgeSeen.findUnique({
        where: { userId_key: { userId, key: APP_BADGE_KEYS[app] } },
        select: { mark: true }
    });
    if (!row) return null;
    const at = new Date(row.mark);
    return Number.isNaN(at.getTime()) ? null : at;
}

/** Clear an app's badge as of `at`: everything up to then stops counting on it,
 *  and nothing inside the app changes. */
export async function clearAppBadge(
    userId: string,
    app: BadgeClearedApp,
    at: Date = new Date()
): Promise<void> {
    await markSeen(userId, APP_BADGE_KEYS[app], at.toISOString());
}
