/**
 * The busy events that can put somebody "In a meeting", for automatic status.
 *
 * The same rule as free/busy: calendars the person owns (their own and the ones
 * synced from their accounts), not the ones marked "never show me as busy",
 * and not an event marked free, a cancelled one or one they declined. Only the
 * events reaching a short window around now are read, through the indexed
 * start and end columns, so this costs a page of rows for somebody whose day
 * is full and nothing for everybody else.
 *
 * Titles go back to the dashboard, which says them only to the account itself.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import { reachingWindow, verifiedAddresses } from "./occurrences";

/** Objects read per person and window; a ceiling, not a page. */
const MOST_OBJECTS = 500;

/** Occurrences of one series taken into account per window. */
const MAX_PER_SERIES = 50;

export interface PresenceBusyAsk {
    readonly userId: string;
    /** The calendars that count, or null for every one the person owns. */
    readonly calendarIds: readonly string[] | null;
    /** The zone a floating time is read in. */
    readonly zone: string;
}

export interface PresenceBusyEvent {
    readonly start: Date;
    readonly end: Date;
    readonly allDay: boolean;
    readonly title: string;
}

/** The calendars a person may pick from for automatic status. */
export async function presenceCalendars(
    userId: string
): Promise<{ id: string; name: string; color: string }[]> {
    return prisma.calendar.findMany({
        where: {
            ownerId: userId,
            trashedAt: null,
            transparent: false,
            kind: { in: ["local", "remote"] }
        },
        select: { id: true, name: true, color: true },
        orderBy: { createdAt: "asc" },
        take: 200
    });
}

/** The busy events reaching this window, by person. */
export async function presenceBusy(
    asks: readonly PresenceBusyAsk[],
    window: { from: Date; to: Date }
): Promise<Map<string, PresenceBusyEvent[]>> {
    const found = new Map<string, PresenceBusyEvent[]>();
    if (asks.length === 0) return found;
    const people = await prisma.user.findMany({
        where: { id: { in: asks.map((ask) => ask.userId) } },
        select: { id: true, email: true }
    });
    const emailOf = new Map(people.map((person) => [person.id, person.email]));
    await Promise.all(
        asks.map(async (ask) => {
            const email = emailOf.get(ask.userId);
            if (email === undefined) return;
            found.set(ask.userId, await personEvents(ask, email, window));
        })
    );
    return found;
}

async function personEvents(
    ask: PresenceBusyAsk,
    email: string,
    window: { from: Date; to: Date }
): Promise<PresenceBusyEvent[]> {
    const [calendars, emails] = await Promise.all([
        prisma.calendar.findMany({
            where: {
                ownerId: ask.userId,
                trashedAt: null,
                transparent: false,
                kind: { in: ["local", "remote"] },
                ...(ask.calendarIds ? { id: { in: [...ask.calendarIds] } } : {})
            },
            select: { id: true }
        }),
        verifiedAddresses(ask.userId, email)
    ]);
    if (calendars.length === 0) return [];
    const rows = await prisma.calendarObject.findMany({
        where: {
            calendarId: { in: calendars.map((calendar) => calendar.id) },
            deletedAt: null,
            component: "VEVENT",
            ...reachingWindow(window)
        },
        select: { ics: true },
        take: MOST_OBJECTS
    });
    const self = new Set(emails);
    const events: PresenceBusyEvent[] = [];
    for (const row of rows) {
        const item = tryItemOf(row.ics);
        if (!item) continue;
        let occurrences: engine.Occurrence[];
        try {
            occurrences = engine.expandItem(item, window, {
                floatingZone: ask.zone,
                limit: MAX_PER_SERIES
            });
        } catch {
            // A rule that does not expand says nothing about being busy.
            continue;
        }
        for (const occurrence of occurrences) {
            const event = occurrence.event;
            if (event.transparency === "TRANSPARENT" || event.status === "CANCELLED") continue;
            const declined = event.attendees.some(
                (attendee) => self.has(attendee.email) && attendee.partstat === "DECLINED"
            );
            if (declined) continue;
            events.push({
                start: occurrence.start,
                end: occurrence.end,
                allDay: occurrence.allDay,
                title: event.summary
            });
        }
    }
    return events;
}
