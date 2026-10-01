/**
 * An event as the editor opens it: the occurrence that was clicked, the series
 * it belongs to, and what this reader may do with it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as engine from "../engine";
import { CalendarRefusal } from "./errors";
import { calendarT } from "./i18n";
import { reaches, todoClassification, type SessionUser } from "./access";
import { itemOf, readableObject, versionOf } from "./objects";
import type { EventDetail, TodoDetail } from "./wire";

/** Only that the time is taken: what a free/busy reader, or a read-only reader
 *  of a private event, is shown. */
function busyOnly(event: engine.CalendarEvent): engine.CalendarEvent {
    return {
        ...event,
        uid: "",
        summary: "",
        description: "",
        location: "",
        url: "",
        conference: "",
        categories: [],
        attendees: [],
        alarms: [],
        attachments: [],
        organizer: null,
        extra: [],
        extraComponents: []
    };
}

export async function eventDetail(
    user: SessionUser,
    input: {
        objectId: string;
        recurrenceKey: string | null;
        floatingZone: string;
        emails: readonly string[];
    }
): Promise<EventDetail> {
    const { row, calendar } = await readableObject(user, input.objectId);
    const item = await itemOf(row);
    if (item.component !== "VEVENT")
        throw new CalendarRefusal((await calendarT())("errors.notAnEvent"));
    const series = item.master;
    let event: engine.CalendarEvent | null = series ?? item.overrides[0] ?? null;
    if (input.recurrenceKey) {
        const occurrence = engine.occurrenceFor(item, input.recurrenceKey, input.floatingZone);
        if (occurrence) {
            event = occurrence.overridden
                ? occurrence.event
                : {
                      ...occurrence.event,
                      start: engine.instantToValue(
                          occurrence.start,
                          occurrence.event.start,
                          input.floatingZone,
                          item.timezones
                      ),
                      end: engine.instantToValue(
                          occurrence.end,
                          occurrence.event.end,
                          input.floatingZone,
                          item.timezones
                      )
                  };
        }
    }
    if (!event) throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));

    const writable = reaches(calendar.reach, "write") && !calendar.readOnly;
    const flags = await prisma.calendarObject.findUnique({
        where: { id: row.id },
        select: { conflictIcs: true, pendingPush: true }
    });
    const full =
        reaches(calendar.reach, "write") ||
        (calendar.reach !== "freebusy" && event.classification === "PUBLIC");
    const emails = input.emails.map((email) => email.toLowerCase());
    const invitations = full
        ? await prisma.calendarInvitation.findMany({
              where: { objectId: row.id },
              select: {
                  email: true,
                  partstat: true,
                  sentAt: true,
                  respondedAt: true,
                  userId: true
              },
              orderBy: { createdAt: "asc" }
          })
        : [];
    return {
        objectId: row.id,
        calendarId: row.calendarId,
        recurrenceKey: input.recurrenceKey,
        version: versionOf(row),
        event: full ? event : busyOnly(event),
        series: full ? series : null,
        writable: writable && full,
        answerable: !calendar.readOnly,
        isOrganizer: !event.organizer || emails.includes(event.organizer.email),
        myEmails: emails,
        invitations: invitations.map((invitation) => ({
            email: invitation.email,
            partstat: invitation.partstat as engine.PartStat,
            sentAt: invitation.sentAt?.toISOString() ?? null,
            respondedAt: invitation.respondedAt?.toISOString() ?? null,
            internal: invitation.userId !== null
        })),
        conflict: flags?.conflictIcs != null,
        pending: (flags?.pendingPush ?? "") !== "",
        busyOnly: !full
    };
}

export async function todoDetail(user: SessionUser, objectId: string): Promise<TodoDetail> {
    const { row, calendar } = await readableObject(user, objectId);
    if (calendar.reach === "freebusy")
        throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    const item = await itemOf(row);
    if (item.component !== "VTODO")
        throw new CalendarRefusal((await calendarT())("errors.notATask"));
    if (!reaches(calendar.reach, "write") && todoClassification(item.todo) !== "PUBLIC") {
        throw new CalendarRefusal((await calendarT())("errors.eventNotFound"));
    }
    return {
        objectId: row.id,
        calendarId: row.calendarId,
        version: versionOf(row),
        todo: item.todo,
        writable: reaches(calendar.reach, "write") && !calendar.readOnly
    };
}
