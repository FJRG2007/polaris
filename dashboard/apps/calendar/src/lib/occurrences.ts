/**
 * The events and tasks inside one window, as the calendar draws them.
 *
 * One indexed query finds every object that can reach the window - it starts
 * before the window ends, and it ends (or repeats forever) after the window
 * starts - and the engine expands each into its occurrences. Parsing is the
 * cost, so the parsed item of each row is kept in memory by row and version:
 * paging back and forth through the same weeks parses nothing twice.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { OccurrenceView, RangeView, TaskItemView } from "./wire";
import { reachableCalendars, reaches, todoClassification, type Reach, type SessionUser } from "./access";

/** The widest window answered: a year view with the weeks around it. */
export const MAX_WINDOW_DAYS = 400;

/** Objects read for one window at most. A calendar that holds more inside one
 *  year view than this is drawn partially and says so. */
const MAX_OBJECTS = 5000;

/**
 * How far apart two readings of the same floating time or all-day date can be:
 * from UTC+14 to UTC-12. An object's indexed bounds are read in the zone of
 * whoever saved it, and the window in the reader's, so a query widens by this
 * much on each side and the expansion below keeps only what is really inside.
 */
const ZONE_SPREAD_MS = 26 * 3_600_000;

/** The filter for the objects that can reach a window, read in any zone. */
export function reachingWindow(window: { from: Date; to: Date }) {
    const to = new Date(window.to.getTime() + ZONE_SPREAD_MS);
    const from = new Date(window.from.getTime() - ZONE_SPREAD_MS);
    return {
        OR: [{ startsAt: null }, { startsAt: { lt: to } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: from } }] }]
    };
}

/** Parsed items by row id, keyed by the version they were parsed from. */
const parsed = new Map<string, { version: number; item: engine.CalendarItem | null }>();
const PARSED_CAP = 4000;

function parsedItem(row: { id: string; ics: string; updatedAt: Date }): engine.CalendarItem | null {
    const version = row.updatedAt.getTime();
    const held = parsed.get(row.id);
    if (held && held.version === version) return held.item;
    let item: engine.CalendarItem | null = null;
    try {
        item = engine.parseCalendarText(row.ics).items[0] ?? null;
    } catch {
        item = null;
    }
    if (parsed.size >= PARSED_CAP) parsed.delete(parsed.keys().next().value as string);
    parsed.set(row.id, { version, item });
    return item;
}

/** Whether an occurrence may be drawn in full to a reader at this level. */
function shownInFull(reach: Reach, event: engine.CalendarEvent): boolean {
    if (reach === "freebusy") return false;
    if (reaches(reach, "write")) return true;
    return event.classification === "PUBLIC";
}

function partstatOf(event: engine.CalendarEvent, emails: ReadonlySet<string>): engine.PartStat | null {
    return event.attendees.find((attendee) => emails.has(attendee.email))?.partstat ?? null;
}

/**
 * Everything drawn between two instants, for one reader.
 *
 * `calendarIds` narrows to those calendars (the ones shown); `floatingZone` is
 * the reader's zone, what a floating time or an all-day date is read in.
 */
