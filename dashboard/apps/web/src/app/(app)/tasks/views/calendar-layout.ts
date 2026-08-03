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

export const CALENDAR_SCOPES = ["day", "week", "month"] as const;
export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

export const SCOPE_LABELS: Record<CalendarScope, string> = { day: "Day", week: "Week", month: "Month" };

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
    readonly location?: string;
    readonly url?: string;
}

const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
] as const;

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
 * always seven columns wide however the account starts its weeks.
 */
export function buildRange(
    scope: CalendarScope,
    offset: number,
    weekStartsOn: number,
    format: core.DisplayFormat,
    now: Date = new Date()
): CalendarRange {
    if (scope === "day") {
        const day = core.addDays(core.startOfDay(now), offset);
        return {
            days: [day],
            label: `${core.WEEKDAY_NAMES[day.getDay()]}, ${format.date(day)}`,
            monthShown: day.getMonth()
        };
    }
    if (scope === "week") {
        const first = core.addDays(core.startOfWeek(now, weekStartsOn), offset * 7);
        const days = Array.from({ length: 7 }, (_, index) => core.addDays(first, index));
        return {
            days,
            label: `${format.date(first)} - ${format.date(days[6] as Date)}`,
            monthShown: first.getMonth()
        };
    }
    const anchor = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const first = core.startOfWeek(anchor, weekStartsOn);
    const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const last = core.addDays(core.startOfWeek(monthEnd, weekStartsOn), 6);
    const days: Date[] = [];
    for (let cursor = first; cursor <= last; cursor = core.addDays(cursor, 1)) days.push(cursor);
    return {
        days,
        label: `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`,
        monthShown: anchor.getMonth()
    };
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
        task
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
                Number(right.allDay) - Number(left.allDay) || left.start.getTime() - right.start.getTime()
        );
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
    for (const item of placed) widthOf.set(item.group, Math.max(widthOf.get(item.group) ?? 1, item.lane + 1));
    return placed.map((item) => ({ entry: item.entry, lane: item.lane, lanes: widthOf.get(item.group) ?? 1 }));
}
