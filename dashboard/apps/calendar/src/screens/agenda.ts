/**
 * The phone's schedule: the grid's events laid out as days, the way Google
 * Calendar's Schedule view and Apple's list under the month do it.
 *
 * Each day lists what touches it: the all-day events first, then the timed
 * ones by start. An event over several days is listed on every one of them,
 * marked as the day it starts, a day in between or the day it ends, so the
 * reader sees it is still going. A day with nothing on it is left out - except
 * today, which is always there to say where "now" is in the list.
 *
 * Pure, over the grid's own `EventInput`s (wall times of the display zone), so
 * the list and the grid can never disagree about what a day holds.
 */

import type { EventInput } from "@fullcalendar/core";
import { addDays, type DayString, type DayWindow } from "./time";

/** Where in a multi-day event this day falls; null for an event of one day. */
export type AgendaPart = "first" | "middle" | "last" | null;

export interface AgendaEntry {
    readonly event: EventInput;
    readonly allDay: boolean;
    /** Wall times `YYYY-MM-DDTHH:mm:ss`; null for an all-day event. */
    readonly start: string | null;
    readonly end: string | null;
    readonly part: AgendaPart;
}

export interface AgendaDay {
    readonly day: DayString;
    readonly entries: readonly AgendaEntry[];
}

function text(value: EventInput["start"]): string | null {
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString().slice(0, 19);
    return null;
}

/** The days an event covers: its first day and the day after its last. */
function coverage(event: EventInput): { first: DayString; after: DayString } | null {
    const start = text(event.start);
    if (!start) return null;
    const first = start.slice(0, 10);
    const end = text(event.end);
    if (event.allDay) {
        // An all-day end is the day after (exclusive), as iCalendar has it.
        const after = end ? end.slice(0, 10) : addDays(first, 1);
        return { first, after: after > first ? after : addDays(first, 1) };
    }
    if (!end || end <= start) return { first, after: addDays(first, 1) };
    // A timed event that ends at midnight is over before that day begins.
    const endDay = end.slice(0, 10);
    const after = end.slice(11) === "00:00:00" ? endDay : addDays(endDay, 1);
    return { first, after: after > first ? after : addDays(first, 1) };
}

function order(a: AgendaEntry, b: AgendaEntry): number {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const start = (a.start ?? "").localeCompare(b.start ?? "");
    if (start !== 0) return start;
    return String(a.event.title ?? "").localeCompare(String(b.event.title ?? ""));
}

/** The schedule of `window`: its days with something on them, and today. */
export function agendaDays(
    events: readonly EventInput[],
    window: DayWindow,
    today: DayString
): AgendaDay[] {
    const byDay = new Map<DayString, AgendaEntry[]>();
    for (const event of events) {
        // The grid's own shading (the past part of today) is not an event.
        if (event.display === "background") continue;
        const span = coverage(event);
        if (!span) continue;
        const from = span.first > window.start ? span.first : window.start;
        const after = span.after < window.end ? span.after : window.end;
        const several = addDays(span.first, 1) !== span.after;
        for (let day = from; day < after; day = addDays(day, 1)) {
            const part: AgendaPart = !several
                ? null
                : day === span.first
                  ? "first"
                  : addDays(day, 1) === span.after
                    ? "last"
                    : "middle";
            const entry: AgendaEntry = {
                event,
                allDay: event.allDay === true,
                start: event.allDay ? null : text(event.start),
                end: event.allDay ? null : text(event.end),
                part
            };
            const list = byDay.get(day);
            if (list) list.push(entry);
            else byDay.set(day, [entry]);
        }
    }
    if (today >= window.start && today < window.end && !byDay.has(today)) byDay.set(today, []);
    return [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, entries]) => ({ day, entries: entries.sort(order) }));
}

/** The colours of what a day holds, for the month's dots: at most `limit`,
 *  one per event, in the schedule's order. */
export function dayDots(day: AgendaDay | undefined, limit: number): string[] {
    if (!day) return [];
    return day.entries
        .slice(0, limit)
        .map((entry) =>
            String(entry.event.borderColor || entry.event.backgroundColor || "currentColor")
        );
}
