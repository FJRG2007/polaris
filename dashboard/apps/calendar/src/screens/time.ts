/**
 * Dates as the calendar screen thinks about them.
 *
 * The grid runs in UTC and is handed wall times of the reader's display zone:
 * an instant is turned into the wall time it reads as in that zone, and a
 * `Date` the grid hands back is read by its UTC fields as a wall time and
 * turned into the instant it names there. Nothing here reads the browser's own
 * zone unless the reader asked for it ("auto"), so a named zone is exact.
 *
 * Pure: no clock is read except where one is passed in.
 */

import * as engine from "../engine";
import { VIEWS, type CalendarViewName } from "../lib/preferences";

/** `YYYY-MM-DD`. */
export type DayString = string;

/** The zone this browser is in, UTC when it will not say. */
export function browserZone(): string {
    try {
        return engine.resolveZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
    } catch {
        return "UTC";
    }
}

/**
 * The zone the calendar is drawn in: the calendar's own setting, then the
 * account's display zone, then the browser's.
 */
export function displayZone(
    calendarSetting: string,
    accountSetting: string | null | undefined
): string {
    if (calendarSetting !== "auto") {
        const chosen = engine.resolveZone(calendarSetting);
        if (chosen) return chosen;
    }
    if (accountSetting && accountSetting !== "auto") {
        const account = engine.resolveZone(accountSetting);
        if (account) return account;
    }
    return browserZone();
}

export function isDayString(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
    return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}

/** Today in a zone. */
export function todayIn(zone: string, now: Date): DayString {
    return engine.localDate(now, zone);
}

/** The wall time an instant reads as in a zone, `YYYY-MM-DDTHH:mm:ss`. */
export function wallOf(instant: string | Date, zone: string): string {
    return engine.formatWall(engine.instantToWall(new Date(instant), zone));
}

/** A grid date (UTC fields are the wall time) as the wall time it shows. */
export function gridWall(date: Date): engine.WallTime {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds()
    };
}

/** A grid date as the instant it names in `zone`. */
export function gridInstant(date: Date, zone: string): Date {
    return engine.wallToInstant(gridWall(date), zone);
}

/** A grid date's calendar day. */
export function gridDay(date: Date): DayString {
    return date.toISOString().slice(0, 10);
}

/** The instant midnight of `day` is in `zone`. */
export function dayStart(day: DayString, zone: string): Date {
    return engine.wallToInstant(engine.parseWall(day), zone);
}

export const addDays = engine.addDays;

/** 0 = Sunday .. 6 = Saturday. */
export function weekday(day: DayString): number {
    return engine.weekdayIndex(day);
}

