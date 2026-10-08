/**
 * What the calendar draws, worked out without drawing anything.
 *
 * The view owns the markup; this owns the questions that have right answers -
 * which days a scope covers, which day an entry belongs on, and how two things
 * happening at once sit beside each other. Kept apart from the component so
 * those answers can be tested directly rather than through a rendered grid, and
 * so a second calendar surface could reuse them.
 */

import * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import type { GoogleEvent } from "@/lib/google-calendar/events-client";

export const CALENDAR_SCOPES = ["day", "week", "month", "year", "schedule", "fourDays"] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

/** The key that switches to each scope - Google Calendar's own, so a hand that
 *  learned them there does not have to learn a second set here. */
export const SCOPE_KEYS: Record<CalendarScope, string> = {
    day: "D",
    week: "W",
    month: "M",
    year: "Y",
    schedule: "A",
    fourDays: "X"
};

/** The scope a bare key press asks for, or null when it asks for none. */
export function scopeForKey(key: string): CalendarScope | null {
    const pressed = key.toUpperCase();
    return CALENDAR_SCOPES.find((scope) => SCOPE_KEYS[scope] === pressed) ?? null;
}

/** How far a schedule reaches, and how far one press of next moves it. */
export const SCHEDULE_DAYS = 28;

/** What the calendar shows beside the scope, each one on until turned off. */
export interface CalendarOptions {
    readonly showWeekends: boolean;
    readonly showDeclined: boolean;
    readonly showCompleted: boolean;
}

export const DEFAULT_OPTIONS: CalendarOptions = {
    showWeekends: true,
    showDeclined: true,
    showCompleted: true
};

/** Saturday or Sunday - the days "show weekends" is about, wherever the week
 *  begins. */
export function isWeekend(day: Date): boolean {
    return day.getDay() === 0 || day.getDay() === 6;
}

/** Google's own blue, so an event is never read as one of the space's statuses. */
export const GOOGLE_COLOR = "#4285f4";

/** How long a task's block is drawn for. A task is an instant, and a hairline
 *  block is one nobody can hit with a pointer. */
export const TASK_BLOCK_MINUTES = 30;

/** Anything on a day, whether it came from a task or from a calendar. */
export interface CalendarEntry {
    readonly key: string;
    readonly title: string;
    readonly start: Date;
    /** Events carry one; a task is a point in time. */
    readonly end: Date | null;
    /** Drawn in the all-day strip rather than at an hour. */
    readonly allDay: boolean;
    readonly color: string;
    /** The task this stands for, or null for an outside event. */
    readonly task: TaskRow | null;
    /** A finished task or a declined invitation: still drawn, but struck through
     *  and faded, the way the thing it stands for no longer needs anybody. */
    readonly settled: boolean;
    /** An invitation the account said no to. */
    readonly declined: boolean;
    readonly location?: string;
    readonly url?: string;
}

export interface CalendarRange {
    readonly days: Date[];
    readonly label: string;
    /** The month a month grid is about, so the days spilling in from either side
     *  can be dimmed. */
    readonly monthShown: number;
}

/**
 * The days a scope covers, and what the header calls them.
 *
 * A month always runs in whole weeks - from the first day of the week its 1st
 * falls in to the last day of the week its last day falls in - so the grid is
 * always seven columns wide however the account starts its weeks, or five when
 * weekends are hidden. Hiding them drops Saturday and Sunday from a week, a
 * month and four days; a single day, a year and a schedule keep every day, the
 * way Google's do.
 */
export function buildRange(
    scope: CalendarScope,
    offset: number,
    weekStartsOn: number,
    format: core.DisplayFormat,
    now: Date = new Date(),
    /** The reader's language, for the day and month names in the heading. */
    locale: string = "en-US",
    showWeekends: boolean = true
): CalendarRange {
    const today = core.startOfDay(now);
    const span = (days: Date[]) =>
        `${format.date(days[0] as Date)} - ${format.date(days[days.length - 1] as Date)}`;
    const keep = (days: Date[]) => (showWeekends ? days : days.filter((day) => !isWeekend(day)));

    if (scope === "day") {
        const day = core.addDays(today, offset);
        return {
            days: [day],
            label: `${core.weekdayNames(locale, "long")[day.getDay()]}, ${format.date(day)}`,
            monthShown: day.getMonth()
        };
    }
    if (scope === "week") {
        const first = core.addDays(core.startOfWeek(now, weekStartsOn), offset * 7);
        const days = keep(Array.from({ length: 7 }, (_, index) => core.addDays(first, index)));
        return { days, label: span(days), monthShown: first.getMonth() };
    }
    if (scope === "fourDays") {
        const days = showWeekends
            ? Array.from({ length: 4 }, (_, index) => core.addDays(today, offset * 4 + index))
            : workdaysFrom(today, offset * 4, 4);
        return { days, label: span(days), monthShown: (days[0] as Date).getMonth() };
    }
    if (scope === "schedule") {
        const first = core.addDays(today, offset * SCHEDULE_DAYS);
        const days = Array.from({ length: SCHEDULE_DAYS }, (_, index) =>
            core.addDays(first, index)
        );
        return { days, label: span(days), monthShown: first.getMonth() };
    }
    if (scope === "year") {
        const year = now.getFullYear() + offset;
        const days: Date[] = [];
        for (
            let cursor = new Date(year, 0, 1);
            cursor.getFullYear() === year;
            cursor = core.addDays(cursor, 1)
        ) {
            days.push(cursor);
        }
        return { days, label: String(year), monthShown: 0 };
    }
    const anchor = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const first = core.startOfWeek(anchor, weekStartsOn);
    const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const last = core.addDays(core.startOfWeek(monthEnd, weekStartsOn), 6);
    const days: Date[] = [];
    for (let cursor = first; cursor <= last; cursor = core.addDays(cursor, 1)) days.push(cursor);
    return {
        days: keep(days),
        label: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(anchor),
        monthShown: anchor.getMonth()
    };
}

