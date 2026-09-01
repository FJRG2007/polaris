"use server";

/**
 * Notification actions. Every action re-resolves the session and scopes to that
 * user, so one user can never read or mutate another's notifications, rules or
 * destinations. Nothing is revalidated for the feed mutations: the feed is
 * client state fed by the live stream, and it has already applied the change
 * optimistically by the time these run.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit-service";
import { testDestination } from "@/lib/notifications/dispatch";
import { destinationInputSchema, isNotificationEvent, notificationRuleSchema } from "@polaris/core";
import { getNotificationPreferences, saveNotificationPreferences } from "@/lib/notifications/preferences";
import {
    createDestination,
    deleteDestination,
    ownsDestinations,
    setDestinationEnabled,
    type DestinationView
} from "@/lib/notifications/destinations";
import {
    clearNotifications,
    deleteNotification,
    deleteNotifications,
    listNotificationHistory,
    markAllNotificationsRead,
    markNotificationRead,
    markNotificationsRead,
    type NotificationPage
} from "@/lib/notification-service";

/** How many test alerts one account may send, and over what span. */
const TEST_LIMIT = 10;
const TEST_WINDOW_MS = 5 * 60 * 1000;

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

/**
 * A selection, from the history's checkboxes.
 *
 * The ids arrive from a browser like any other list, so nothing is trusted about
 * them: they are validated as ids, capped, and matched against this account's
 * own rows. An id belonging to somebody else simply matches nothing.
 */
const selectionSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export async function markNotificationsReadAction(input: unknown): Promise<void> {
    const user = await requireUser();
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success) return;
    await markNotificationsRead(user.id, parsed.data.ids);
}

export async function deleteNotificationsAction(input: unknown): Promise<void> {
    const user = await requireUser();
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success) return;
    await deleteNotifications(user.id, parsed.data.ids);
}

const historyQuerySchema = z.object({
    before: z.string().datetime().nullable().optional(),
    event: z.string().refine(isNotificationEvent, "Unknown event").nullable().optional(),
    unreadOnly: z.boolean().optional()
});

/** Older notifications, for the history's "load more". */
export async function loadNotificationHistoryAction(input: unknown): Promise<NotificationPage> {
    const user = await requireUser();
    const parsed = historyQuerySchema.safeParse(input);
    if (!parsed.success) return { items: [], cursor: null };
    return listNotificationHistory(user.id, {
        before: parsed.data.before ?? null,
        event: parsed.data.event ?? null,
        unreadOnly: parsed.data.unreadOnly ?? false
    });
}

const saveRuleSchema = z.object({
    event: z.string().refine(isNotificationEvent, "Unknown event"),
    rule: notificationRuleSchema
});

/**
 * Change where one event goes. Saving a rule that names a destination the
 * account does not own is refused rather than silently dropped, so a tampered
 * payload cannot point somebody else's webhook at your alerts.
 */
export async function saveNotificationRuleAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = saveRuleSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the choice." };

    if (!(await ownsDestinations(user.id, parsed.data.rule.destinations))) {
        return { error: "One of those destinations no longer exists." };
    }

    const preferences = await getNotificationPreferences(user.id);
    await saveNotificationPreferences(user.id, { ...preferences, [parsed.data.event]: parsed.data.rule });
    revalidatePath("/account/notifications");
    return {};
}

export async function createDestinationAction(
    input: unknown
): Promise<{ destination?: DestinationView; error?: string }> {
    const user = await requireUser();
    const parsed = destinationInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await createDestination(user.id, parsed.data);
    if (!result.error) revalidatePath("/account/notifications");
    return result;
}

export async function setDestinationEnabledAction(id: string, enabled: boolean): Promise<void> {
    const user = await requireUser();
    await setDestinationEnabled(user.id, id, enabled);
    revalidatePath("/account/notifications");
}

export async function deleteDestinationAction(id: string): Promise<void> {
    const user = await requireUser();
    await deleteDestination(user.id, id);
    revalidatePath("/account/notifications");
}

/**
 * Send a sample alert so a destination is proved before an incident needs it.
 * Throttled because the button is on the other side of somebody else's rate
 * limit: Discord and Slack both punish a webhook that is hammered, and losing
 * the endpoint would be a poor way to find out it worked.
 */
export async function testDestinationAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const throttle = await rateLimit(`notify-test:${user.id}`, TEST_LIMIT, TEST_WINDOW_MS);
    if (!throttle.ok) return { error: "Too many tests. Wait a moment before sending another." };
    const result = await testDestination(user.id, id);
    revalidatePath("/account/notifications");
    return result;
}
