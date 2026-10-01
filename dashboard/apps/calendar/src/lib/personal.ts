/**
 * Everybody's first calendar, made the first time something needs one: they
 * open the Calendar, or somebody invites them before they ever did. An empty
 * list with nowhere to put an event is a dead end, and an invitation with
 * nowhere to land is a lost one.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { calendarTFor } from "./i18n";

/** The colour a first calendar gets: the first of the palette. */
const FIRST_COLOR = "#2563eb";

/** This person's first own calendar, made (named in their language) when they
 *  have none. Answers its id. */
export async function ensurePersonalCalendarFor(userId: string): Promise<string> {
    const found = await prisma.calendar.findFirst({
        where: { ownerId: userId, kind: "local", trashedAt: null, readOnly: false },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    if (found) return found.id;
    const t = await calendarTFor(userId);
    const created = await prisma.calendar.create({
        data: {
            ownerId: userId,
            name: t("calendars.personal"),
            color: FIRST_COLOR,
            components: "VEVENT,VTODO",
            defaultAlarms: JSON.stringify({ timed: [-10], allDay: [-900] })
        },
        select: { id: true }
    });
    return created.id;
}
