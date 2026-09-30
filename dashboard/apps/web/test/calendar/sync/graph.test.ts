/**
 * The Microsoft Graph provider against an in-memory Graph.
 *
 * Graph's delta speaks in expanded occurrences; the store keeps one object per
 * series. These pin the regrouping (master + exceptions + cancelled
 * occurrences), the delta-link lifecycle, `patternedRecurrence` <-> RRULE for
 * every pattern type Outlook has, and the etag discipline on writes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseCalendarText, parseRule } from "@polaris-app/calendar/src/engine";
import {
    SyncConflictError,
    SyncGoneError,
    SyncRefusedError,
    createGraphProvider,
    patternToRrule,
    ruleToPattern,
    type CalendarProvider,
    type ChangeSet
} from "@polaris-app/calendar/src/lib/sync";
import { GRAPH, createFakeGraph } from "./fixtures/fake-graph";

type Fake = ReturnType<typeof createFakeGraph>;

const single = {
    id: "s1",
    type: "singleInstance",
    iCalUId: "s1-uid",
    subject: "Review",
    body: { contentType: "html", content: "<html><body><p>Agenda:<br>one &amp; two</p></body></html>" },
    start: { dateTime: "2026-10-05T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-05T09:00:00.0000000", timeZone: "UTC" },
    originalStartTimeZone: "Romance Standard Time",
    showAs: "free",
    sensitivity: "private",
    isReminderOn: true,
    reminderMinutesBeforeStart: 15,
    attendees: [
        { emailAddress: { address: "Ann@example.test", name: "Ann" }, type: "optional", status: { response: "accepted" } },
        { emailAddress: { address: "room@example.test", name: "Room" }, type: "resource", status: { response: "none" } }
    ],
    organizer: { emailAddress: { address: "me@example.test", name: "Me" } },
    onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/example" },
    location: { displayName: "Room 4" },
    "@odata.etag": "W/\"s1-1\""
};

const exception = {
    id: "m1-ex1",
    type: "exception",
    seriesMasterId: "m1",
    subject: "Weekly (long)",
    originalStart: "2026-10-13T07:00:00Z",
    start: { dateTime: "2026-10-13T07:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-13T08:30:00.0000000", timeZone: "UTC" },
    "@odata.etag": "W/\"ex1-1\""
};

const master = {
    id: "m1",
    type: "seriesMaster",
    iCalUId: "m1-uid",
    subject: "Weekly",
    start: { dateTime: "2026-10-06T07:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-06T07:30:00.0000000", timeZone: "UTC" },
    originalStartTimeZone: "Romance Standard Time",
    recurrence: {
        pattern: { type: "weekly", interval: 1, daysOfWeek: ["tuesday"], firstDayOfWeek: "monday", index: "first" },
        range: { type: "endDate", startDate: "2026-10-06", endDate: "2026-12-29", recurrenceTimeZone: "Romance Standard Time" }
    },
    cancelledOccurrences: ["OID.m1.2026-10-20"],
    exceptionOccurrences: [exception],
    "@odata.etag": "W/\"m1-1\""
};

const eventsOf = (ics: string) => {
    const item = parseCalendarText(ics).items[0]!;
    if (item.component !== "VEVENT") throw new Error("not an event");
    return item;
};

describe("createGraphProvider", () => {
    let fake: Fake;
    let provider: CalendarProvider;
    let first: ChangeSet;

    beforeEach(async () => {
        fake = createFakeGraph();
        fake.store(single);
        fake.store(master);
        fake.round("initial", [[single, { id: "m1-occ1", type: "occurrence", seriesMasterId: "m1" }], [exception]], "d1");
        fake.round("d1", [[{ id: "s1", "@removed": { reason: "deleted" } }]], "d2");
        provider = createGraphProvider({ accessToken: fake.accessToken, fetcher: fake.fetcher });
        first = await provider.pull({ remoteId: "cal-1", syncToken: "", ctag: "", known: new Map() });
    });

    it("lists calendars with colour and write access", async () => {
        const calendars = await provider.listCalendars();
        expect(calendars.map((c) => [c.remoteId, c.name, c.color, c.readOnly])).toEqual([
            ["cal-1", "Calendar", "#e3008c", false],
            ["cal-2", "Shared with me", null, true]
        ]);
    });

    it("follows nextLink to the deltaLink and asks for UTC in pages of 200", () => {
        const deltas = fake.requests.filter((r) => r.url.pathname.endsWith("/calendarView/delta"));
        expect(deltas).toHaveLength(2);
        expect(deltas[0]!.url.searchParams.get("startDateTime")).toBeTruthy();
        expect(deltas[1]!.url.searchParams.get("$skiptoken")).toBe("initial.1");
        expect(deltas[0]!.headers.prefer).toContain("odata.maxpagesize=200");
        expect(deltas[0]!.headers.prefer).toContain("outlook.timezone=\"UTC\"");
        expect(first.full).toBe(true);
        expect(first.syncToken).toBe(`${GRAPH}/me/calendars/cal-1/calendarView/delta?$deltatoken=d1`);
        expect(first.changed.map((o) => o.href).sort()).toEqual(["m1", "s1"]);
    });

    it("maps a single event in its own zone, with HTML kept aside", () => {
        const object = first.changed.find((o) => o.href === "s1")!;
        expect(object.etag).toBe("W/\"s1-1\"");
        const event = eventsOf(object.ics).master!;
        expect(event.uid).toBe("s1-uid");
        expect(event.start).toEqual({ dateTime: "2026-10-05T10:00:00", tzid: "Europe/Paris" });
        expect(event.description).toBe("Agenda:\none & two");
        expect(object.ics).toContain("X-ALT-DESC;FMTTYPE=text/html:");
        expect(event.location).toBe("Room 4");
        expect(event.transparency).toBe("TRANSPARENT");
        expect(event.classification).toBe("PRIVATE");
        expect(event.conference).toBe("https://teams.microsoft.com/l/meetup-join/example");
        expect(event.alarms.map((a) => a.trigger)).toEqual([{ kind: "relative", minutes: -15, related: "START" }]);
        expect(event.attendees.map((a) => [a.email, a.role, a.partstat, a.type])).toEqual([
            ["ann@example.test", "OPT-PARTICIPANT", "ACCEPTED", "INDIVIDUAL"],
            ["room@example.test", "NON-PARTICIPANT", "NEEDS-ACTION", "RESOURCE"]
        ]);
    });

    it("groups a series master, its exception and a cancelled occurrence into one object", () => {
        const object = first.changed.find((o) => o.href === "m1")!;
        expect(object.etag).toBe("W/\"m1-1\",W/\"ex1-1\"");
        const item = eventsOf(object.ics);
        expect(item.uid).toBe("m1-uid");
        expect(item.master!.start).toEqual({ dateTime: "2026-10-06T09:00:00", tzid: "Europe/Paris" });
        expect(item.master!.rule).toMatchObject({ frequency: "WEEKLY", byDay: [{ day: "TU", ordinal: null }], weekStart: "MO" });
        expect(item.master!.exdates).toEqual([{ dateTime: "2026-10-20T09:00:00", tzid: "Europe/Paris" }]);
        expect(item.overrides).toHaveLength(1);
        expect(item.overrides[0]!.recurrenceId).toEqual({ dateTime: "2026-10-13T09:00:00", tzid: "Europe/Paris" });
        expect(item.overrides[0]!.end).toEqual({ dateTime: "2026-10-13T10:30:00", tzid: "Europe/Paris" });
        expect(item.overrides[0]!.summary).toBe("Weekly (long)");
    });

    it("reports @removed entries from the next round", async () => {
        const known = new Map(first.changed.map((o) => [o.href, o.etag]));
        const next = await provider.pull({ remoteId: "cal-1", syncToken: first.syncToken, ctag: "", known });
        expect(next.full).toBe(false);
        expect(next.removed).toEqual(["s1"]);
        expect(next.changed).toEqual([]);
        expect(next.syncToken).toBe(`${GRAPH}/me/calendars/cal-1/calendarView/delta?$deltatoken=d2`);
    });

    it("throws SyncGoneError when Graph lost the sync state", async () => {
        await expect(provider.pull({ remoteId: "cal-1", syncToken: `${GRAPH}/me/calendars/cal-1/calendarView/delta?$deltatoken=expired`, ctag: "", known: new Map() })).rejects.toBeInstanceOf(SyncGoneError);
    });

    it("never sends the token to a stored link outside Graph", async () => {
        const before = fake.requests.length;
        await expect(provider.pull({ remoteId: "cal-1", syncToken: "https://attacker.example/delta", ctag: "", known: new Map() })).rejects.toBeInstanceOf(SyncGoneError);
        expect(fake.requests.length).toBe(before);
    });

    it("updates with If-Match and answers a stale etag as a conflict", async () => {
        const object = first.changed.find((o) => o.href === "s1")!;
        await expect(provider.put({ remoteId: "cal-1" }, { href: "s1", etag: "W/\"old\"", ics: object.ics, uid: "s1-uid" })).rejects.toBeInstanceOf(SyncConflictError);
        const written = await provider.put({ remoteId: "cal-1" }, { href: "s1", etag: object.etag, ics: object.ics.replace("SUMMARY:Review", "SUMMARY:Review 2"), uid: "s1-uid" });
        const patch = fake.requests.filter((r) => r.method === "PATCH").at(-1)!;
        expect(patch.headers["if-match"]).toBe("W/\"s1-1\"");
        expect(patch.body).toMatchObject({
            subject: "Review 2",
            body: { contentType: "html", content: single.body.content },
            start: { dateTime: "2026-10-05T10:00:00", timeZone: "Europe/Paris" },
            showAs: "free",
            sensitivity: "private",
            isReminderOn: true,
            reminderMinutesBeforeStart: 15,
            attendees: [
                { emailAddress: { address: "ann@example.test", name: "Ann" }, type: "optional" },
                { emailAddress: { address: "room@example.test", name: "Room" }, type: "resource" }
            ],
            recurrence: null
        });
        expect(written.href).toBe("s1");
        expect(written.etag).toBe(fake.events.get("s1")!["@odata.etag"]);
    });

    it("creates a series, then edits and cancels its occurrences", async () => {
        fake.instances.set("new-1", [
            { id: "occ-a", type: "occurrence", seriesMasterId: "new-1", originalStart: "2026-11-03T09:00:00Z", start: { dateTime: "2026-11-03T09:00:00.0000000", timeZone: "UTC" } },
            { id: "occ-b", type: "occurrence", seriesMasterId: "new-1", originalStart: "2026-11-04T09:00:00Z", start: { dateTime: "2026-11-04T09:00:00.0000000", timeZone: "UTC" } }
        ]);
        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Test//EN",
            "BEGIN:VEVENT",
            "UID:series@polaris.test",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=Europe/Paris:20261102T100000",
            "DTEND;TZID=Europe/Paris:20261102T110000",
            "RRULE:FREQ=DAILY;COUNT=5",
            "EXDATE;TZID=Europe/Paris:20261104T100000",
            "SUMMARY:Daily",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:series@polaris.test",
            "DTSTAMP:20260101T000000Z",
            "RECURRENCE-ID;TZID=Europe/Paris:20261103T100000",
            "DTSTART;TZID=Europe/Paris:20261103T150000",
            "DTEND;TZID=Europe/Paris:20261103T160000",
            "SUMMARY:Daily (afternoon)",
            "END:VEVENT",
            "END:VCALENDAR",
            ""
        ].join("\r\n");
        const written = await provider.put({ remoteId: "cal-1" }, { href: null, etag: null, ics, uid: "series@polaris.test" });
        expect(written.href).toBe("new-1");
        const create = fake.requests.find((r) => r.method === "POST")!;
        expect(create.url.pathname).toBe("/v1.0/me/calendars/cal-1/events");
        expect(create.body).toMatchObject({
            subject: "Daily",
            start: { dateTime: "2026-11-02T10:00:00", timeZone: "Europe/Paris" },
            recurrence: {
                pattern: { type: "daily", interval: 1 },
                range: { type: "numbered", numberOfOccurrences: 5, startDate: "2026-11-02", recurrenceTimeZone: "Europe/Paris" }
            },
            transactionId: "series@polaris.test"
        });
        const patch = fake.requests.find((r) => r.method === "PATCH")!;
        expect(patch.url.pathname).toBe("/v1.0/me/events/occ-a");
        expect(patch.body).toMatchObject({ subject: "Daily (afternoon)", start: { dateTime: "2026-11-03T15:00:00", timeZone: "Europe/Paris" } });
        expect(patch.body).not.toHaveProperty("recurrence");
        expect(fake.requests.find((r) => r.method === "DELETE")!.url.pathname).toBe("/v1.0/me/events/occ-b");
    });

    it("deletes with If-Match", async () => {
        await provider.remove({ remoteId: "cal-1" }, { href: "s1", etag: "W/\"s1-1\"" });
        expect(fake.requests.at(-1)!.headers["if-match"]).toBe("W/\"s1-1\"");
        expect(fake.events.has("s1")).toBe(false);
    });
});

describe("patternedRecurrence <-> RRULE", () => {
    const zone = "Europe/Paris";
    const cases: { name: string; startDate: string; recurrence: Parameters<typeof patternToRrule>[0]; rrule: string }[] = [
        {
            name: "daily",
            startDate: "2026-10-01",
            recurrence: { pattern: { type: "daily", interval: 2 }, range: { type: "noEnd", startDate: "2026-10-01" } },
            rrule: "FREQ=DAILY;INTERVAL=2"
        },
        {
            name: "weekly",
            startDate: "2026-10-05",
            recurrence: {
                pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "sunday" },
                range: { type: "numbered", startDate: "2026-10-05", numberOfOccurrences: 10 }
            },
            rrule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10;WKST=SU"
        },
        {
            name: "absoluteMonthly",
            startDate: "2026-10-15",
            recurrence: { pattern: { type: "absoluteMonthly", interval: 3, dayOfMonth: 15 }, range: { type: "noEnd", startDate: "2026-10-15" } },
            rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15"
        },
        {
            name: "relativeMonthly, one day",
            startDate: "2026-10-08",
            recurrence: { pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["thursday"], index: "second" }, range: { type: "noEnd", startDate: "2026-10-08" } },
            rrule: "FREQ=MONTHLY;BYDAY=2TH"
        },
        {
            name: "relativeMonthly, several days",
            startDate: "2026-10-30",
            recurrence: {
                pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["thursday", "friday"], index: "last" },
                range: { type: "endDate", startDate: "2026-10-30", endDate: "2027-06-30" }
            },
            rrule: "FREQ=MONTHLY;BYDAY=TH,FR;BYSETPOS=-1;UNTIL=20270630T215959Z"
        },
        {
            name: "absoluteYearly",
            startDate: "2027-03-15",
            recurrence: { pattern: { type: "absoluteYearly", interval: 1, month: 3, dayOfMonth: 15 }, range: { type: "noEnd", startDate: "2027-03-15" } },
            rrule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15"
        },
        {
            name: "relativeYearly",
            startDate: "2026-11-26",
            recurrence: {
                pattern: { type: "relativeYearly", interval: 1, month: 11, daysOfWeek: ["thursday"], index: "fourth" },
                range: { type: "endDate", startDate: "2026-11-26", endDate: "2030-12-31" }
            },
            rrule: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;UNTIL=20301231T225959Z"
        }
    ];

    for (const { name, startDate, recurrence, rrule } of cases) {
        it(`round-trips ${name}`, () => {
            expect(patternToRrule(recurrence, false, zone)).toBe(rrule);
            const back = ruleToPattern(parseRule(rrule), { dateTime: `${startDate}T09:00:00`, tzid: zone }, zone);
            expect(back.pattern).toMatchObject(recurrence.pattern);
            expect(back.range).toMatchObject({ ...recurrence.range, recurrenceTimeZone: zone });
        });
    }

    it("writes UNTIL as a date for an all-day series", () => {
        expect(patternToRrule({ pattern: { type: "daily", interval: 1 }, range: { type: "endDate", startDate: "2026-10-01", endDate: "2026-10-10" } }, true, "UTC")).toBe(
            "FREQ=DAILY;UNTIL=20261010"
        );
    });

    it("refuses a rule Outlook has no pattern for", () => {
        expect(() => ruleToPattern(parseRule("FREQ=HOURLY;INTERVAL=2"), { dateTime: "2026-10-01T09:00:00", tzid: zone }, zone)).toThrow(SyncRefusedError);
        expect(() => ruleToPattern(parseRule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"), { dateTime: "2026-10-01T09:00:00", tzid: zone }, zone)).toThrow(SyncRefusedError);
        expect(() => ruleToPattern(parseRule("FREQ=MONTHLY;BYMONTHDAY=1,15"), { dateTime: "2026-10-01T09:00:00", tzid: zone }, zone)).toThrow(SyncRefusedError);
    });
});
