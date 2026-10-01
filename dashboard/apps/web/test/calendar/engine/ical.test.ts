/**
 * U08: iCalendar parse and serialize. Round trips on real exports (ical.js's
 * captured Google Calendar and Zimbra files) and on reconstructions of iCloud,
 * Nextcloud and Outlook output - see fixtures/README.md for which is which.
 */

import ICAL from "ical.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as engine from "@polaris-app/calendar/src/engine";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const FIXTURES = [
    "icaljs-google-birthday.ics",
    "icaljs-daily-recur.ics",
    "icaljs-recur-instances.ics",
    "icaljs-timezone-from-file.ics",
    "icloud-reconstructed.ics",
    "nextcloud-reconstructed.ics",
    "outlook-reconstructed.ics"
];

/** A stored object never carries METHOD, so a message's is passed back in. */
function roundTrip(item: engine.CalendarItem): engine.CalendarItem {
    const parsed = engine.parseCalendarText(engine.serializeItem(item, { method: item.method ?? undefined }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    return parsed.items[0] as engine.CalendarItem;
}

describe("round trip parse -> serialize -> parse", () => {
    for (const name of FIXTURES) {
        it(`keeps every item of ${name} equal`, () => {
            const parsed = engine.parseCalendarText(fixture(name));
            expect(parsed.errors).toEqual([]);
            expect(parsed.items.length).toBeGreaterThan(0);
            for (const item of parsed.items) {
                const again = roundTrip(item);
                // The first write may add a VTIMEZONE for a zone the file
                // named another way (Outlook's "Romance Standard Time" is
                // written back as Europe/Paris, which the file never defined);
                // everything the file had comes back as it was.
                expect({ ...again, timezones: again.timezones.slice(0, item.timezones.length) }).toEqual(item);
                // And from then on a trip writes the same text.
                expect(engine.serializeItem(roundTrip(again))).toBe(engine.serializeItem(again));
            }
        });
    }

    it("writes unknown X- properties, ATTACH, VALARM and VTIMEZONE back out", () => {
        const [event] = engine.parseCalendarText(fixture("icloud-reconstructed.ics")).items;
        if (!event) throw new Error("no event");
        const text = engine.serializeItem(event).replace(/\r\n /g, "");
        expect(text).toContain("X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC");
        expect(text).toContain('X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Calle Mayor 1, 28013 Madrid";X-APPLE-RADIUS=70.58;X-TITLE="Calle Mayor 1":geo:40.416775,-3.703790');
        expect(text).toContain("ATTACH;FMTTYPE=application/pdf;FILENAME=agenda.pdf;MANAGED-ID=00000000-0000-0000-0000-000000000001;SIZE=23456:https://p00-caldav.icloud.example/attachments/agenda.pdf");
        expect(text).toContain("X-WR-ALARMUID:0B9E3E7E-7D55-4B8B-8C43-000000000001");
        expect(text).toContain("ACTION:NONE");
        expect(text).toContain("X-APPLE-DEFAULT-ALARM:TRUE");
        expect(text).toContain("BEGIN:VTIMEZONE\r\nTZID:Europe/Madrid");
        expect(text).toContain("RECURRENCE-ID;TZID=Europe/Madrid:20260317T090000");
    });

    it("keeps attendee parameters the model has no field for", () => {
        const item = engine.parseCalendarText(fixture("nextcloud-reconstructed.ics")).items.find((entry) => entry.component === "VEVENT");
        if (!item || item.component !== "VEVENT" || !item.master) throw new Error("no event");
        const jo = item.master.attendees.find((attendee) => attendee.email === "jo@example.com");
        expect(jo?.params).toEqual({ "delegated-from": "mailto:bob@example.com" });
        const sam = item.master.attendees.find((attendee) => attendee.email === "sam@example.com");
        expect(sam).toMatchObject({ name: "Sam Example", rsvp: true, role: "REQ-PARTICIPANT", partstat: "NEEDS-ACTION", params: { language: "de" } });
        expect(item.master.attendees.find((attendee) => attendee.email === "room4@example.com")?.type).toBe("ROOM");
        const text = engine.serializeItem(item).replace(/\r\n /g, "");
        expect(text).toContain('DELEGATED-FROM="mailto:bob@example.com"');
    });
});

describe("parseCalendarText", () => {
    it("reads the calendar's name, colour and zone", () => {
        const google = engine.parseCalendarText(fixture("icaljs-daily-recur.ics"));
        expect(google.name).toBe("calmozilla1@gmail.com");
        expect(google.timezone).toBe("America/Los_Angeles");
        const apple = engine.parseCalendarText(fixture("icloud-reconstructed.ics"));
        expect(apple.name).toBe("Home");
        expect(apple.color).toBe("#34AADC");
    });

    it("groups a master and its overrides by UID", () => {
        const parsed = engine.parseCalendarText(fixture("icaljs-google-birthday.ics"));
        const birthday = parsed.items.find((item) => item.uid === "BIRTHDAY_79d389868f96182e@google.com");
        expect(birthday?.component).toBe("VEVENT");
        if (birthday?.component !== "VEVENT") return;
        expect(birthday.master).toBeNull();
        expect(birthday.overrides).toHaveLength(3);
        expect(birthday.overrides[0]?.extra.map((entry) => entry.line)).toContain("X-GOOGLE-CALENDAR-CONTENT-DISPLAY:chip");
    });

    it("maps the model's fields", () => {
        const item = engine.parseCalendarText(fixture("nextcloud-reconstructed.ics")).items.find((entry) => entry.component === "VEVENT");
        if (!item || item.component !== "VEVENT" || !item.master) throw new Error("no event");
        const master = item.master;
        expect(master.start).toEqual({ dateTime: "2026-01-12T14:00:00", tzid: "Europe/Berlin" });
        expect(master.description).toBe("Agenda:\n- numbers\n- plans, dates; owners");
        expect(master.categories).toEqual(["Work", "Meetings"]);
        expect(master.color).toBe("crimson");
        expect(master.classification).toBe("PRIVATE");
        expect(master.sequence).toBe(3);
        expect(master.rule?.raw).toBe("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2;COUNT=12");
        expect(master.organizer).toEqual({ email: "alex@example.com", name: "Alex Example" });
        expect(master.alarms).toEqual([
            { action: "DISPLAY", trigger: { kind: "relative", minutes: -10, related: "START" }, description: "This is an event reminder", extra: [] },
            {
                action: "EMAIL",
                trigger: { kind: "relative", minutes: -5, related: "END" },
                description: "Ends soon",
                extra: [{ line: "SUMMARY:Team review" }, { line: "ATTENDEE:mailto:alex@example.com" }]
            }
        ]);
        expect(master.extra.map((entry) => entry.line)).toEqual(["DTSTAMP:20260105T091500Z", "X-NC-GROUP-ID:0"]);
        expect(master.created).toBe("2026-01-05T09:00:00Z");
        expect(item.overrides[0]?.status).toBe("CANCELLED");
        expect(item.timezones).toHaveLength(1);
        const todo = engine.parseCalendarText(fixture("nextcloud-reconstructed.ics")).items.find((entry) => entry.component === "VTODO");
        expect(todo?.component === "VTODO" && todo.todo).toMatchObject({ summary: "Send the minutes", due: { date: "2026-01-13" }, status: "IN-PROCESS", percent: 40, priority: 1 });
    });

    it("resolves a Windows TZID and keeps its VTIMEZONE", () => {
        const [item] = engine.parseCalendarText(fixture("outlook-reconstructed.ics")).items;
        if (!item || item.component !== "VEVENT" || !item.master) throw new Error("no event");
        expect(item.master.start).toEqual({ dateTime: "2026-04-02T10:00:00", tzid: "Europe/Paris" });
        expect(item.timezones[0]).toContain("TZID:Romance Standard Time");
        expect(engine.valueToInstant(item.master.start, "UTC", item.timezones).toISOString()).toBe("2026-04-02T08:00:00.000Z");
        expect(item.method).toBe("PUBLISH");
    });

    it("reads a zone only the file defines through its VTIMEZONE", () => {
        const [item] = engine.parseCalendarText(fixture("icaljs-timezone-from-file.ics")).items;
        if (!item || item.component !== "VEVENT" || !item.master) throw new Error("no event");
        expect(item.master.start).toEqual({ dateTime: "2023-03-06T13:42:00", tzid: "Nowhere/Middle" });
        const [occurrence] = engine.expandItem(item, { from: new Date("2023-03-06T00:00:00Z"), to: new Date("2023-03-08T00:00:00Z") }, { floatingZone: "UTC" });
        // -07:41 from the file's own STANDARD block.
        expect(occurrence?.start.toISOString()).toBe("2023-03-06T21:23:00.000Z");
    });

    it("skips a broken event, reports it and keeps the rest", () => {
        const text = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VEVENT",
            "UID:good",
            "DTSTART:20260101T100000Z",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:no-start",
            "SUMMARY:Where is my start?",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:bad-date",
            "DTSTART:tomorrow",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:unclosed",
            "DTSTART:20260101T100000Z",
            "END:VCALENDAR"
        ].join("\r\n");
        const parsed = engine.parseCalendarText(text);
        expect(parsed.items.map((item) => item.uid)).toEqual(["good"]);
        expect(parsed.errors).toEqual(["parse.eventUnreadable", "parse.eventUnreadable", "parse.eventUnreadable"]);
        expect(parsed.problems.every((problem) => problem.detail.length > 0)).toBe(true);
        expect(engine.parseCalendarText("not a calendar").errors).toEqual(["parse.noCalendar"]);
        expect(engine.parseCalendarText("[not json").errors).toEqual(["parse.notJson"]);
    });

    it("reads jCal the same as the text it came from", () => {
        const text = fixture("nextcloud-reconstructed.ics");
        const fromText = engine.parseCalendarText(text);
        const fromJcal = engine.parseCalendarText(JSON.stringify(ICAL.parse(text)));
        expect(fromJcal.errors).toEqual([]);
        expect(fromJcal.items.map((item) => item.uid)).toEqual(fromText.items.map((item) => item.uid));
        const a = fromText.items.find((item) => item.component === "VEVENT");
        const b = fromJcal.items.find((item) => item.component === "VEVENT");
        expect(a).toBeDefined();
        expect(b?.component === "VEVENT" && b.master?.start).toEqual(a?.component === "VEVENT" && a.master?.start);
        expect(b?.component === "VEVENT" && b.master?.attendees).toEqual(a?.component === "VEVENT" && a.master?.attendees);
        expect(b?.component === "VEVENT" && b.master?.rule?.raw).toBe("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2;COUNT=12");
    });

    it("reads a meeting link from CONFERENCE or Google's own property, writing it once", () => {
        const google = engine.parseCalendarText(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:g", "DTSTAMP:20260101T000000Z", "DTSTART:20260101T100000Z", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij", "END:VEVENT", "END:VCALENDAR"].join("\r\n")).items[0];
        if (!google || google.component !== "VEVENT" || !google.master) throw new Error("no event");
        expect(google.master.conference).toBe("https://meet.google.com/abc-defg-hij");
        expect(engine.serializeItem(google)).not.toContain("CONFERENCE;VALUE=URI");
        expect(roundTrip(google)).toEqual(google);
        const own = engine.eventItem({ ...google.master, extra: [], conference: "https://meet.example.com/room" });
        expect(engine.serializeItem(own)).toContain("CONFERENCE;VALUE=URI:https://meet.example.com/room");
        expect(roundTrip(own).component === "VEVENT" && roundTrip(own)).toMatchObject({ master: { conference: "https://meet.example.com/room" } });
    });

    it("reads DURATION into an end, and applies RFC 5545's defaults", () => {
        const parsed = engine.parseCalendarText(
            [
                "BEGIN:VCALENDAR",
                "BEGIN:VEVENT",
                "UID:a",
                "DTSTART;TZID=Europe/Madrid:20260101T233000",
                "DURATION:PT1H",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:b",
                "DTSTART;VALUE=DATE:20260101",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:c",
                "DTSTART:20260101T100000Z",
                "END:VEVENT",
                "END:VCALENDAR"
            ].join("\r\n")
        );
        const ends = parsed.items.map((item) => item.component === "VEVENT" && item.master?.end);
        expect(ends).toEqual([{ dateTime: "2026-01-02T00:30:00", tzid: "Europe/Madrid" }, { date: "2026-01-02" }, { dateTime: "2026-01-01T10:00:00", tzid: "UTC" }]);
    });
});

