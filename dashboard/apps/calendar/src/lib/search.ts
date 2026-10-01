/**
 * Searching every calendar a person reads, across all time: titles, places,
 * descriptions and who is invited. The screen filters what it already has on
 * its own; this is for what it does not.
 *
 * Matches on the stored text, so a word in a description or an attendee's
 * address finds the event without a second index to keep in step. Calendars
 * seen as free/busy only are not searched - a search that found a word inside
 * an event its reader may not open would be reading it for them.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import type { SearchHit } from "./wire";
import { publicItem, reachableCalendars, reaches, type SessionUser } from "./access";

const LIMIT = 50;
const YEAR = 365 * 86_400_000;

export async function searchEvents(
    user: SessionUser,
    query: string,
    options: { floatingZone: string; now: Date }
): Promise<SearchHit[]> {
    const term = query.trim();
    if (term.length < 2) return [];
    const reach = await reachableCalendars(user.id);
    const readable = [...reach.entries()].filter(([, level]) => reaches(level, "read")).map(([id]) => id);
    if (readable.length === 0) return [];
    const rows = await prisma.calendarObject.findMany({
        where: {
            calendarId: { in: readable },
            deletedAt: null,
            calendar: { trashedAt: null },
            OR: [
                { summary: { contains: term, mode: "insensitive" } },
                { location: { contains: term, mode: "insensitive" } },
                { ics: { contains: term, mode: "insensitive" } }
            ]
        },
        select: {
            id: true,
            calendarId: true,
            ics: true,
            summary: true,
            location: true,
            startsAt: true,
            allDay: true,
            recurring: true,
            calendar: { select: { color: true } }
        },
        orderBy: { startsAt: "desc" },
        take: LIMIT * 2
    });
    const hits: SearchHit[] = [];
    for (const row of rows) {
        const item = tryItemOf(row.ics);
        const event = item?.component === "VEVENT" ? (item.master ?? item.overrides[0]) : null;
        // What a read-only sharee may not see (a private event or task) is not a hit.
        if (!reaches(reach.get(row.calendarId) ?? null, "write") && !(item && publicItem(item))) continue;
        let start = row.startsAt;
        if (item && row.recurring) {
            const next = engine.expandItem(
                item,
                { from: options.now, to: new Date(options.now.getTime() + 2 * YEAR) },
                { floatingZone: options.floatingZone, limit: 1 }
            )[0];
            if (next) start = next.start;
        }
        hits.push({
            objectId: row.id,
            calendarId: row.calendarId,
            summary: row.summary,
            location: row.location,
            start: start?.toISOString() ?? null,
            allDay: row.allDay,
            recurring: row.recurring,
            color: event?.color ?? row.calendar.color
        });
        if (hits.length >= LIMIT) break;
    }
    return hits;
}
