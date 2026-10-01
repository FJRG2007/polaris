/**
 * Answering an invitation from its link: what somebody outside Polaris uses,
 * since Polaris receives no mail and a reply from their mail program would
 * never arrive. The link is the whole of the right to answer; it answers for
 * the one address it was sent to and nothing else.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { tryItemOf } from "./objects";
import { CalendarRefusal } from "./errors";
import type { RsvpView } from "./scheduling-wire";
import { callerAddress, throttle } from "./scheduling-guard";
import { applyAnswer, invitationByToken } from "./invitations";

/** Upcoming occurrences of a series offered to answer one by one. */
const OCCURRENCES_OFFERED = 12;

function eventsOf(item: engine.CalendarItem): engine.CalendarEvent[] {
    if (item.component !== "VEVENT") return [];
    return [item.master, ...item.overrides].filter((event): event is engine.CalendarEvent => Boolean(event));
}

/** The zone an event's times are written in. */
function zoneOf(event: engine.CalendarEvent): string {
    return "tzid" in event.start && event.start.tzid ? (engine.resolveZone(event.start.tzid) ?? "UTC") : "UTC";
}

/** Whether a key names an occurrence the series really has - not merely a
 *  time the engine could place (it places any key it is given). */
function isOccurrence(item: engine.CalendarItem, key: string, zone: string): boolean {
    const placed = engine.occurrenceFor(item, key, zone);
    if (!placed) return false;
    const around = { from: new Date(placed.start.getTime() - 86_400_000), to: new Date(placed.end.getTime() + 86_400_000) };
    return engine.expandItem(item, around, { floatingZone: zone, limit: 100 }).some((occurrence) => occurrence.recurrenceKey === key);
}

/** The invitation a link opens, as its page draws it; null when the link is
 *  unknown or the event is gone. */
export async function rsvpView(token: string, now = new Date()): Promise<RsvpView | null> {
    const invitation = await invitationByToken(token);
    if (!invitation || invitation.object.deletedAt) return null;
    const item = tryItemOf(invitation.object.ics);
    if (!item || item.component !== "VEVENT") return null;
    const event = item.master ?? item.overrides[0];
    if (!event) return null;
    const zone = zoneOf(event);
    const first = engine.occurrenceFor(item, engine.valueToInstant(event.start, zone, item.timezones).toISOString(), zone);
    const upcoming = engine.isRecurring(event)
        ? engine.expandItem(item, { from: now, to: new Date(now.getTime() + 2 * 366 * 86_400_000) }, { floatingZone: zone, limit: OCCURRENCES_OFFERED })
        : [];
    const shown = upcoming[0] ?? first;
    const own = eventsOf(item)
        .flatMap((entry) => entry.attendees)
        .find((attendee) => attendee.email === invitation.email);
    return {
        title: event.summary,
        description: event.description,
        location: event.location,
        conference: event.conference,
        organizer: event.organizer?.name || event.organizer?.email || "",
        start: (shown?.start ?? engine.valueToInstant(event.start, zone, item.timezones)).toISOString(),
        end: (shown?.end ?? engine.valueToInstant(event.end, zone, item.timezones)).toISOString(),
        allDay: shown?.allDay ?? "date" in event.start,
        startDate: shown?.startDate ?? null,
        endDate: shown?.endDate ?? null,
        timezone: zone,
        recurring: engine.isRecurring(event),
        cancelled: event.status === "CANCELLED",
        email: invitation.email,
        partstat: own?.partstat ?? (invitation.partstat as engine.PartStat),
        occurrences: upcoming.map((occurrence) => ({
            key: occurrence.recurrenceKey,
            start: occurrence.start.toISOString(),
            allDay: occurrence.allDay
        }))
    };
}

/** Record an answer given through the link, on the organizer's copy. */
export async function answerByToken(
    input: { token: string; partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED"; recurrenceKey: string | null }
): Promise<void> {
    const t = await calendarT();
    await throttle(`calendar.rsvp:${await callerAddress()}`, 30, 600_000);
    await throttle(`calendar.rsvp-token:${input.token}`, 10, 3_600_000);
    const invitation = await invitationByToken(input.token);
    if (!invitation || invitation.object.deletedAt) throw new CalendarRefusal(t("rsvp.linkGone"));
    const item = tryItemOf(invitation.object.ics);
    if (!item) throw new CalendarRefusal(t("rsvp.linkGone"));
    const series = eventsOf(item)[0];
    if (!series) throw new CalendarRefusal(t("rsvp.linkGone"));
    if (series.status === "CANCELLED") throw new CalendarRefusal(t("rsvp.cancelled"));
    if (input.recurrenceKey && !isOccurrence(item, input.recurrenceKey, zoneOf(series))) {
        throw new CalendarRefusal(t("rsvp.noSuchOccurrence"));
    }
    await applyAnswer(invitation.object.calendar.ownerId, invitation.object.uid, invitation.email, input.partstat, input.recurrenceKey);
    // Kept in step even when the organizer's copy could not be read, so the
    // page shows the answer that was given.
    await prisma.calendarInvitation.update({
        where: { id: invitation.id },
        data: { partstat: input.partstat, respondedAt: new Date() }
    });
}

/** The address the page answers for, masked for showing: enough to recognize,
 *  not enough to harvest. */
export function maskedAddress(email: string): string {
    const [local = "", domain = ""] = email.split("@");
    if (local.length <= 2) return `${local[0] ?? ""}*@${domain}`;
    return `${local.slice(0, 2)}${"*".repeat(Math.min(6, local.length - 2))}@${domain}`;
}
