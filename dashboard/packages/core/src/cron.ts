/**
 * Cron schedules: parsing the five-field expression everyone already writes, and
 * working out when it next fires, in a time zone.
 *
 * Standard fields - minute, hour, day of month, month, day of week - with lists,
 * ranges, steps and names (`JAN`, `MON`), plus the `@hourly`/`@daily` shorthands.
 * Two rules people trip on are kept the way every cron keeps them: day of week 7
 * is Sunday as well as 0, and when both day fields are restricted a day matches
 * if EITHER does (`0 9 1 * MON` is the first of the month and every Monday).
 *
 * The time zone is the schedule's own: "every day at 09:00" means nine in the
 * morning where the person who wrote it is, and the day the clocks change it
 * still means nine. A time the clocks skip over does not fire that day; a time
 * that happens twice fires the first time.
 */

import { z } from "zod";
import { AUTOMATIC_TIME_ZONE, isTimeZone } from "./schemas/display.js";

/** A parsed schedule: the allowed values of each field. */
export interface CronSchedule {
    readonly minutes: ReadonlySet<number>;
    readonly hours: ReadonlySet<number>;
    readonly days: ReadonlySet<number>;
    readonly months: ReadonlySet<number>;
    readonly weekdays: ReadonlySet<number>;
    /** Whether each day field was left open, which decides how they combine. */
    readonly anyDay: boolean;
    readonly anyWeekday: boolean;
}

const SHORTHANDS: Readonly<Record<string, string>> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *"
};

const MONTH_NAMES = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC"
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Why an expression could not be read, in the words shown beside the field. */
export class CronError extends Error {}

function field(text: string, min: number, max: number, names?: readonly string[]): Set<number> {
    const values = new Set<number>();
    for (const part of text.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1)
            throw new CronError(`"${part}" has a step that is not a whole number`);
        let low = min;
        let high = max;
        if (range !== "*") {
            const [from, to] = (range ?? "").split("-");
            low = value(from ?? "", min, max, names);
            high =
                to === undefined
                    ? stepText === undefined
                        ? low
                        : max
                    : value(to, min, max, names);
            if (high < low) throw new CronError(`"${part}" runs backwards`);
        }
        for (let at = low; at <= high; at += step) values.add(at);
    }
    return values;
}

function value(text: string, min: number, max: number, names?: readonly string[]): number {
    const named = names?.indexOf(text.toUpperCase()) ?? -1;
    const number = named >= 0 ? named + (names === MONTH_NAMES ? 1 : 0) : Number(text);
    if (!/^[0-9A-Za-z]+$/.test(text) || !Number.isInteger(number) || number < min || number > max) {
        throw new CronError(`"${text}" is not between ${min} and ${max}`);
    }
    return number;
}

/** Read an expression, or throw a CronError saying what is wrong with it. */
export function parseCron(expression: string): CronSchedule {
    const trimmed = expression.trim().toLowerCase();
    const expanded = SHORTHANDS[trimmed] ?? expression.trim();
    const parts = expanded.split(/\s+/);
    if (parts.length !== 5)
        throw new CronError("A schedule has five fields: minute, hour, day, month and weekday");
    const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
    const weekdays = field(weekday, 0, 7, DAY_NAMES);
    // 7 is Sunday too, which is how half the people writing these count.
    if (weekdays.has(7)) {
        weekdays.delete(7);
        weekdays.add(0);
    }
    return {
        minutes: field(minute, 0, 59),
        hours: field(hour, 0, 23),
        days: field(day, 1, 31),
        months: field(month, 1, 12, MONTH_NAMES),
        weekdays,
        anyDay: day === "*",
        anyWeekday: weekday === "*"
    };
}

/** The wall-clock fields of an instant in a time zone. */
interface Wall {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: Date, timeZone: string): Wall {
    let format = formatters.get(timeZone);
    if (!format) {
        format = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            weekday: "short"
        });
        formatters.set(timeZone, format);
    }
    const parts = Object.fromEntries(
        format.formatToParts(at).map((part) => [part.type, part.value])
    );
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        weekday: DAY_NAMES.indexOf(String(parts.weekday).slice(0, 3).toUpperCase())
    };
}

function dayMatches(schedule: CronSchedule, wall: Wall): boolean {
    if (!schedule.months.has(wall.month)) return false;
    const byDay = schedule.days.has(wall.day);
    const byWeekday = schedule.weekdays.has(wall.weekday);
    if (schedule.anyDay && schedule.anyWeekday) return true;
    if (schedule.anyDay) return byWeekday;
    if (schedule.anyWeekday) return byDay;
    return byDay || byWeekday;
}

const MINUTE = 60_000;

/** How far clocks go back in any zone in use: half an hour, an hour, or two. */
const SETBACKS = [30, 60, 120];

function sameDay(a: Wall, b: Wall): boolean {
    return a.year === b.year && a.month === b.month && a.day === b.day;
}

function sameMinute(a: Wall, b: Wall): boolean {
    return sameDay(a, b) && a.hour === b.hour && a.minute === b.minute;
}

