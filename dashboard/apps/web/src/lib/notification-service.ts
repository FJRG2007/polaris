/**
 * In-app notifications. A notification is one row per recipient, surfaced in the
 * header bell menu. The type string drives the icon/label on the client; `data`
 * carries an optional JSON payload (a deep link, related ids). Creation is used
 * by server-side flows (e.g. a drop-point malware scan flagging a file), so it
 * never trusts client input for the recipient.
 */

import { prisma } from "@polaris/db";

/** A notification as sent to the client (dates/ids already serialized). */
export interface NotificationView {
    id: string;
    type: string;
    title: string;
    body: string | null;
    data: Record<string, unknown> | null;
    read: boolean;
    createdAt: string;
}

/** How many notifications the bell shows at once. */
const LIST_LIMIT = 30;

/** Create a notification for a user. `data` is stored as a JSON string. */
export async function createNotification(input: {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    data?: Record<string, unknown> | null;
}): Promise<void> {
    await prisma.notification.create({
        data: {
            userId: input.userId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            data: input.data ? JSON.stringify(input.data) : null
        }
    });
}

/** Parse a stored JSON data payload back into an object (null on any error). */
function parseData(json: string | null): Record<string, unknown> | null {
    if (!json) return null;
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** The most recent notifications for a user, plus the current unread count. */
export async function listNotifications(
    userId: string
): Promise<{ notifications: NotificationView[]; unread: number }> {
    const [rows, unread] = await Promise.all([
        prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: LIST_LIMIT,
            select: { id: true, type: true, title: true, body: true, data: true, readAt: true, createdAt: true }
        }),
        prisma.notification.count({ where: { userId, readAt: null } })
    ]);
    return {
        unread,
        notifications: rows.map((row) => ({
            id: row.id,
            type: row.type,
            title: row.title,
            body: row.body,
            data: parseData(row.data),
            read: row.readAt !== null,
            createdAt: row.createdAt.toISOString()
        }))
    };
}

/** The unread count only (for a cheap poll). */
export async function unreadNotificationCount(userId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, readAt: null } });
}

/**
 * Mark notifications read. With no ids, marks every unread one read; scoped to the
 * user so one account can never touch another's. Idempotent.
 */
export async function markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
    await prisma.notification.updateMany({
        where: { userId, readAt: null, ...(ids && ids.length > 0 ? { id: { in: ids } } : {}) },
        data: { readAt: new Date() }
    });
}