describe("serializeItem", () => {
    const long = engine.newEvent({
        uid: "fold-test",
        summary: "Ñandú ".repeat(40),
        description: "Line one\nLine two, with a comma; and a semicolon",
        start: { dateTime: "2026-05-01T10:00:00", tzid: "Europe/Madrid" },
        end: { dateTime: "2026-05-01T11:00:00", tzid: "Europe/Madrid" }
    });

    it("writes the calendar envelope, CRLF and 75-octet folds", () => {
        const text = engine.serializeItem(engine.eventItem(long), { method: "REQUEST", now: new Date("2026-04-01T12:00:00Z") });
        expect(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Polaris//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:REQUEST\r\n")).toBe(true);
        expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
        expect(text).not.toMatch(/[^\r]\n/);
        const encoder = new TextEncoder();
        for (const line of text.split("\r\n")) expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
        expect(text).toContain("DTSTAMP:20260401T120000Z");
        expect(text).toContain("DESCRIPTION:Line one\\nLine two\\, with a comma\\; and a semicolon");
        const back = engine.parseCalendarText(text).items[0];
        expect(back?.component === "VEVENT" && back.master?.summary).toBe(long.summary);
    });

    it("writes no line a value did not ask for, whatever control characters the values carry", () => {
        const injected = "ATTENDEE:mailto:intruder@example.com";
        const event = engine.newEvent({
            uid: "controls",
            summary: `Lone return\r${injected}`,
            location: `Bell\u0007${injected}`,
            conference: `https://meet.example.com/room\r\n${injected}`,
            url: `https://example.com/page\n${injected}`,
            attachments: [{ uri: `https://example.com/file\r${injected}`, name: `Report\r${injected}`, mime: "" }],
            organizer: { email: `owner@example.com\n${injected}`, name: `Owner\r${injected}` },
            start: { dateTime: "2026-05-01T10:00:00", tzid: `vendor\r\n${injected}/Europe/Madrid` },
            end: { dateTime: "2026-05-01T11:00:00", tzid: "Europe/Madrid" },
            extra: engine.parseCalendarText(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "DTSTART:20260101T100000Z", `STATUS:ODD\\n${injected}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n")).items.flatMap((item) => (item.component === "VEVENT" ? (item.master?.extra ?? []) : []))
        });
        const text = engine.serializeItem(engine.eventItem(event));
        const lines = text.split("\r\n");
        for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001F\u007F]/);
        expect(lines.filter((line) => line.startsWith("ATTENDEE"))).toEqual([]);
        const back = engine.parseCalendarText(text).items[0];
        if (!back || back.component !== "VEVENT" || !back.master) throw new Error("no event");
        expect(back.master.attendees).toEqual([]);
        expect(back.master.summary).toBe(`Lone return\n${injected}`);
        expect(back.master.conference).toBe(`https://meet.example.com/room${injected}`);
    });

    it("never copies METHOD from the item, and takes a PRODID", () => {
        const item: engine.CalendarItem = { ...engine.eventItem(long), method: "REQUEST" };
        const text = engine.serializeItem(item, { prodId: "-//Other//EN" });
        expect(text).not.toContain("METHOD:");
        expect(text).toContain("PRODID:-//Other//EN");
    });

    it("builds new events and tasks with defaults and fresh UIDs", () => {
        const a = engine.newEvent({ start: { date: "2026-01-01" }, end: { date: "2026-01-02" } });
        const b = engine.newEvent({ start: { date: "2026-01-01" }, end: { date: "2026-01-02" } });
        expect(a.uid).not.toBe(b.uid);
        expect(a).toMatchObject({ sequence: 0, transparency: "OPAQUE", classification: "PUBLIC", kind: "default", rule: null, alarms: [] });
        const todo = engine.newTodo({ summary: "Call", due: { date: "2026-01-03" } });
        const again = roundTrip(engine.todoItem(todo));
        expect(again.component === "VTODO" && again.todo).toMatchObject({ uid: todo.uid, summary: "Call", due: { date: "2026-01-03" }, status: "NEEDS-ACTION" });
    });
});

describe("itemBounds", () => {
    const item = (...lines: string[]) => {
        const [found] = engine.parseCalendarText(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "SUMMARY:Bounds", "LOCATION:Here", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n")).items;
        if (!found) throw new Error("no item");
        return found;
    };

    it("indexes a single event by its span", () => {
        const bounds = engine.itemBounds(item("DTSTART:20260101T100000Z", "DTEND:20260101T110000Z", "STATUS:TENTATIVE"), "UTC");
        expect(bounds).toEqual({ startsAt: new Date("2026-01-01T10:00:00Z"), endsAt: new Date("2026-01-01T11:00:00Z"), recurring: false, allDay: false, summary: "Bounds", location: "Here", status: "TENTATIVE" });
    });

    it("walks a finite series to the end of its last occurrence", () => {
        const bounds = engine.itemBounds(item("DTSTART:20260101T100000Z", "DTEND:20260101T110000Z", "RRULE:FREQ=WEEKLY;COUNT=3"), "UTC");
        expect(bounds.endsAt?.toISOString()).toBe("2026-01-15T11:00:00.000Z");
        expect(bounds.recurring).toBe(true);
        const until = engine.itemBounds(item("DTSTART;VALUE=DATE:20260101", "RRULE:FREQ=DAILY;UNTIL=20260110"), "Europe/Madrid");
        expect(until.endsAt?.toISOString()).toBe("2026-01-10T23:00:00.000Z");
        expect(until.allDay).toBe(true);
    });

    it("marks an endless series, and one past 5000 occurrences, as never ending", () => {
        expect(engine.itemBounds(item("DTSTART:20260101T100000Z", "RRULE:FREQ=DAILY"), "UTC").endsAt).toBeNull();
        expect(engine.itemBounds(item("DTSTART:20260101T100000Z", "RRULE:FREQ=MINUTELY;COUNT=6000"), "UTC").endsAt).toBeNull();
    });
});
