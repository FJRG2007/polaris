/**
 * What holds a kind of alert back for a while: a mute that runs out, and a
 * weekly schedule outside which it does not ring.
 *
 * Both work the way Slack's do. A held alert is still written to the bell, read,
 * so it can be found afterwards; it just makes no sound, raises no badge and is
 * not sent by mail, webhook or text. It is not sent later either: once the
 * moment has passed, a buzz about it is noise. Critical events go through both,
 * the same as they go through do not disturb.
 *
 * Either can be set on one event or on a whole group. A mute on either holds
 * the event back; an event's own schedule replaces its group's.
 */

import { z } from "zod";
import { EVERY_DAY, MINUTES_IN_DAY, weeklyWindow } from "./presence-schedule.js";
import { NOTIFICATION_GROUPS, notificationEvent } from "./notifications.js";

/** What a mute or a schedule is set on: one event, or every event in a group. */
export const holdTargetSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("event"),
        id: z.string().refine((id) => notificationEvent(id) !== null, "Unknown event")
    }),
    z.object({ kind: z.literal("group"), id: z.enum(NOTIFICATION_GROUPS) })
]);

export type HoldTarget = z.infer<typeof holdTargetSchema>;

/** The key a target is stored under: `event:deploy.failed`, `group:deploy`. */
export function holdKey(target: HoldTarget): string {
    return `${target.kind}:${target.id}`;
}

const holdKeySchema = z.string().refine((key) => {
    const [kind, ...rest] = key.split(":");
    const id = rest.join(":");
    return holdTargetSchema.safeParse({ kind, id }).success;
}, "Unknown event or group");

/** How long a mute lasts. `off` is "until I turn it back on". */
export const NOTIFICATION_MUTE_DURATIONS = ["1h", "8h", "24h", "1w", "off"] as const;

export type NotificationMuteDuration = (typeof NOTIFICATION_MUTE_DURATIONS)[number];

const DURATION_MS: Record<Exclude<NotificationMuteDuration, "off">, number> = {
    "1h": 60 * 60_000,
    "8h": 8 * 60 * 60_000,
    "24h": 24 * 60 * 60_000,
    "1w": 7 * 24 * 60 * 60_000
};

/** When a mute chosen at `now` ends, or null for one with no end. */
export function muteUntil(duration: NotificationMuteDuration, now: Date): string | null {
    return duration === "off"
        ? null
        : new Date(now.getTime() + DURATION_MS[duration]).toISOString();
}

export const notificationMuteSchema = z.object({
    /** When it lifts by itself, or null for "until I turn it back on". */
    until: z.string().datetime().nullable()
});

export type NotificationMute = z.infer<typeof notificationMuteSchema>;

/**
 * The hours an alert may ring: a set of weekdays (a `getDay()` bitmask, like
 * standing hours) and a start and end in minutes past midnight on the account's
 * clock. An end before the start runs over midnight, on the day it opens; equal
 * ones are the whole day.
 */
export const notificationScheduleSchema = z.object({
    days: z.number().int().min(1).max(EVERY_DAY),
    startMinute: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_IN_DAY - 1),
    endMinute: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_IN_DAY - 1)
});

export type NotificationSchedule = z.infer<typeof notificationScheduleSchema>;

/** Every mute and schedule an account has, keyed by `holdKey`. */
export const notificationHoldsSchema = z.object({
    mutes: z.record(holdKeySchema, notificationMuteSchema).default({}),
    schedules: z.record(holdKeySchema, notificationScheduleSchema).default({})
});

export type NotificationHolds = z.infer<typeof notificationHoldsSchema>;

export const EMPTY_NOTIFICATION_HOLDS: NotificationHolds = { mutes: {}, schedules: {} };

/** Read the stored JSON, tolerating anything that is no longer valid. A null
 *  column is no holds at all, which is how every account starts. */
