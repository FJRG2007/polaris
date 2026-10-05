/**
 * The next few events of one person, for the Overview card: from the calendars
 * they show, in the next two weeks, the ones they declined left out when their
 * settings hide declined events.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { displayZone } from "../screens/time";
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

/**
 * What one person's calendar view is drawn from: the zone they read it in, the
 * calendars they reach and have not hidden, with their colours, and their
 * Calendar preferences. Shared by the Overview card and the assistant tools,
 * so both read the same calendar the person sees. Null for an account that is
 * not there.
 */
export async function readerView(userId: string) {
    const person = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, isAdmin: true }
    });
    if (!person) return null;
    const user: SessionUser = { ...person, sessionId: "" };
    const preferences = await loadPreferences(userId);
    const zone = displayZone(
        preferences.timezone,
        await host.calendarHost.displayTimeZone(userId).catch(() => null)
    );
    const [calendars, hidden] = await Promise.all([
        reachableCalendars(userId).then((reach) =>
            prisma.calendar.findMany({
                where: {
                    id: { in: [...reach.keys()] },
                    trashedAt: null,
                    kind: { not: "resource" }
                },
                select: { id: true, color: true }
            })
        ),
        prisma.calendarDisplay.findMany({
            where: { userId, hidden: true },
            select: { calendarId: true }
        })
    ]);
    const hide = new Set(hidden.map((row) => row.calendarId));
    const shown = calendars.filter((calendar) => !hide.has(calendar.id));
    return { user, preferences, zone, shown };
}

export async function upcomingEvents(
    userId: string,
    limit: number,
    now = new Date()
): Promise<Upcoming[]> {
    const reader = await readerView(userId);
    if (!reader) return [];
    const { user, preferences, zone, shown } = reader;
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
        .filter((occurrence) => !occurrence.busyOnly && occurrence.status !== "CANCELLED")
        .filter((occurrence) => preferences.showDeclined || occurrence.myPartstat !== "DECLINED")
        .filter((occurrence) => new Date(occurrence.end) > now)
        .slice(0, limit)
        .map((occurrence) => ({
            id: occurrence.objectId,
            title: occurrence.summary,
            start:
                occurrence.allDay && occurrence.startDate
                    ? `${occurrence.startDate}T00:00:00.000Z`
                    : occurrence.start,
            allDay: occurrence.allDay,
            color: occurrence.color ?? colors.get(occurrence.calendarId) ?? "#3b82f6",
            href: `/calendar/e/${occurrence.objectId}?k=${encodeURIComponent(occurrence.recurrenceKey)}`
        }));
}
