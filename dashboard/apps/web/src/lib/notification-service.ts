/**
 * In-app notifications: the bell's storage layer. Rows here are written by the
 * dispatcher (see notifications/dispatch), never directly by feature code, so
 * that an alert cannot skip the account's routing rules. The bell and the
 * notifications page read it. Reads and mutations are always scoped to the
 * owning user, so one user can never see or clear another's notifications.
 * Metadata is stored as a JSON string for the same SQLite-portability reason as
 * the rest of the schema.
 */

import { prisma } from "@polaris/db";
import type { NotificationLevel } from "@polaris/core";

export type { NotificationLevel };

/**
 * Who the alert went to. Deliberately coarse: a recipient learns that others
 * were told, never which accounts, so the feed cannot be used to enumerate users.
 * "group" carries the group name in audienceLabel.
 */
export type NotificationAudience = "you" | "admins" | "group" | "everyone";

export interface NotificationInput {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    href?: string | null;
    level?: NotificationLevel;
    audience?: NotificationAudience;
    audienceLabel?: string | null;
    actionRequired?: boolean;
    metadata?: Record<string, unknown> | null;
    /**
     * Write it already read. For an alert about something the recipient is
     * demonstrably looking at: it belongs in the history, but there is nothing
     * left for a badge to tell them. Decided by the dispatcher, never by the
     * feature raising the alert - see notifications/presence.
     */
    read?: boolean;
}

export interface NotificationView {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: NotificationLevel;
    audience: NotificationAudience;
    audienceLabel: string | null;
    actionRequired: boolean;
    read: boolean;
    createdAt: string;
    /**
     * The person the alert is about, when it is about one.
     *
     * A notification that somebody added you is drawn with their face rather
     * than with the grey circle every other alert wears - it is news about a
     * person, and a column of identical outlines is a column nobody scans. The
     * id is already recorded in the alert's own metadata (see the friends
     * service); the name is resolved when the list is read rather than copied
     * into the row, because a notification is not a place to keep a stale copy
     * of somebody's name.
     */
    about: { id: string; name: string } | null;
}

const LEVELS: ReadonlySet<string> = new Set(["info", "success", "warning", "danger"]);
const AUDIENCES: ReadonlySet<string> = new Set(["you", "admins", "group", "everyone"]);

const ROW_FIELDS = {
    id: true,
    type: true,
    title: true,
    body: true,
    href: true,
    level: true,
    audience: true,
    audienceLabel: true,
    actionRequired: true,
    metadata: true,
    readAt: true,
    createdAt: true
} as const;

interface NotificationRow {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: string;
    audience: string;
    audienceLabel: string | null;
    actionRequired: boolean;
    metadata: string | null;
    readAt: Date | null;
    createdAt: Date;
}

function toView(row: NotificationRow, names: ReadonlyMap<string, string>): NotificationView {
    const personId = personIn(row.metadata);
    const name = personId ? names.get(personId) : undefined;
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        href: row.href,
        level: (LEVELS.has(row.level) ? row.level : "info") as NotificationLevel,
        audience: (AUDIENCES.has(row.audience) ? row.audience : "you") as NotificationAudience,
        audienceLabel: row.audienceLabel,
        actionRequired: row.actionRequired,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
        // Only when the account is still there: a face for somebody who has
        // since been deleted would be a request for a picture that cannot exist.
        about: personId && name !== undefined ? { id: personId, name } : null
    };
}

/** The person an alert is about, from its own metadata. Anything unparseable
 *  reads as "about nobody" rather than failing a list. */
function personIn(metadata: string | null): string | null {
    if (!metadata) return null;
    try {
        const parsed: unknown = JSON.parse(metadata);
        const id = (parsed as { personId?: unknown } | null)?.personId;
        return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/** Names for the people a page of alerts is about, in one query rather than one
 *  per row. Empty when no row names anybody, which is most pages. */
async function namesFor(rows: readonly NotificationRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => personIn(row.metadata)).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true }
    });
    return new Map(people.map((person) => [person.id, person.name]));
}

/** Write a notification for a user. Best-effort; never throws to its caller. */
export async function createNotification(input: NotificationInput): Promise<void> {
    try {
        await prisma.notification.create({
            data: {
                userId: input.userId,
                type: input.type,
                title: input.title,
                body: input.body ?? null,
                href: input.href ?? null,
                level: input.level ?? "info",
                audience: input.audience ?? "you",
                audienceLabel: input.audienceLabel ?? null,
                actionRequired: input.actionRequired ?? false,
                metadata: input.metadata ? JSON.stringify(input.metadata) : null,
                readAt: input.read ? new Date() : null
            }
        });
    } catch {
        // A notification failing must not break the action that triggered it.
    }
}