export async function occurrencesIn(
    user: SessionUser,
    window: { from: Date; to: Date },
    options: {
        floatingZone: string;
        calendarIds?: readonly string[];
        emails: readonly string[];
        includeTasks: boolean;
    }
): Promise<RangeView> {
    const reach = await reachableCalendars(user.id);
    const wanted = (options.calendarIds ?? [...reach.keys()]).filter((id) => reach.has(id));
    const calendars = await prisma.calendar.findMany({
        where: { id: { in: wanted }, trashedAt: null },
        select: { id: true, readOnly: true }
    });
    const readOnly = new Map(calendars.map((calendar) => [calendar.id, calendar.readOnly]));
    const ids = calendars.map((calendar) => calendar.id);
    const emails = new Set(options.emails.map((email) => email.toLowerCase()));

    const found =
        ids.length === 0
            ? []
            : await prisma.calendarObject.findMany({
                  where: {
                      calendarId: { in: ids },
                      deletedAt: null,
                      ...reachingWindow(window)
                  },
                  select: { id: true, calendarId: true, uid: true, ics: true, updatedAt: true, component: true },
                  orderBy: [{ startsAt: "asc" }, { id: "asc" }],
                  take: MAX_OBJECTS + 1
              });
    const truncated = found.length > MAX_OBJECTS;
    const rows = found.slice(0, MAX_OBJECTS);

    const occurrences: OccurrenceView[] = [];
    const tasks: TaskItemView[] = [];
    let unreadable = 0;
    for (const row of rows) {
        const item = parsedItem(row);
        if (!item) {
            unreadable += 1;
            continue;
        }
        const level = reach.get(row.calendarId)!;
        const editable = reaches(level, "write") && !readOnly.get(row.calendarId);
        if (item.component === "VTODO") {
            if (!options.includeTasks || level === "freebusy") continue;
            if (!reaches(level, "write") && todoClassification(item.todo) !== "PUBLIC") continue;
            const placed = engine.expandTodo(item, options.floatingZone);
            const when = placed.due ?? placed.start;
            if (!when || when < window.from || when >= window.to) continue;
            tasks.push({
                source: "calendar",
                id: row.id,
                calendarId: row.calendarId,
                title: item.todo.summary,
                due: when.toISOString(),
                allDay: placed.allDay,
                done: item.todo.status === "COMPLETED",
                reference: null,
                listName: null,
                editable
            });
            continue;
        }
        let expanded: engine.Occurrence[];
        try {
            expanded = engine.expandItem(item, window, { floatingZone: options.floatingZone });
        } catch {
            unreadable += 1;
            continue;
        }
        for (const occurrence of expanded) {
            const event = occurrence.event;
            const full = shownInFull(level, event);
            occurrences.push({
                objectId: row.id,
                calendarId: row.calendarId,
                uid: full ? occurrence.uid : "",
                recurrenceKey: occurrence.recurrenceKey,
                start: occurrence.start.toISOString(),
                end: occurrence.end.toISOString(),
                allDay: occurrence.allDay,
                startDate: occurrence.startDate,
                endDate: occurrence.endDate,
                summary: full ? event.summary : "",
                location: full ? event.location : "",
                color: full ? event.color : null,
                status: event.status,
                transparent: event.transparency === "TRANSPARENT",
                recurring: occurrence.recurring,
                overridden: occurrence.overridden,
                kind: event.kind,
                attendeeCount: full ? event.attendees.length : 0,
                myPartstat: partstatOf(event, emails),
                hasAlarms: full && event.alarms.length > 0,
                busyOnly: !full,
                editable: editable && full,
                conference: full ? event.conference : "",
                categories: full ? event.categories : []
            });
        }
    }

    if (options.includeTasks) {
        const assigned = await host.calendarHost.assignedTasks(user.id, window).catch(() => []);
        for (const task of assigned) {
            tasks.push({
                source: "tasks",
                id: task.id,
                calendarId: null,
                title: task.name,
                due: task.due,
                allDay: !task.timed,
                done: task.done,
                reference: task.reference,
                listName: task.listName,
                editable: true
            });
        }
    }

    occurrences.sort((left, right) => left.start.localeCompare(right.start));
    return {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        occurrences,
        tasks,
        unreadable,
        truncated
    };
}

/** Every address somebody answers invitations at, lowercased: their account
 *  address and the ones they added and proved. */
export async function verifiedAddresses(userId: string, primary: string): Promise<string[]> {
    const extra = await prisma.userEmail.findMany({
        where: { userId, verifiedAt: { not: null } },
        select: { email: true }
    });
    return [...new Set([primary, ...extra.map((row) => row.email)].map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

/** Every address this person answers invitations at. */
export async function addressesOf(user: SessionUser): Promise<string[]> {
    return verifiedAddresses(user.id, user.email);
}
