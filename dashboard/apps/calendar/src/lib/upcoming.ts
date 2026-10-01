/**
 * The next few events of one person, for the Overview card: from the calendars
 * they show, in the next two weeks, the ones they declined left out when their
 * settings hide declined events.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadPreferences } from "./preferences-store";
import { addressesOf, occurrencesIn } from "./occurrences";
import { reachableCalendars, type SessionUser } from "./access";

const WINDOW_MS = 14 * 86_400_000;

export interface Upcoming {
    readonly id: string;
    readonly title: string;
    readonly start: string;
    readonly allDay: boolean;
    readonly color: string;
    readonly href: string;
}

export async function upcomingEvents(userId: string, limit: number, now = new Date()): Promise<Upcoming[]> {
    const person = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, isAdmin: true }
    });
    if (!person) return [];
    const user: SessionUser = { ...person, sessionId: "" };
    const preferences = await loadPreferences(userId);
    const zone = preferences.timezone === "auto" ? "UTC" : preferences.timezone;
    const [calendars, hidden] = await Promise.all([
        reachableCalendars(userId).then((reach) =>
            prisma.calendar.findMany({
                where: { id: { in: [...reach.keys()] }, trashedAt: null, kind: { not: "resource" } },
                select: { id: true, color: true }
            })
        ),
        prisma.calendarDisplay.findMany({ where: { userId, hidden: true }, select: { calendarId: true } })
    ]);
    const hide = new Set(hidden.map((row) => row.calendarId));
    const shown = calendars.filter((calendar) => !hide.has(calendar.id));
    const colors = new Map(shown.map((calendar) => [calendar.id, calendar.color]));
    const view = await occurrencesIn(
        user,
        { from: now, to: new Date(now.getTime() + WINDOW_MS) },
        {
            floatingZone: zone,
            calendarIds: shown.map((calendar) => calendar.id),
            emails: await addressesOf(user),
            includeTasks: false
        }
    );
    return view.occurrences
        .filter((occurrence) => occurrence.status !== "CANCELLED")
        .filter((occurrence) => preferences.showDeclined || occurrence.myPartstat !== "DECLINED")
        .filter((occurrence) => new Date(occurrence.end) > now)
        .slice(0, limit)
        .map((occurrence) => ({
            id: occurrence.objectId,
            title: occurrence.summary,
            start: occurrence.allDay && occurrence.startDate ? `${occurrence.startDate}T00:00:00.000Z` : occurrence.start,
            allDay: occurrence.allDay,
            color: occurrence.color ?? colors.get(occurrence.calendarId) ?? "#3b82f6",
            href: `/calendar/e/${occurrence.objectId}?k=${encodeURIComponent(occurrence.recurrenceKey)}`
        }));
}