/** How many notifications the live feed carries. The bell and the page share it,
 *  so there is a single list to keep in sync rather than two. */
export const NOTIFICATION_FEED_LIMIT = 50;

/** A user's notifications, newest first. */
export async function listNotifications(userId: string, limit = NOTIFICATION_FEED_LIMIT): Promise<NotificationView[]> {
    const rows = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: ROW_FIELDS
    });
    const names = await namesFor(rows);
    return rows.map((row) => toView(row, names));
}

/** How many rows one page of the history holds. */
export const NOTIFICATION_PAGE_SIZE = 40;

/** One page of history, oldest cursor last. */
export interface NotificationPage {
    items: NotificationView[];
    /** Pass back as `before` to get the next page. Null when the list ended. */
    cursor: string | null;
}

/**
 * A page of a user's notifications, newest first. Unlike the live feed this
 * reaches back through everything ever raised, so the page can answer "what
 * happened last Tuesday" rather than only "what is recent".
 */
export async function listNotificationHistory(
    userId: string,
    options: { before?: string | null; event?: string | null; unreadOnly?: boolean } = {}
): Promise<NotificationPage> {
    const rows = await prisma.notification.findMany({
        where: {
            userId,
            ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}),
            ...(options.event ? { type: options.event } : {}),
            ...(options.unreadOnly ? { readAt: null } : {})
        },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATION_PAGE_SIZE + 1,
        select: ROW_FIELDS
    });
    const page = rows.slice(0, NOTIFICATION_PAGE_SIZE);
    const names = await namesFor(page);
    return {
        items: page.map((row) => toView(row, names)),
        cursor: rows.length > NOTIFICATION_PAGE_SIZE ? (page.at(-1)?.createdAt.toISOString() ?? null) : null
    };
}

/** One attempt to get one alert somewhere, as the history renders it. */
export interface DeliveryView {
    id: string;
    event: string;
    kind: string;
    destinationHint: string | null;
    status: string;
    detail: string | null;
    createdAt: string;
}

/**
 * The recent delivery attempts for a user. This is what answers "the alarm
 * fired, so why did nobody get a text" - the bell alone cannot distinguish a
 * muted rule from a webhook that has been 404ing for a week.
 */
export async function listDeliveries(userId: string, limit = 100): Promise<DeliveryView[]> {
    const rows = await prisma.notificationDelivery.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
            id: true,
            event: true,
            kind: true,
            destinationHint: true,
            status: true,
            detail: true,
            createdAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        event: row.event,
        kind: row.kind,
        destinationHint: row.destinationHint,
        status: row.status,
        detail: row.detail,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Mark one notification read (scoped to the owner). */
export async function markNotificationRead(userId: string, id: string): Promise<void> {
    await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
}

/** Mark every unread notification read for a user. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
    await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}

/**
 * Mark every unread notification of these types read, for everyone.
 *
 * The one exception to the per-user scoping above, and deliberately so: some
 * alerts describe a state of the deployment rather than of an account, and when
 * that state resolves the alert is answered rather than ignored. An update that
 * has been installed cannot be installed again, so leaving its announcement
 * unread would hand every operator a bell to empty by hand after each release.
 * The condition being cleared belongs to the instance, so the clearing does too.
 */
export async function markNotificationsReadByType(types: readonly string[]): Promise<void> {
    await prisma.notification.updateMany({
        // Either half is worth clearing on its own: one that was read but still
        // says "Action needed" is a chore the reader cannot get rid of, and one
        // still unread is a count on the bell for something already done.
        where: { type: { in: [...types] }, OR: [{ readAt: null }, { actionRequired: true }] },
        // Read AND no longer waiting on anybody. These are answered by something
        // that happened - an update installed, a permission granted - rather than
        // by being looked at, and "Action needed" left standing after the action
        // was taken is the alert nobody can clear because nothing is wrong.
        data: { readAt: new Date(), actionRequired: false }
    });
}

/** Mark a chosen set read. Scoped to the owner, so ids that arrive from a
 *  browser and belong to somebody else are simply not matched. */
export async function markNotificationsRead(userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const done = await prisma.notification.updateMany({
        where: { id: { in: [...ids] }, userId, readAt: null },
        data: { readAt: new Date() }
    });
    return done.count;
}

/** Delete a chosen set (scoped to the owner). */
export async function deleteNotifications(userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const gone = await prisma.notification.deleteMany({ where: { id: { in: [...ids] }, userId } });
    return gone.count;
}

/** Delete one notification (scoped to the owner). */
export async function deleteNotification(userId: string, id: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { id, userId } });
}

/** Delete all of a user's notifications. */
export async function clearNotifications(userId: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId } });
}
