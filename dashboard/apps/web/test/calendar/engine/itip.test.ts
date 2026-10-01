/**
 * U15: iTIP messages (RFC 5546) - REQUEST, CANCEL and REPLY shapes, and an
 * organizer applying a reply.
 */

import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const text = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:meeting@example.com",
    "DTSTAMP:20260101T000000Z",
    "SEQUENCE:2",
    "SUMMARY:Budget",
    "DESCRIPTION:Private notes",
    "LOCATION:Room 1",
    "DTSTART;TZID=Europe/Madrid:20260601T100000",
    "DTEND;TZID=Europe/Madrid:20260601T110000",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "ORGANIZER;CN=Olga:mailto:olga@example.com",
    "ATTENDEE;CN=Ana;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ana@example.com",
    "ATTENDEE;CN=Ben;PARTSTAT=ACCEPTED:mailto:ben@example.com",
    "X-SECRET-NOTE:organizer only",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT10M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
].join("\r\n");

const item = engine.parseCalendarText(text).items[0] as engine.CalendarItem;
const now = new Date("2026-05-20T12:00:00Z");
const events = (message: string) => {
    const parsed = engine.parseCalendarText(message);
    expect(parsed.errors).toEqual([]);
    const [found] = parsed.items;
    if (!found || found.component !== "VEVENT") throw new Error("no event");
    return {
        item: found,
        all: [found.master, ...found.overrides].filter(
            (event): event is engine.CalendarEvent => event !== null
        )
    };
};
const JUNE_8 = "2026-06-08T08:00:00.000Z";

describe("buildItip", () => {
    it("REQUEST carries the whole event, without the organizer's alarms", () => {
        const message = engine.buildItip(item, "REQUEST", { now });
        expect(message).toContain("METHOD:REQUEST\r\n");
        expect(message).toContain("DTSTAMP:20260520T120000Z");
        expect(message).not.toContain("BEGIN:VALARM");
        const { all } = events(message);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            summary: "Budget",
            sequence: 2,
            rule: { raw: "FREQ=WEEKLY;COUNT=4" }
        });
        expect(all[0]?.attendees.map((attendee) => attendee.email)).toEqual([
            "ana@example.com",
            "ben@example.com"
        ]);
    });

    it("CANCEL marks the event cancelled, bumps SEQUENCE and can address one attendee", () => {
        const whole = events(engine.buildItip(item, "CANCEL", { now })).all[0];
        expect(whole).toMatchObject({ status: "CANCELLED", sequence: 3 });
        expect(whole?.attendees).toHaveLength(2);
        const removed = engine.buildItip(item, "CANCEL", { now, attendeeEmail: "Ben@Example.com" });
        expect(removed).toContain("METHOD:CANCEL\r\n");
        expect(events(removed).all[0]?.attendees.map((attendee) => attendee.email)).toEqual([
            "ben@example.com"
        ]);
    });

    it("CANCEL of one occurrence names it with RECURRENCE-ID", () => {
        const { all } = events(engine.buildItip(item, "CANCEL", { now, recurrenceKey: JUNE_8 }));
        expect(all[0]?.recurrenceId).toEqual({
            dateTime: "2026-06-08T10:00:00",
            tzid: "Europe/Madrid"
        });
        expect(all[0]?.start).toEqual({ dateTime: "2026-06-08T10:00:00", tzid: "Europe/Madrid" });
        expect(all[0]?.rule).toBeNull();
        expect(all[0]?.status).toBe("CANCELLED");
    });

    it("REPLY carries the organizer and only the attendee answering", () => {
        const message = engine.buildItip(item, "REPLY", {
            now,
            attendeeEmail: "ana@example.com",
            partstat: "ACCEPTED"
        });
        expect(message).toContain("METHOD:REPLY\r\n");
        expect(message).not.toContain("Private notes");
        expect(message).not.toContain("X-SECRET-NOTE");
        expect(message).not.toContain("ben@example.com");
        const [reply] = events(message).all;
        expect(reply?.organizer?.email).toBe("olga@example.com");
        expect(reply?.attendees).toEqual([
            {
                email: "ana@example.com",
                name: "Ana",
                role: "REQ-PARTICIPANT",
                partstat: "ACCEPTED",
                rsvp: false,
                type: "INDIVIDUAL"
            }
        ]);
        expect(reply?.uid).toBe("meeting@example.com");
        expect(reply?.sequence).toBe(2);
    });

    it("REPLY to one occurrence answers only it", () => {
        const [reply] = events(
            engine.buildItip(item, "REPLY", {
                now,
                attendeeEmail: "ana@example.com",
                partstat: "DECLINED",
                recurrenceKey: JUNE_8
            })
        ).all;
        expect(reply?.recurrenceId).toEqual({
            dateTime: "2026-06-08T10:00:00",
            tzid: "Europe/Madrid"
        });
        expect(reply?.attendees[0]?.partstat).toBe("DECLINED");
    });

    it("refuses a REPLY without the answer and a task", () => {
        expect(() =>
            engine.buildItip(item, "REPLY", { attendeeEmail: "ana@example.com" })
        ).toThrow();
        expect(() => engine.buildItip(engine.todoItem(engine.newTodo()), "REQUEST")).toThrow();
    });
});

describe("applyReply", () => {
    it("records the answer on the series or on one occurrence", () => {
        const series = engine.applyReply(item, "ANA@example.com", "ACCEPTED", null);
        expect(series.component === "VEVENT" && series.master?.attendees[0]?.partstat).toBe(
            "ACCEPTED"
        );
        const one = engine.applyReply(item, "ana@example.com", "TENTATIVE", JUNE_8);
        expect(one.component === "VEVENT" && one.overrides).toHaveLength(1);
        expect(one.component === "VEVENT" && one.overrides[0]?.attendees[0]?.partstat).toBe(
            "TENTATIVE"
        );
        expect(one.component === "VEVENT" && one.master?.attendees[0]?.partstat).toBe(
            "NEEDS-ACTION"
        );
    });
});
