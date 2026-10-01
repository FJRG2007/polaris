/**
 * What the calendar's screens send, as zod schemas the browser checks while
 * typing and the server checks again before storing - the same schema on both
 * sides, so a value the form accepts is never refused on save.
 *
 * Text fields arrive from inputs as "" when empty, and every optional one
 * accepts that. Addresses are normalised (trimmed, lowercased, `mailto:`
 * dropped) before they are checked.
 */

import { z } from "zod";
import { resolveZone } from "./tz";
import { valueToInstant } from "./zones";
import type { DateValue } from "./types";

/**
 * What these schemas refuse with: catalog keys, not sentences. A screen or the
 * server shows `validation.<key>` from the `rule.json` catalog, so the words
 * are in the reader's language on both sides.
 */
export const SCHEMA_MESSAGES = {
    dateForm: "dateForm",
    noSuchDay: "noSuchDay",
    dateTimeForm: "dateTimeForm",
    unknownZone: "unknownZone",
    weekdayTwice: "weekdayTwice",
    linkForm: "linkForm",
    invitedTwice: "invitedTwice",
    colorForm: "colorForm",
    allDayMismatch: "allDayMismatch",
    endBeforeStart: "endBeforeStart",
    timeForm: "timeForm",
    rangesOverlap: "rangesOverlap",
    tooManyDates: "tooManyDates",
    noSuchDate: "noSuchDate"
} as const;

/** An address as the calendar stores it: trimmed, lowercased, no `mailto:`. */
export function normalizeEmail(value: string): string {
    return value
        .trim()
        .replace(/^mailto:/i, "")
        .toLowerCase();
}

function realDate(text: string): boolean {
    const [year, month, day] = text.split("-").map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

/** `YYYY-MM-DD`, a day that exists. */
export const dateStringSchema = z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, SCHEMA_MESSAGES.dateForm)
    .refine(realDate, SCHEMA_MESSAGES.noSuchDay);

/** `YYYY-MM-DDTHH:mm:ss`, seconds optional on input. */
const dateTimeStringSchema = z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, SCHEMA_MESSAGES.dateTimeForm)
    .refine((text) => realDate(text.slice(0, 10)), SCHEMA_MESSAGES.noSuchDay)
    .transform((text) => (text.length === 16 ? `${text}:00` : text));

/** An IANA zone the runtime knows, "UTC", or null for floating time. */
const tzidSchema = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((zone) => resolveZone(zone) !== null, SCHEMA_MESSAGES.unknownZone)
    .nullable();

export const dateValueSchema = z.union([
    z.object({ date: dateStringSchema }).strict(),
    z.object({ dateTime: dateTimeStringSchema, tzid: tzidSchema }).strict()
]);

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const alarmTriggerSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("relative"),
        // A year either way is more than any calendar offers.
        minutes: z.number().int().min(-527_040).max(527_040),
        related: z.enum(["START", "END"])
    }),
    z.object({ kind: z.literal("absolute"), at: z.string().datetime() })
]);

export const alarmSchema = z.object({
    action: z.enum(["DISPLAY", "EMAIL", "AUDIO"]),
    trigger: alarmTriggerSchema,
    description: z.string().trim().max(1000).default("")
});

const emailSchema = z.preprocess((value) => (typeof value === "string" ? normalizeEmail(value) : value), z.string().email().max(320));

export const attendeeSchema = z.object({
    email: emailSchema,
    name: z.string().trim().max(200).default(""),
    role: z.enum(["CHAIR", "REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT"]).default("REQ-PARTICIPANT"),
    partstat: z.enum(["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"]).default("NEEDS-ACTION"),
    rsvp: z.boolean().default(true),
    type: z.enum(["INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN"]).default("INDIVIDUAL")
});

const weekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

export const ruleEditorSchema = z.object({
    frequency: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).max(999),
    weekdays: z.array(weekdaySchema).max(7).refine((days) => new Set(days).size === days.length, SCHEMA_MESSAGES.weekdayTwice),
    monthlyMode: z.enum(["day", "ordinal"]),
    monthDays: z.array(z.number().int().min(1).max(31)).max(31),
    ordinal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1), z.literal(-2)]),
    ordinalDay: z.union([weekdaySchema, z.enum(["day", "weekday", "weekend"])]),
    months: z.array(z.number().int().min(1).max(12)).max(12),
    end: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("never") }),
        z.object({ kind: z.literal("until"), date: dateStringSchema }),
        z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(1000) })
    ])
});

/** An http(s) link, or "" for none. */
const linkSchema = z
    .string()
    .trim()
    .max(2000)
    .refine((text) => {
        if (text === "") return true;
        try {
            const url = new URL(text);
            return url.protocol === "https:" || url.protocol === "http:";
        } catch {
            return false;
        }
    }, SCHEMA_MESSAGES.linkForm)
    .optional()
    .default("");