export function parseNotificationHolds(raw: string | null | undefined): NotificationHolds {
    if (!raw) return { mutes: {}, schedules: {} };
    let stored: unknown;
    try {
        stored = JSON.parse(raw);
    } catch {
        return { mutes: {}, schedules: {} };
    }
    const record = z
        .object({ mutes: z.unknown(), schedules: z.unknown() })
        .partial()
        .safeParse(stored);
    if (!record.success) return { mutes: {}, schedules: {} };
    return {
        mutes: validEntries(record.data.mutes, notificationMuteSchema),
        schedules: validEntries(record.data.schedules, notificationScheduleSchema)
    };
}

/** The entries of a stored map whose key and value still parse, so one retired
 *  event or group drops only its own hold. */
function validEntries<T>(raw: unknown, value: z.ZodType<T>): Record<string, T> {
    const entries: Record<string, T> = {};
    const map = z.record(z.string(), z.unknown()).safeParse(raw);
    if (!map.success) return entries;
    for (const [key, entry] of Object.entries(map.data)) {
        const parsed = value.safeParse(entry);
        if (holdKeySchema.safeParse(key).success && parsed.success) entries[key] = parsed.data;
    }
    return entries;
}

/** Whether a mute still holds at `now`. */
export function muteActive(mute: NotificationMute | undefined, now: Date): boolean {
    if (!mute) return false;
    return mute.until === null || new Date(mute.until).getTime() > now.getTime();
}

/** The same holds without the mutes that have run out, so nothing stale is
 *  stored or drawn. */
export function pruneHolds(holds: NotificationHolds, now: Date): NotificationHolds {
    const mutes: NotificationHolds["mutes"] = {};
    for (const [key, mute] of Object.entries(holds.mutes)) {
        if (muteActive(mute, now)) mutes[key] = mute;
    }
    return { mutes, schedules: { ...holds.schedules } };
}

/**
 * Whether `now` is inside a schedule's hours, read on the account's clock. The
 * day before is looked at too, because at one in the morning a window that runs
 * over midnight is open because of yesterday.
 */
export function inSchedule(schedule: NotificationSchedule, now: Date, timeZone: string): boolean {
    for (const startedDaysAgo of [0, 1]) {
        const window = weeklyWindow(schedule, timeZone, now, startedDaysAgo);
        if (window && now >= window.openedAt && now < window.closesAt) return true;
    }
    return false;
}

export type HoldReason = "muted" | "schedule";

/**
 * Why an event is held back at `now`, or null when it may ring. A mute on the
 * event or its group comes first; then the event's own schedule, else its
 * group's. A critical event and one nothing declares are never held.
 */
export function holdReason(
    holds: NotificationHolds,
    eventId: string,
    now: Date,
    timeZone: string
): HoldReason | null {
    if (holdMuted(holds, eventId, now)) return "muted";
    const schedule = holdSchedule(holds, eventId);
    if (schedule && !inSchedule(schedule, now, timeZone)) return "schedule";
    return null;
}

/** The event's own key and its group's, or null for an event that is never
 *  held: a critical one, or one nothing declares. */
function holdKeys(eventId: string): { own: string; group: string } | null {
    const event = notificationEvent(eventId);
    if (!event || event.critical) return null;
    return {
        own: holdKey({ kind: "event", id: eventId }),
        group: holdKey({ kind: "group", id: event.group })
    };
}

/** Whether a mute on the event or its group holds it back at `now`. */
export function holdMuted(holds: NotificationHolds, eventId: string, now: Date): boolean {
    const keys = holdKeys(eventId);
    if (!keys) return false;
    return muteActive(holds.mutes[keys.own], now) || muteActive(holds.mutes[keys.group], now);
}

/** The schedule that applies to the event: its own, else its group's. */
export function holdSchedule(
    holds: NotificationHolds,
    eventId: string
): NotificationSchedule | null {
    const keys = holdKeys(eventId);
    if (!keys) return null;
    return holds.schedules[keys.own] ?? holds.schedules[keys.group] ?? null;
}
