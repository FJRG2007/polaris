"use server";

/**
 * Notification actions. Every action re-resolves the session and scopes to that
 * user, so one user can never read or mutate another's notifications.
 */

import { revalidatePath } from "next/cache";
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
    revalidatePath("/notifications");
}

export async function markAllNotificationsReadAction(): Promise<void> {
    const user = await requireUser();
    await markAllNotificationsRead(user.id);
    revalidatePath("/notifications");
}

export async function deleteNotificationAction(id: string): Promise<void> {
    const user = await requireUser();
    await deleteNotification(user.id, id);
    revalidatePath("/notifications");
}

export async function clearNotificationsAction(): Promise<void> {
    const user = await requireUser();
    await clearNotifications(user.id);
    revalidatePath("/notifications");
}
