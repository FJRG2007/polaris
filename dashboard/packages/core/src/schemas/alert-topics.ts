/**
 * Alert topics: addresses other systems post alerts to, delivered as Polaris
 * notifications graded by severity.
 *
 * The severity scale is ntfy's (1 min, 2 low, 3 default, 4 high, 5 urgent), so
 * a tool that already speaks ntfy keeps its meaning here. Gotify's 0-10 scale is
 * folded onto it by `gotifyPriority`.
 */

import { z } from "zod";

export const ALERT_PRIORITIES = [1, 2, 3, 4, 5] as const;

export type AlertPriority = (typeof ALERT_PRIORITIES)[number];

/** ntfy's names, in the order of the scale. */
export const ALERT_PRIORITY_NAMES = ["min", "low", "default", "high", "urgent"] as const;

export type AlertPriorityName = (typeof ALERT_PRIORITY_NAMES)[number];

/** How much any one alert may carry. ntfy's own message limit is 4,096 bytes. */
export const ALERT_LIMITS = {
    name: 60,
    title: 250,
    message: 4096,
    tags: 10,
    tag: 50,
    url: 2048,
    actions: 3,
    actionLabel: 60,
    dedupKey: 200,
    recipients: 200,
    teams: 50
} as const;

/** The catalogue event an alert of this severity is raised as. */
export function alertEventId(priority: AlertPriority): `alerts.${AlertPriorityName}` {
    return `alerts.${ALERT_PRIORITY_NAMES[priority - 1] as AlertPriorityName}`;
}

/**
 * A severity from whatever a sender wrote: 1-5 as a number or text, or one of
 * ntfy's names and aliases (`max` is urgent). Null for anything else.
 */
export function alertPriority(value: unknown): AlertPriority | null {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 1 && value <= 5 ? (value as AlertPriority) : null;
    }
    if (typeof value !== "string") return null;
    const word = value.trim().toLowerCase();
    if (/^[1-5]$/.test(word)) return Number(word) as AlertPriority;
    if (word === "max") return 5;
    const index = (ALERT_PRIORITY_NAMES as readonly string[]).indexOf(word);
    return index >= 0 ? ((index + 1) as AlertPriority) : null;
}

/**
 * Gotify's 0-10 onto the 1-5 scale, after the bands its clients draw: 0 is no
 * notification, 1-3 an icon, 4-7 a sound, 8-10 a pop-up; only 10 is urgent.
 */
export function gotifyPriority(value: number): AlertPriority {
    if (!Number.isFinite(value) || value <= 0) return 1;
    if (value <= 3) return 2;
    if (value <= 7) return 3;
    if (value < 10) return 4;
    return 5;
}

const priority = z.number().int().min(1).max(5);

/** What the topic form sends. Normalized (trimmed) before it is checked. */
export const alertTopicFormSchema = z.object({
    name: z.string().trim().min(1, "nameRequired").max(ALERT_LIMITS.name, "nameTooLong"),
    /** The organization that owns it, or null for the account's own. */
    orgId: z.string().uuid().nullable(),
    /** The severity of an alert that names none. */
    defaultPriority: priority.default(3),
    /** The lowest severity that is also pushed to devices. Min is never pushed. */
    pushFrom: z.number().int().min(2).max(5).default(3),
    /** An organization's topic only: who gets it besides its creator. */
    recipientUserIds: z.array(z.string().uuid()).max(ALERT_LIMITS.recipients).default([]),
    recipientTeamIds: z.array(z.string().uuid()).max(ALERT_LIMITS.teams).default([])
});

export type AlertTopicForm = z.infer<typeof alertTopicFormSchema>;

export const alertTopicUpdateSchema = alertTopicFormSchema.omit({ orgId: true }).extend({
    topicId: z.string().uuid()
});
