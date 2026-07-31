/**
 * Which events an account wants told about, and where each one goes.
 *
 * The rules are one JSON blob on the user's row, the same way display
 * preferences are: they are read together, written together, and never queried
 * across accounts, so a table of them would buy nothing. Reads are memoized per
 * request, so a page resolving several events costs one query; the background
 * pollers call the same function outside any request, where the memo degrades to
 * a plain read - which is what they want anyway, since a poller running for days
 * must see a rule changed an hour ago.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import {
    NOTIFICATION_EVENTS,
    parseNotificationPreferences,
    resolveRule,
    stringifyNotificationPreferences,
    type NotificationPreferences,
    type NotificationRule
} from "@polaris/core";

/** One account's saved rules. Events it never touched are absent. */
export const getNotificationPreferences = cache(async (userId: string): Promise<NotificationPreferences> => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { notifyPrefs: true } });
    return parseNotificationPreferences(row?.notifyPrefs);
});

/** The rule in force for one event, defaults filled in. */
export async function ruleFor(userId: string, eventId: string): Promise<NotificationRule> {
    return resolveRule(await getNotificationPreferences(userId), eventId);
}

/** Every event with its effective rule, for the settings page. */
export async function describeNotificationRules(
    userId: string
): Promise<Array<{ event: string; rule: NotificationRule }>> {
    const preferences = await getNotificationPreferences(userId);
    return NOTIFICATION_EVENTS.map((event) => ({ event: event.id, rule: resolveRule(preferences, event.id) }));
}

export async function saveNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences
): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { notifyPrefs: stringifyNotificationPreferences(preferences) }
    });
}

/**
 * Drop a destination from every rule that names it. Called when the destination
 * is deleted, so a rule can never point at a row that is gone - which would
 * otherwise read as "this event is routed somewhere" while going nowhere.
 */
export async function forgetDestination(userId: string, destinationId: string): Promise<void> {
    const preferences = await getNotificationPreferences(userId);
    let changed = false;
    const next: NotificationPreferences = {};
    for (const [event, rule] of Object.entries(preferences)) {
        const destinations = rule.destinations.filter((id) => id !== destinationId);
        if (destinations.length !== rule.destinations.length) changed = true;
        next[event] = { ...rule, destinations };
    }
    if (changed) await saveNotificationPreferences(userId, next);
}
