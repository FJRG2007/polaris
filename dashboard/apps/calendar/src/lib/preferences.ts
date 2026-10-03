/**
 * One person's calendar settings.
 *
 * Stored as one JSON document. Reading fills every missing or unreadable field
 * with its default, so a setting added later is simply there for everybody - no
 * row to migrate, and a document an older version wrote still reads. Writing is
 * strict: a change from the settings screen is validated field by field and a
 * wrong value is refused, never patched into a default.
 *
 * Pure: shared with the settings screen, which validates the same way.
 */

import { z } from "zod";
import { DEFAULT_POMODORO, pomodoroConfigSchema } from "./clock/model";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const zone = z.string().trim().min(1).max(64);

/** Hours of one weekday, e.g. 09:00-13:00 and 14:00-18:00. */
const dayHours = z
    .array(z.object({ from: hhmm, to: hhmm }).refine((span) => span.from < span.to))
    .max(6);

export const VIEWS = ["day", "week", "month", "year", "list", "days"] as const;
export type CalendarViewName = (typeof VIEWS)[number];

/** How many cities the world clock keeps. */
export const WORLD_CLOCK_MAX = 24;

export const SLOT_MINUTES = [5, 10, 15, 20, 30, 60] as const;

const alarmMinutes = z.array(z.number().int().min(-40320).max(40320)).max(5);

/** Each setting, strict. */
const fields = {
    /** The view the calendar opens on - the last one used. */
    view: z.enum(VIEWS),
    /** How many days the custom view spans (Google's "4 days"). */
    customDays: z.number().int().min(2).max(7),
    /** 0 = Sunday .. 6 = Saturday; null follows the reader's locale. */
    firstDay: z.number().int().min(0).max(6).nullable(),
    showWeekends: z.boolean(),
    showWeekNumbers: z.boolean(),
    /** Height of a row in day and week views, in minutes (Nextcloud's density). */
    slotMinutes: z.number().refine((value) => (SLOT_MINUTES as readonly number[]).includes(value)),
    /** "auto" follows the browser; otherwise an IANA zone. */
    timezone: zone,
    /** A second zone drawn beside the hours in day and week views. */
    secondaryTimezone: zone.nullable(),
    /** The world clock's cities, as zones: the sidebar's clocks, the Time
     *  area's list and its meeting planner, and the comparison under an event's
     *  times. */
    worldClock: z.array(zone).max(WORLD_CLOCK_MAX),
    /** Length of a new event, in minutes. */
    defaultDuration: z
        .number()
        .int()
        .min(5)
        .max(24 * 60),
    /** Meetings end early (Google's speedy meetings): 25 instead of 30, 50 instead of 60. */
    speedyMeetings: z.boolean(),
    /** Reminders a new event starts with, in minutes relative to the start. */
    defaultAlarms: z.object({ timed: alarmMinutes, allDay: alarmMinutes }),
    /** Events shown per day in the month view before "+N more"; 0 means all. */
    eventLimit: z.number().int().min(0).max(20),
    /** Open the full editor straight away instead of the quick popover. */
    skipPopover: z.boolean(),
    showTasks: z.boolean(),
    showDeclined: z.boolean(),
    dimPast: z.boolean(),
    keyboardShortcuts: z.boolean(),
    /** The hour day and week views scroll to first. */
    dayStart: hhmm,
    /** Working hours by weekday ("0" = Sunday): finding a time uses them and
     *  the grid shades the rest. */
    workingHours: z.record(z.enum(["0", "1", "2", "3", "4", "5", "6"]), dayHours),
    /** Where new events go; null is the first calendar the person owns. */
    defaultCalendarId: z.string().uuid().nullable(),
    /** Where invitations from other Polaris people land. */
    invitationCalendarId: z.string().uuid().nullable(),
    /** Sidebar sections folded away. */
    collapsed: z.array(z.string().max(40)).max(20),
    /** First-use hints somebody closed, so they stay closed. */
    dismissedHints: z.array(z.enum(["link-accounts"])).max(10),
    /** The lengths a new focus cycle starts with in the Time area. */
    pomodoro: pomodoroConfigSchema
};

type Fields = typeof fields;
export type CalendarPreferences = { [K in keyof Fields]: z.infer<Fields[K]> };

const WORKDAY = [{ from: "09:00", to: "17:00" }];

export const DEFAULT_PREFERENCES: CalendarPreferences = {
    view: "week",
    customDays: 4,
    firstDay: null,
    showWeekends: true,
    showWeekNumbers: false,
    slotMinutes: 30,
    timezone: "auto",
    secondaryTimezone: null,
    worldClock: [],
    defaultDuration: 60,
    speedyMeetings: false,
    defaultAlarms: { timed: [-10], allDay: [-900] },
    eventLimit: 4,
    skipPopover: false,
    showTasks: true,
    showDeclined: true,
    dimPast: true,
    keyboardShortcuts: true,
    dayStart: "07:00",
    workingHours: { "1": WORKDAY, "2": WORKDAY, "3": WORKDAY, "4": WORKDAY, "5": WORKDAY },
    defaultCalendarId: null,
    invitationCalendarId: null,
    collapsed: [],
    dismissedHints: [],
    pomodoro: DEFAULT_POMODORO
};

/** A change from the settings screen: any subset of the fields, each strict,
 *  and nothing that is not a field. */
export const preferencesPatchSchema = z.object(fields).partial().strict();

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/** Read a stored document, taking the default for whatever is missing or does
 *  not read. Never throws. */
export function readPreferences(raw: string | null | undefined): CalendarPreferences {
    let stored: Record<string, unknown> = {};
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            stored = parsed as Record<string, unknown>;
        }
    } catch {
        stored = {};
    }
    const read = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    for (const [key, schema] of Object.entries(fields)) {
        if (!(key in stored)) continue;
        const result = (schema as z.ZodTypeAny).safeParse(stored[key]);
        if (result.success) read[key] = result.data;
    }
    return read as CalendarPreferences;
}

/** The length a new event gets, after speedy meetings. */
export function newEventMinutes(preferences: CalendarPreferences): number {
    const minutes = preferences.defaultDuration;
    if (!preferences.speedyMeetings) return minutes;
    if (minutes <= 30) return Math.max(5, minutes - 5);
    return minutes - 10;
}