/**
 * `count` working days, starting `skip` working days away from `from`.
 *
 * Four days with weekends hidden is the next four working days, and paging it
 * moves by four working days - so a Friday is followed by a Monday rather than
 * by a column that was taken away.
 */
export function workdaysFrom(from: Date, skip: number, count: number): Date[] {
    let cursor = core.startOfDay(from);
    while (isWeekend(cursor)) cursor = core.addDays(cursor, 1);
    const step = skip < 0 ? -1 : 1;
    for (let moved = 0; moved < Math.abs(skip); ) {
        cursor = core.addDays(cursor, step);
        if (!isWeekend(cursor)) moved += 1;
    }
    const days: Date[] = [];
    for (; days.length < count; cursor = core.addDays(cursor, 1)) {
        if (!isWeekend(cursor)) days.push(cursor);
    }
    return days;
}

/**
 * A month as a year view draws it: whole weeks from the account's first day,
 * with null where a week reaches into the months either side.
 */
export function monthWeeks(year: number, month: number, weekStartsOn: number): (Date | null)[][] {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() - weekStartsOn + 7) % 7;
    const length = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = Array.from({ length: lead }, () => null);
    for (let date = 1; date <= length; date += 1) cells.push(new Date(year, month, date));
    while (cells.length % 7 !== 0) cells.push(null);
    return Array.from({ length: cells.length / 7 }, (_, week) =>
        cells.slice(week * 7, week * 7 + 7)
    );
}

/** The height of one line in a month cell, and the gap between two of them. The
 *  chips are drawn at exactly this, so how many fit is arithmetic rather than a
 *  guess. */
export const CHIP_HEIGHT = 20;
export const CHIP_GAP = 2;

/** What a month cell draws when nothing has measured it yet - the server, and a
 *  first paint before the grid has a size. */
const UNMEASURED_CHIPS = 4;

/**
 * How many of a day's entries its cell can show, given the room it has.
 *
 * Everything is shown when it fits. When it does not, one line is given up to
 * the "+N more" that stands for the rest, so the count never lands half under
 * the cell's edge.
 */
export function chipsThatFit(height: number, count: number): number {
    if (height <= 0) return count <= UNMEASURED_CHIPS ? count : UNMEASURED_CHIPS - 1;
    const slots = Math.floor((height + CHIP_GAP) / (CHIP_HEIGHT + CHIP_GAP));
    if (count <= slots) return count;
    return Math.max(0, slots - 1);
}

/**
 * The status a task moves to when its check is pressed, or null when this
 * screen cannot say.
 *
 * Done when it is not finished; the first status that is not finished when it
 * is - the one work restarts in. Null when the task is not in the space whose
 * statuses the screen holds, because a status id from another space is one the
 * server would refuse.
 */
export function completionTarget(
    task: Pick<TaskRow, "statusId" | "statusType">,
    statuses: readonly { readonly id: string; readonly type: core.TaskStatusType }[]
): string | null {
    if (!task.statusId || !statuses.some((status) => status.id === task.statusId)) return null;
    if (core.isFinishedStatus(task.statusType)) {
        const open = statuses.find((status) => status.type === "open");
        return (open ?? statuses.find((status) => !core.isFinishedStatus(status.type)))?.id ?? null;
    }
    return statuses.find((status) => status.type === "done")?.id ?? null;
}

/** Whether an entry is drawn at all with these options. */
export function isShown(entry: CalendarEntry, options: CalendarOptions): boolean {
    if (!options.showDeclined && entry.declined) return false;
    if (!options.showCompleted && entry.task && core.isFinishedStatus(entry.task.statusType))
        return false;
    return true;
}