/** A month later or earlier, the day kept where the month has it. */
export function addMonths(day: DayString, months: number): DayString {
    const wall = engine.parseWall(day);
    const index = wall.year * 12 + (wall.month - 1) + months;
    const year = Math.floor(index / 12);
    const month = index - year * 12 + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(Math.min(wall.day, last))}`;
}

export function firstOfMonth(day: DayString): DayString {
    return `${day.slice(0, 7)}-01`;
}

/** The first day of the week `day` is in. */
export function weekStartOf(day: DayString, firstDay: number): DayString {
    return addDays(day, -((weekday(day) - firstDay + 7) % 7));
}

/** Days from one to another. */
export const daysBetween = engine.daysBetween;

/** A window of days, end exclusive. */
export interface DayWindow {
    readonly start: DayString;
    readonly end: DayString;
}

/** How many days the list (agenda) view covers. */
export const LIST_DAYS = 30;

/** The days a view shows around `anchor`, the way the grid lays them out. */
export function viewWindow(
    view: CalendarViewName,
    anchor: DayString,
    firstDay: number,
    customDays: number
): DayWindow {
    switch (view) {
        case "day":
            return { start: anchor, end: addDays(anchor, 1) };
        case "week": {
            const start = weekStartOf(anchor, firstDay);
            return { start, end: addDays(start, 7) };
        }
        case "days":
            return { start: anchor, end: addDays(anchor, customDays) };
        case "month": {
            // Six whole weeks from the week the 1st falls in, as the month grid draws.
            const start = weekStartOf(firstOfMonth(anchor), firstDay);
            return { start, end: addDays(start, 42) };
        }
        case "year":
            return {
                start: `${anchor.slice(0, 4)}-01-01`,
                end: `${String(Number(anchor.slice(0, 4)) + 1).padStart(4, "0")}-01-01`
            };
        case "list":
            return { start: anchor, end: addDays(anchor, LIST_DAYS) };
    }
}

/** The anchor one step before or after, for previous and next. */
export function stepAnchor(
    view: CalendarViewName,
    anchor: DayString,
    direction: 1 | -1,
    customDays: number
): DayString {
    switch (view) {
        case "day":
            return addDays(anchor, direction);
        case "week":
            return addDays(anchor, 7 * direction);
        case "days":
            return addDays(anchor, customDays * direction);
        case "month":
            return addMonths(anchor, direction);
        case "year":
            return addMonths(anchor, 12 * direction);
        case "list":
            return addDays(anchor, LIST_DAYS * direction);
    }
}

/** A window of days as the instants the server is asked between. */
export function windowInstants(window: DayWindow, zone: string): { from: Date; to: Date } {
    return { from: dayStart(window.start, zone), to: dayStart(window.end, zone) };
}

/** What a `/calendar/...` path asks for. */
export interface CalendarRoute {
    readonly view: CalendarViewName | null;
    readonly date: DayString | null;
    readonly objectId: string | null;
    /** `/calendar/new/<when>`: open a new event starting then (the Time
     *  area's meeting planner hands over this way). */
    readonly newAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/calendar/<view>/<date>`, `/calendar/e/<objectId>` and
 *  `/calendar/new/<YYYY-MM-DDTHH:mmZ>`; anything else is the calendar as it was
 *  left. */
export function parseCalendarPath(path: readonly string[]): CalendarRoute {
    const [first, raw] = path;
    let second = raw;
    try {
        second = raw === undefined ? undefined : decodeURIComponent(raw);
    } catch {
        // A malformed escape is read as it was written, and matches nothing.
    }
    if (first === "e" && second && UUID.test(second))
        return { view: null, date: null, objectId: second.toLowerCase(), newAt: null };
    if (first === "new" && second && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(second)) {
        const at = new Date(second);
        if (!Number.isNaN(at.getTime()))
            return { view: null, date: null, objectId: null, newAt: at };
    }
    const view = (VIEWS as readonly string[]).includes(first ?? "")
        ? (first as CalendarViewName)
        : null;
    const date = second && isDayString(second) ? second : null;
    return { view, date, objectId: null, newAt: null };
}

export function calendarPath(view: CalendarViewName, date: DayString): string {
    return `/calendar/${view}/${date}`;
}

export function eventPath(objectId: string): string {
    return `/calendar/e/${objectId}`;
}

/** "HH:mm" of a wall time string. */
export function timeOfWall(wall: string): string {
    return wall.slice(11, 16);
}

/** Minutes after midnight of "HH:mm". */
export function minutesOfTime(time: string): number {
    return engine.minutesOf(time);
}

