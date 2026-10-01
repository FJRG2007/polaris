/**
 * iTIP (RFC 5546) messages: the invitation, the cancellation and the answer
 * that travel by email (iMIP, RFC 6047) or into another Polaris calendar.
 *
 * Alarms never travel: they are the sender's own reminders. The rest follows
 * RFC 5546 3.2: a REQUEST is the whole event; a CANCEL is the event marked
 * CANCELLED with SEQUENCE bumped, sent to the attendees it names; a REPLY
 * carries only what identifies the event plus the one attendee answering.
 */

import { serializeItem } from "./ical";
import { occurrenceFor } from "./expand";
import { instantToValue } from "./zones";
import { setAttendeeStatus } from "./edit";
import type { CalendarEvent, CalendarItem, PartStat } from "./types";

type EventItem = Extract<CalendarItem, { component: "VEVENT" }>;

/** Options for `buildItip`. */
export interface ItipOptions {
    /** CANCEL: only this attendee is told; REPLY: the attendee answering. */
    readonly attendeeEmail?: string;
    /** REPLY: the answer. */
    readonly partstat?: PartStat;
    /** One occurrence of a series instead of the whole of it. */
    readonly recurrenceKey?: string;
    /** DTSTAMP for the message; the one each component had otherwise. */
    readonly now?: Date;
    /** The reader's zone, for floating events' keys. */
    readonly floatingZone?: string;
    readonly prodId?: string;
}

function silent(event: CalendarEvent): CalendarEvent {
    return { ...event, alarms: [] };
}

function normal(email: string): string {
    return email
        .trim()
        .toLowerCase()
        .replace(/^mailto:/, "");
}

/** The one occurrence as an override-shaped VEVENT (RECURRENCE-ID set). */
function occurrenceEvent(
    item: EventItem,
    recurrenceKey: string,
    floatingZone: string
): CalendarEvent | null {
    const occurrence = occurrenceFor(item, recurrenceKey, floatingZone);
    const master = item.master;
    if (!occurrence) return null;
    if (occurrence.overridden || !master) return occurrence.event;
    const start = master.start;
    const recurrenceId =
        "date" in start
            ? { date: recurrenceKey.slice(0, 10) }
            : instantToValue(new Date(recurrenceKey), start, floatingZone, item.timezones);
    const moved =
        "date" in start && occurrence.startDate && occurrence.endDate
            ? { start: { date: occurrence.startDate }, end: { date: occurrence.endDate } }
            : {
                  start: instantToValue(occurrence.start, start, floatingZone, item.timezones),
                  end: instantToValue(occurrence.end, master.end, floatingZone, item.timezones)
              };
    return {
        ...master,
        ...moved,
        recurrenceId,
        thisAndFuture: false,
        rule: null,
        rdates: [],
        exdates: []
    };
}

/**
 * An iTIP message for an event, as a whole VCALENDAR with METHOD set.
 *
 * Throws for a task (VTODO invitations are not sent) and for a REPLY without
 * the attendee or the answer.
 */
export function buildItip(
    item: CalendarItem,
    method: "REQUEST" | "CANCEL" | "REPLY",
    options: ItipOptions = {}
): string {
    if (item.component !== "VEVENT") throw new Error("Only events are sent as invitations.");
    const floatingZone = options.floatingZone ?? "UTC";
    const serialize = (events: CalendarEvent[]) =>
        serializeItem(
            { ...item, master: null, overrides: events.map(silent), method },
            { method, now: options.now, prodId: options.prodId }
        );
    const components = (): CalendarEvent[] => {
        if (options.recurrenceKey) {
            const one = occurrenceEvent(item, options.recurrenceKey, floatingZone);
            return one ? [one] : [];
        }
        return [item.master, ...item.overrides].filter(
            (event): event is CalendarEvent => event !== null
        );
    };
    if (method === "REQUEST") return serialize(components());
    if (method === "CANCEL") {
        const only = options.attendeeEmail ? normal(options.attendeeEmail) : null;
        return serialize(
            components().map((event) => ({
                ...event,
                status: "CANCELLED",
                sequence: event.sequence + 1,
                attendees: only
                    ? event.attendees.filter((attendee) => attendee.email === only)
                    : event.attendees
            }))
        );
    }
    if (!options.attendeeEmail || !options.partstat)
        throw new Error("A reply needs the attendee and the answer.");
    const email = normal(options.attendeeEmail);
    const partstat = options.partstat;
    return serialize(
        components().map((event) => {
            const attendee = event.attendees.find((entry) => entry.email === email) ?? {
                email,
                name: "",
                role: "REQ-PARTICIPANT" as const,
                partstat,
                rsvp: false,
                type: "INDIVIDUAL" as const
            };
            // RFC 5546 3.2.3: what identifies the event, the organizer and the
            // one attendee. The times and title stay so a client can show it.
            return {
                ...event,
                description: "",
                location: "",
                categories: [],
                color: null,
                url: "",
                conference: "",
                attachments: [],
                attendees: [{ ...attendee, partstat, rsvp: false }],
                rule: event.recurrenceId ? null : event.rule,
                rdates: event.recurrenceId ? [] : event.rdates,
                exdates: event.recurrenceId ? [] : event.exdates,
                extra: event.extra.filter((entry) => /^DTSTAMP[;:]/i.test(entry.line)),
                extraComponents: []
            };
        })
    );
}

/**
 * An organizer's copy updated with an attendee's REPLY: their PARTSTAT on the
 * series (no key) or on one occurrence.
 */
export function applyReply(
    item: CalendarItem,
    email: string,
    partstat: PartStat,
    recurrenceKey: string | null,
    floatingZone = "UTC"
): CalendarItem {
    return setAttendeeStatus(item, email, partstat, recurrenceKey, floatingZone);
}
