"use server";

/**
 * Notification actions. Every action re-resolves the session and scopes to that
 * user, so one user can never read or mutate another's notifications. Nothing is
 * revalidated here: the feed is client state fed by the live stream, and it has
 * already applied the change optimistically by the time these run.
 */

import { requireUser } from "@/lib/session";
import {
    clearNotifications,
    deleteNotification,
    markAllNotificationsRead,
    markNotificationRead
} from "@/lib/notification-service";

export async function markNotificationReadAction(id: string): Promise<void> {
    const user = await requireUser();
    await markNotificationRead(user.id, id);
}

export async function markAllNotificationsReadAction(): Promise<void> {
    const user = await requireUser();
    await markAllNotificationsRead(user.id);
}

export async function deleteNotificationAction(id: string): Promise<void> {
    const user = await requireUser();
    await deleteNotification(user.id, id);
}

export async function clearNotificationsAction(): Promise<void> {
    const user = await requireUser();
    await clearNotifications(user.id);
}