/** When a value is, or null when it is not a value at all - zod still runs an
 *  object's refinement after one of its fields failed its own check, and a
 *  malformed date must come back as that field's issue, not as a throw. */
function instantOf(value: DateValue): number | null {
    if (!dateValueSchema.safeParse(value).success) return null;
    try {
        return valueToInstant(value, "UTC").getTime();
    } catch {
        return null;
    }
}

/** What the event editor sends to save an event. */
export const eventInputSchema = z
    .object({
        calendarId: z.string().uuid(),
        summary: z.string().trim().max(500).default(""),
        description: z.string().max(20_000).default(""),
        location: z.string().trim().max(1000).default(""),
        start: dateValueSchema,
        end: dateValueSchema,
        allDay: z.boolean(),
        rule: ruleEditorSchema.nullable().default(null),
        /**
         * Keep the series' own rule instead of `rule`: for a rule the editor
         * cannot show (an hourly repeat, BYWEEKNO) that the person did not
         * touch, so saving the rest of the event does not rewrite it.
         */
        keepRule: z.boolean().default(false),
        attachments: z
            .array(
                z.object({
                    uri: linkSchema.refine((text) => text !== "", SCHEMA_MESSAGES.linkForm),
                    name: z.string().trim().max(300).default(""),
                    mime: z.string().trim().max(200).default("")
                })
            )
            .max(20)
            .default([]),
        alarms: z.array(alarmSchema).max(10).default([]),
        attendees: z
            .array(attendeeSchema)
            .max(200)
            .default([])
            .refine((list) => new Set(list.map((attendee) => attendee.email)).size === list.length, SCHEMA_MESSAGES.invitedTwice),
        categories: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
        color: z
            .string()
            .trim()
            .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, SCHEMA_MESSAGES.colorForm)
            .nullable()
            .default(null),
        status: z.enum(["CONFIRMED", "TENTATIVE", "CANCELLED"]).nullable().default(null),
        transparency: z.enum(["OPAQUE", "TRANSPARENT"]).default("OPAQUE"),
        classification: z.enum(["PUBLIC", "PRIVATE", "CONFIDENTIAL"]).default("PUBLIC"),
        url: linkSchema,
        conference: linkSchema,
        kind: z.enum(["default", "outOfOffice", "focusTime", "workingLocation"]).default("default")
    })
    .superRefine((input, context) => {
        if (typeof input.start !== "object" || input.start === null) return;
        if (typeof input.end !== "object" || input.end === null) return;
        const startIsDate = "date" in input.start;
        const endIsDate = "date" in input.end;
        if (startIsDate !== input.allDay || endIsDate !== input.allDay) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["allDay"], message: SCHEMA_MESSAGES.allDayMismatch });
            return;
        }
        const start = instantOf(input.start);
        const end = instantOf(input.end);
        if (start === null || end === null) return;
        if (end < start) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: SCHEMA_MESSAGES.endBeforeStart });
        }
    });

export type EventInput = z.infer<typeof eventInputSchema>;

const hoursRangeSchema = z
    .object({ from: z.string().regex(hhmm, SCHEMA_MESSAGES.timeForm), to: z.string().regex(hhmm, SCHEMA_MESSAGES.timeForm) })
    .refine((range) => range.from < range.to, { message: SCHEMA_MESSAGES.endBeforeStart, path: ["to"] });

const dayHoursSchema = z
    .array(hoursRangeSchema)
    .max(10)
    .refine((ranges) => {
        const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : 1));
        return sorted.every((range, index) => index === 0 || (sorted[index - 1]?.to ?? "") <= range.from);
    }, SCHEMA_MESSAGES.rangesOverlap);

/** Working hours per weekday, "0" = Sunday; a missing day is not worked. */
export const workingHoursSchema = z.object({
    "0": dayHoursSchema.default([]),
    "1": dayHoursSchema.default([]),
    "2": dayHoursSchema.default([]),
    "3": dayHoursSchema.default([]),
    "4": dayHoursSchema.default([]),
    "5": dayHoursSchema.default([]),
    "6": dayHoursSchema.default([])
});

/** A booking page's availability: weekly hours and per-date overrides. */
export const availabilitySchema = z.object({
    weekly: workingHoursSchema,
    overrides: z
        .record(z.string(), dayHoursSchema)
        .default({})
        .refine((overrides) => Object.keys(overrides).length <= 366, SCHEMA_MESSAGES.tooManyDates)
        .refine((overrides) => Object.keys(overrides).every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && realDate(date)), SCHEMA_MESSAGES.noSuchDate)
});
