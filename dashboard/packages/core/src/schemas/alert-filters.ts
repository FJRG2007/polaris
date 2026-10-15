/**
 * What keeps an alert channel quiet: a lowest severity per destination, and
 * hours of the day an account does not want mail, webhooks or texts.
 *
 * Both only ever hold back the channels that reach somebody outside Polaris.
 * The bell is the record of what happened and is never filtered by either, and
 * an event the catalogue marks critical goes through a severity filter always
 * and through quiet hours unless the account turned that off.
 */

import { z } from "zod";
import type { NotificationLevel } from "./notifications.js";

/** The floors a destination can be set to, lowest first. */
export const ALERT_MIN_LEVELS = ["info", "warning", "danger"] as const;

export type AlertMinLevel = (typeof ALERT_MIN_LEVELS)[number];

export const alertMinLevelSchema = z.enum(ALERT_MIN_LEVELS);

/** Success is good news, so it ranks with info rather than above warning. */
const RANK: Record<NotificationLevel, number> = { info: 0, success: 0, warning: 1, danger: 2 };

/** Read a stored floor, falling back to "everything" for anything unknown. */
export function readMinLevel(raw: string | null | undefined): AlertMinLevel {
    const parsed = alertMinLevelSchema.safeParse(raw);
    return parsed.success ? parsed.data : "info";
}

/** Whether an alert of `level` clears a destination's floor. */
export function clearsMinLevel(level: NotificationLevel, floor: AlertMinLevel, critical = false): boolean {
    if (critical) return true;
    return RANK[level] >= RANK[floor];
}

const clock = z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 22:00");

export const quietHoursSchema = z.object({
    enabled: z.boolean(),
    start: clock,
    end: clock,
    /** Critical events go out during quiet hours too. */
    criticalBypass: z.boolean()
});

export type QuietHours = z.infer<typeof quietHoursSchema>;

/** What an account starts with: off, with a night already filled in. */
export const DEFAULT_QUIET_HOURS: QuietHours = {
    enabled: false,
    start: "22:00",
    end: "08:00",
    criticalBypass: true
};

/** Parse the stored JSON, tolerating anything that is not valid any more. */
export function parseQuietHours(raw: string | null | undefined): QuietHours {
    if (!raw) return DEFAULT_QUIET_HOURS;
    try {
        const parsed = quietHoursSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_QUIET_HOURS;
    } catch {
        return DEFAULT_QUIET_HOURS;
    }
}

function minutesOf(value: string): number {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Minutes past midnight at `now` in `timeZone`; UTC when the zone is unknown. */
export function minutesInZone(now: Date, timeZone: string | null | undefined): number {
    const read = (zone: string): number => {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).formatToParts(now);
        const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
        const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
        return (hour % 24) * 60 + minute;
    };
    try {
        return read(timeZone || "UTC");
    } catch {
        return read("UTC");
    }
}

/**
 * Whether `now` falls inside the quiet window, read on the account's clock. A
 * window whose end is earlier than its start runs over midnight; one whose
 * start and end are the same is empty rather than all day.
 */
export function inQuietHours(quiet: QuietHours, now: Date, timeZone: string | null | undefined): boolean {
    if (!quiet.enabled) return false;
    const start = minutesOf(quiet.start);
    const end = minutesOf(quiet.end);
    if (start === end) return false;
    const at = minutesInZone(now, timeZone);
    return start < end ? at >= start && at < end : at >= start || at < end;
}

/** Whether quiet hours hold this alert back right now. */
export function heldByQuietHours(
    quiet: QuietHours,
    now: Date,
    timeZone: string | null | undefined,
    critical: boolean
): boolean {
    if (critical && quiet.criticalBypass) return false;
    return inQuietHours(quiet, now, timeZone);
}
