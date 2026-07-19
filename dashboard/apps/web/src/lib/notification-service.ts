/**
 * In-app notifications. Server-side events (a scanned drop-point upload, for now)
 * write a row here; the bell and the notifications page read it. Reads and
 * mutations are always scoped to the owning user, so one user can never see or
 * clear another's notifications. Metadata is stored as a JSON string for the same
 * SQLite-portability reason as the rest of the schema.
 */

import { prisma } from "@polaris/db";

export type NotificationLevel = "info" | "success" | "warning" | "danger";

export interface NotificationInput {
    userId: string;
    type: string;
    title: string;
    body?: string | null;
    href?: string | null;
    level?: NotificationLevel;
    metadata?: Record<string, unknown> | null;
}

export interface NotificationView {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: NotificationLevel;
    read: boolean;
    createdAt: string;
}

const LEVELS: ReadonlySet<string> = new Set(["info", "success", "warning", "danger"]);

function toView(row: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: string;
    readAt: Date | null;
    createdAt: Date;
}): NotificationView {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        href: row.href,
        level: (LEVELS.has(row.level) ? row.level : "info") as NotificationLevel,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString()
    };
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
                metadata: input.metadata ? JSON.stringify(input.metadata) : null
            }
        });
    } catch {
        // A notification failing must not break the action that triggered it.
    }
}

/** A user's notifications, newest first. */
export async function listNotifications(userId: string, limit = 50): Promise<NotificationView[]> {
    const rows = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
            id: true,
            type: true,
            title: true,
            body: true,
            href: true,
            level: true,
            readAt: true,
            createdAt: true
        }
    });
    return rows.map(toView);
}

/** How many of a user's notifications are unread. */
export async function countUnread(userId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Mark one notification read (scoped to the owner). */
export async function markNotificationRead(userId: string, id: string): Promise<void> {
    await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
}

/** Mark every unread notification read for a user. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
    await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}

/** Delete one notification (scoped to the owner). */
export async function deleteNotification(userId: string, id: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { id, userId } });
}

/** Delete all of a user's notifications. */
export async function clearNotifications(userId: string): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId } });
}