/** A task as the calendar draws it, or null when it has no date to draw it on. */
export function taskEntry(task: TaskRow): CalendarEntry | null {
    const at = task.dueDate ?? task.startDate;
    if (!at) return null;
    const start = new Date(at);
    if (Number.isNaN(start.getTime())) return null;
    return {
        key: `task:${task.id}`,
        title: task.name,
        start,
        end: null,
        // A task with no time of day belongs to the whole day rather than to
        // midnight, which is where an hour grid would otherwise park it.
        allDay: !task.timed,
        color: task.statusColor,
        task,
        settled: core.isFinishedStatus(task.statusType),
        declined: false
    };
}

export function googleEntry(event: GoogleEvent): CalendarEntry {
    const start = readWireDate(event.start);
    // Google ends an all-day event on the morning after it finishes. Taken
    // literally that draws a one-day event across two, so the exclusive end is
    // pulled back inside the last day it actually covers.
    const rawEnd = event.end ? readWireDate(event.end) : null;
    const end = rawEnd && event.allDay ? new Date(rawEnd.getTime() - 1) : rawEnd;
    return {
        key: `google:${event.id}`,
        title: event.title,
        start,
        end,
        allDay: event.allDay,
        color: GOOGLE_COLOR,
        task: null,
        // Optional on the wire: a window cached before the field existed reads
        // as accepted, which is what it was drawn as then.
        settled: event.declined === true,
        declined: event.declined === true,
        location: event.location ?? undefined,
        url: event.url ?? undefined
    };
}

/**
 * A date off the wire, read in the reader's own timezone.
 *
 * An all-day event arrives as `2026-08-05`, which `new Date` reads as UTC
 * midnight - and that is the 4th for anybody west of Greenwich. Building it from
 * its parts keeps a day-long event on the day it says.
 */
export function readWireDate(value: string): Date {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) return new Date(value);
    return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

/** Whether an entry belongs on this day. A multi-day event appears on each day
 *  it covers rather than only on the one it began. */
export function coversDay(entry: CalendarEntry, day: Date): boolean {
    if (core.isSameDay(entry.start, day)) return true;
    if (!entry.end) return false;
    return entry.start < core.endOfDay(day) && entry.end > core.startOfDay(day);
}

/** Everything on a day, all-day items first and the rest in clock order. */
export function entriesOnDay(entries: readonly CalendarEntry[], day: Date): CalendarEntry[] {
    return entries
        .filter((entry) => coversDay(entry, day))
        .sort(
            (left, right) =>
                Number(right.allDay) - Number(left.allDay) ||
                left.start.getTime() - right.start.getTime()
        );
}

/** How many entries fall on each day from `first` to `last`, keyed by
 *  `toDateString()`, counted on the same days `coversDay` places them. */
export function countByDay(
    entries: readonly CalendarEntry[],
    first: Date,
    last: Date
): Map<string, number> {
    const found = new Map<string, number>();
    for (const entry of entries) {
        let cursor = core.startOfDay(entry.start < first ? first : entry.start);
        for (; cursor <= last && coversDay(entry, cursor); cursor = core.addDays(cursor, 1)) {
            const key = cursor.toDateString();
            found.set(key, (found.get(key) ?? 0) + 1);
        }
    }
    return found;
}

/** Minutes from midnight, which is what positions a block in an hour grid. */
export function minutesInto(date: Date): number {
    return date.getHours() * 60 + date.getMinutes();
}

export interface PlacedEntry {
    readonly entry: CalendarEntry;
    readonly lane: number;
    /** How many lanes the run this entry belongs to needs. */
    readonly lanes: number;
}

/**
 * Side-by-side placement for entries that overlap in time.
 *
 * Each entry takes the first lane whose previous occupant has already finished,
 * so two meetings at the same hour end up beside each other instead of one
 * hiding the other. Everything in a run of overlaps is drawn at the width of the
 * widest point of that run, which keeps their left edges aligned; a gap with
 * nothing running ends the run, so an afternoon meeting is not narrowed by a
 * busy morning.
 */
export function laneOut(entries: readonly CalendarEntry[]): PlacedEntry[] {
    const sorted = [...entries].sort((left, right) => left.start.getTime() - right.start.getTime());
    const placed: { entry: CalendarEntry; lane: number; group: number }[] = [];
    const laneEnds: number[] = [];
    let group = 0;
    let groupEnd = 0;

    for (const entry of sorted) {
        const start = entry.start.getTime();
        const end = entry.end ? entry.end.getTime() : start + TASK_BLOCK_MINUTES * 60_000;
        if (placed.length > 0 && start >= groupEnd) {
            group += 1;
            laneEnds.length = 0;
        }
        let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(end);
        } else {
            laneEnds[lane] = end;
        }
        groupEnd = Math.max(groupEnd, end);
        placed.push({ entry, lane, group });
    }

    const widthOf = new Map<number, number>();
    for (const item of placed)
        widthOf.set(item.group, Math.max(widthOf.get(item.group) ?? 1, item.lane + 1));
    return placed.map((item) => ({
        entry: item.entry,
        lane: item.lane,
        lanes: widthOf.get(item.group) ?? 1
    }));
}