/**
 * The first instant of the day `at` falls on.
 *
 * Needed after skipping a day by its wall-clock length: a day the clocks went
 * forward on is shorter than that, so the skip lands past the next midnight.
 * Where midnight itself does not exist, `at` is already the day's first minute.
 */
function startOfDay(at: number, wall: Wall, timeZone: string): number {
    const midnight = at - (wall.hour * 60 + wall.minute) * MINUTE;
    return sameDay(wallClock(new Date(midnight), timeZone), wall) ? midnight : at;
}

/** Whether the wall clock already read this minute earlier, because the clocks
 *  went back since. */
function repeatedMinute(at: number, wall: Wall, timeZone: string): boolean {
    return SETBACKS.some((minutes) =>
        sameMinute(wallClock(new Date(at - minutes * MINUTE), timeZone), wall)
    );
}

/**
 * The next time a schedule fires strictly after `after`, or null when it never
 * does within the next four years (a 30th of February, say).
 *
 * Walks forward in real time and reads the wall clock at each step, skipping a
 * whole day or hour at a time when that is what does not match - a few thousand
 * steps for the worst expression, rather than every minute of a year.
 *
 * A minute the clocks repeat fires only the first time, for a schedule that
 * names its hours. One that runs every hour keeps running through the repeated
 * hour, since it names no time of day that could happen twice.
 */
export function nextCronRun(schedule: CronSchedule, after: Date, timeZone = "UTC"): Date | null {
    let at = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
    const limit = after.getTime() + 4 * 366 * 24 * 60 * MINUTE;
    const everyHour = schedule.hours.size === 24;
    while (at <= limit) {
        const wall = wallClock(new Date(at), timeZone);
        if (!dayMatches(schedule, wall)) {
            const next = at + ((23 - wall.hour) * 60 + (60 - wall.minute)) * MINUTE;
            const landed = wallClock(new Date(next), timeZone);
            at = sameDay(landed, wall) ? next : startOfDay(next, landed, timeZone);
            continue;
        }
        if (!schedule.hours.has(wall.hour)) {
            at += (60 - wall.minute) * MINUTE;
            continue;
        }
        if (
            schedule.minutes.has(wall.minute) &&
            (everyHour || !repeatedMinute(at, wall, timeZone))
        ) {
            return new Date(at);
        }
        at += MINUTE;
    }
    return null;
}

/** A schedule in words, for the list: the shorthands and the commonest shapes,
 *  and the expression itself for everything else. */
export function describeCron(expression: string): string {
    const trimmed = expression.trim().toLowerCase();
    const known: Record<string, string> = {
        "@hourly": "Every hour",
        "@daily": "Every day at midnight",
        "@midnight": "Every day at midnight",
        "@weekly": "Every Sunday at midnight",
        "@monthly": "On the 1st of every month",
        "@yearly": "Every 1 January",
        "@annually": "Every 1 January",
        "* * * * *": "Every minute"
    };
    if (known[trimmed]) return known[trimmed] as string;
    const every = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed);
    if (every) return `Every ${every[1]} minutes`;
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed);
    if (daily) return `Every day at ${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`;
    return expression.trim();
}

/**
 * A scheduled job for a deployed service, as its form sends it.
 *
 * The command is run with `sh -c` inside the service's container, as a single
 * argument - never spliced into a shell line - so it may hold anything a shell
 * line can, newlines included. A NUL is the one thing no argument can carry.
 */
export const serviceCronInputSchema = z.object({
    id: z.string().uuid().optional(),
    name: z
        .string()
        .trim()
        .min(1, "A name is required")
        .max(64, "Keep the name under 64 characters"),
    schedule: z.lazy(() => cronExpression),
    timezone: z
        .string()
        .trim()
        .max(64)
        .default("UTC")
        // A named zone: the display settings' "automatic" means the viewer's
        // own, and a schedule has no viewer to take one from.
        .refine(
            (value) => value !== AUTOMATIC_TIME_ZONE && isTimeZone(value),
            "That is not a time zone this server knows"
        ),
    command: z
        .string()
        .trim()
        .min(1, "A command is required")
        .max(4000, "Keep the command under 4000 characters")
        .refine(
            (value) => !value.includes(String.fromCharCode(0)),
            "The command cannot contain a NUL character"
        ),
    timeoutSeconds: z
        .number()
        .int()
        .min(10, "At least 10 seconds")
        .max(86_400, "At most a day")
        .default(900),
    maxAttempts: z.number().int().min(1).max(10, "At most 10 tries").default(1),
    retryDelaySeconds: z.number().int().min(10, "At least 10 seconds").max(86_400).default(60),
    enabled: z.boolean().default(true)
});

export type ServiceCronInput = z.infer<typeof serviceCronInputSchema>;

/** A schedule field as a form takes it: readable, and refused with the reason. */
export const cronExpression = z
    .string()
    .trim()
    .min(1, "A schedule is required")
    .max(120)
    .superRefine((value, ctx) => {
        try {
            parseCron(value);
        } catch (error) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: error instanceof CronError ? error.message : "That is not a schedule"
            });
        }
    });
