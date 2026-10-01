/**
 * A published calendar as its link shows it: the page, the embed and the .ics
 * feed people subscribe to from Google, Apple or Proton.
 *
 * What a link shows is decided here and nowhere else. `busy` shows only that a
 * time is taken; `full` shows public events in full and private or confidential
 * ones as busy blocks, the way a read-only sharee sees them. Everything is read
 * by token; there is no session.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import type { OccurrenceView } from "./wire";
import { publishedCalendar } from "./sharing";
import { exportCalendarRow } from "./transfer";
import { reachingWindow } from "./occurrences";
import { busyBlock, todoClassification } from "./access";

/** A public event as anybody with the link may read it: what and when, but
 *  not who else is invited, what is attached, or a property nobody here reads. */
function published(event: engine.CalendarEvent): engine.CalendarEvent {
    return { ...event, attendees: [], organizer: null, alarms: [], attachments: [], extra: [], extraComponents: [] };
}

function shown(mode: string, event: engine.CalendarEvent): boolean {
    return mode === "full" && event.classification === "PUBLIC";
}

/** An item as a link in this mode may show it, or null when nothing of it is
 *  shown (a transparent event says nothing about being busy). */
function forLink(item: engine.CalendarItem, mode: string, busyLabel: string): engine.CalendarItem | null {
    // A task's reminders are its owner's, like an event's below.
    if (item.component !== "VEVENT") {
        if (mode !== "full" || todoClassification(item.todo) !== "PUBLIC") return null;
        return { ...item, todo: { ...item.todo, alarms: [], extra: [], extraComponents: [] } };
    }
    // What the page leaves out - free time, cancelled events - the feed does too.
    const events = [item.master, ...item.overrides].filter((event): event is engine.CalendarEvent => Boolean(event));
    if (events.every((event) => event.transparency === "TRANSPARENT" || event.status === "CANCELLED")) return null;
    // Reminders are the owner's, not the subscribers': a feed that carried them
    // would ring on every phone that subscribes to it.
    const map = (event: engine.CalendarEvent) => (shown(mode, event) ? published(event) : busyBlock(event, busyLabel));
    return {
        ...item,
        master: item.master ? map(item.master) : null,
        overrides: item.overrides.map(map)
    };
}

/** The feed a subscription reads. */
export async function publishedFeed(token: string, busyLabel: string): Promise<{ name: string; ics: string } | null> {
    const calendar = await publishedCalendar(token);
    if (!calendar) return null;
    return exportCalendarRow(calendar.id, (ics) => {
        const item = tryItemOf(ics);
        const visible = item ? forLink(item, calendar.publicMode, busyLabel) : null;
        return visible ? engine.serializeItem(visible) : null;
    });
}

/** What the public page draws for one window. */
export async function publishedRange(
    token: string,
    window: { from: Date; to: Date },
    floatingZone: string
): Promise<{ name: string; color: string; description: string; occurrences: OccurrenceView[] } | null> {
    const calendar = await publishedCalendar(token);
    if (!calendar) return null;
    const rows = await prisma.calendarObject.findMany({
        where: {
            calendarId: calendar.id,
            deletedAt: null,
            component: "VEVENT",
            ...reachingWindow(window)
        },
        select: { id: true, ics: true },
        take: 5000
    });
    const occurrences: OccurrenceView[] = [];
    for (const row of rows) {
        const item = tryItemOf(row.ics);
        if (!item) continue;
        let expanded: engine.Occurrence[];
        try {
            expanded = engine.expandItem(item, window, { floatingZone });
        } catch {
            continue;
        }
        for (const occurrence of expanded) {
            const event = occurrence.event;
            if (event.transparency === "TRANSPARENT" || event.status === "CANCELLED") continue;
            const full = shown(calendar.publicMode, event);
            occurrences.push({
                objectId: row.id,
                calendarId: calendar.id,
                uid: "",
                recurrenceKey: occurrence.recurrenceKey,
                start: occurrence.start.toISOString(),
                end: occurrence.end.toISOString(),
                allDay: occurrence.allDay,
                startDate: occurrence.startDate,
                endDate: occurrence.endDate,
                summary: full ? event.summary : "",
                location: full ? event.location : "",
                color: null,
                status: event.status,
                transparent: false,
                recurring: occurrence.recurring,
                overridden: occurrence.overridden,
                kind: event.kind,
                attendeeCount: 0,
                myPartstat: null,
                hasAlarms: false,
                busyOnly: !full,
                editable: false,
                conference: "",
                categories: []
            });
        }
    }
    occurrences.sort((left, right) => left.start.localeCompare(right.start));
    return { name: calendar.name, color: calendar.color, description: calendar.description, occurrences };
}