/** "HH:mm" from minutes after midnight (wrapping a day). */
export function timeOfMinutes(minutes: number): string {
    const day = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(day / 60)).padStart(2, "0")}:${String(day % 60).padStart(2, "0")}`;
}

/** A day string as a Date for Intl, read at noon UTC so no zone moves it. */
export function dayDate(day: DayString): Date {
    return new Date(`${day}T12:00:00Z`);
}

/** Intl for a day string, never shifted by a zone. */
export function formatDay(
    day: DayString,
    locale: string,
    options: Intl.DateTimeFormatOptions
): string {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(dayDate(day));
}

/** Intl for an instant, in the display zone. */
export function formatInstant(
    instant: string | Date,
    locale: string,
    zone: string,
    options: Intl.DateTimeFormatOptions
): string {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(
        new Date(instant)
    );
}

/** The heading of a view: "September 2026", "28 Sep - 4 Oct 2026", "2026". */
export function windowLabel(
    view: CalendarViewName,
    anchor: DayString,
    window: DayWindow,
    locale: string
): string {
    if (view === "year") return formatDay(anchor, locale, { year: "numeric" });
    if (view === "month") return formatDay(anchor, locale, { month: "long", year: "numeric" });
    if (view === "day")
        return formatDay(anchor, locale, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
        });
    const last = addDays(window.end, -1);
    const format = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC"
    });
    return format.formatRange(dayDate(window.start), dayDate(last));
}

/** The weeks of a month for a small month grid: six rows of seven days. */
export function monthGrid(anchor: DayString, firstDay: number): DayString[][] {
    const start = weekStartOf(firstOfMonth(anchor), firstDay);
    return Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 7 }, (__, column) => addDays(start, row * 7 + column))
    );
}

/** Weekday names starting on `firstDay`, from Intl. */
export function weekdayLabels(
    locale: string,
    firstDay: number,
    width: "narrow" | "short" | "long"
): string[] {
    // 2024-01-07 was a Sunday.
    return Array.from({ length: 7 }, (_, index) =>
        formatDay(addDays("2024-01-07", (firstDay + index) % 7), locale, { weekday: width })
    );
}

/** The time zone a "GMT+02:00 Europe/Madrid" label names, for pickers. */
export function zoneOption(zone: string, now: Date, locale: string): string {
    return engine.zoneLabel(zone, now, locale);
}

/**
 * Whether a view already shows today, so "Today" has nowhere to go. A month is
 * the month named in its heading - the days of the months either side it also
 * draws are not it - and a year is the year; anything else is its days.
 */
export function showsToday(
    view: CalendarViewName,
    anchor: DayString,
    window: DayWindow,
    today: DayString
): boolean {
    if (view === "month") return anchor.slice(0, 7) === today.slice(0, 7);
    if (view === "year") return anchor.slice(0, 4) === today.slice(0, 4);
    return today >= window.start && today < window.end;
}

/** Days of the weekend where `locale` is read (0 = Sunday), from Intl where the
 *  browser knows them; Saturday and Sunday where it does not. */
export function weekendDays(locale: string): number[] {
    type WeekInfo = { weekend?: number[] };
    try {
        // `getWeekInfo()` in current engines, the `weekInfo` getter in older ones.
        const intl = new Intl.Locale(locale) as Intl.Locale & {
            getWeekInfo?: () => WeekInfo;
            weekInfo?: WeekInfo;
        };
        const weekend = (intl.getWeekInfo?.() ?? intl.weekInfo)?.weekend;
        // Intl counts Monday as 1 and Sunday as 7.
        if (weekend && weekend.length > 0) return weekend.map((day) => day % 7);
    } catch {
        // A locale Intl does not know has the usual weekend.
    }
    return [6, 0];
}

/** How far into the day a time grid opens: an hour and a half before now, so
 *  the red line sits near the top with what comes next below it. */
export function nowScrollTime(now: Date, zone: string): string {
    const minutes = minutesOfTime(timeOfWall(wallOf(now, zone))) - 90;
    return `${timeOfMinutes(Math.max(0, minutes))}:00`;
}

/** A zone's offset the way a time grid's corner shows it (Google's "GMT+02"),
 *  at the moment given - a zone with summer time has two. */
export function zoneOffsetLabel(zone: string, at: Date, locale: string): string {
    try {
        return (
            new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "shortOffset" })
                .formatToParts(at)
                .find((part) => part.type === "timeZoneName")?.value ?? ""
        );
    } catch {
        return "";
    }
}
