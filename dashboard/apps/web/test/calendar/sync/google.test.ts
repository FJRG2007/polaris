/**
 * The Google Calendar provider against an in-memory Calendar API.
 *
 * Google splits a recurring series into a master and one event per changed
 * occurrence; the sync engine stores one object per UID. These pin the
 * regrouping both ways, the sync-token lifecycle (pages, incremental changes,
 * deletions, 410) and the etag discipline on writes.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseCalendarText } from "@polaris-app/calendar/src/engine";
import {
    SyncAuthError,
    SyncConflictError,
    SyncGoneError,
    SyncUnreachableError,
    createGoogleProvider,
    type CalendarProvider,
    type ChangeSet
} from "@polaris-app/calendar/src/lib/sync";
import { createFakeGoogle } from "./fixtures/fake-google";

type Fake = ReturnType<typeof createFakeGoogle>;

function seed(fake: Fake) {
    fake.put({
        id: "a",
        iCalUID: "a@google.com",
        status: "confirmed",
        summary: "Dentist",
        start: { dateTime: "2026-10-05T10:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-10-05T11:00:00+02:00", timeZone: "Europe/Madrid" },
        attendees: [
            { email: "Bob@Example.test", displayName: "Bob", responseStatus: "tentative", optional: true },
            { email: "room-1@resource.example.test", displayName: "Room 1", responseStatus: "accepted", resource: true }
        ],
        organizer: { email: "me@example.test", displayName: "Me" },
        reminders: { useDefault: true },
        colorId: "11",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        htmlLink: "https://www.google.com/calendar/event?eid=YQ",
        visibility: "private",
        transparency: "transparent",
        eventType: "focusTime",
        sequence: 2
    });
    fake.put({
        id: "b",
        iCalUID: "b@google.com",
        status: "confirmed",
        summary: "Holiday",
        start: { date: "2026-10-10" },
        end: { date: "2026-10-11" },
        reminders: { useDefault: false, overrides: [{ method: "email", minutes: 1440 }, { method: "popup", minutes: 30 }] }
    });
    fake.put({
        id: "m",
        iCalUID: "m@google.com",
        status: "confirmed",
        summary: "Standup",
        start: { dateTime: "2026-10-01T09:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-10-01T09:15:00+02:00", timeZone: "Europe/Madrid" },
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH", "EXDATE;TZID=Europe/Madrid:20261022T090000"]
    });
    fake.put({
        id: "m_20261008T070000Z",
        iCalUID: "m@google.com",
        status: "confirmed",
        recurringEventId: "m",
        originalStartTime: { dateTime: "2026-10-08T09:00:00+02:00", timeZone: "Europe/Madrid" },
        summary: "Standup (moved)",
        start: { dateTime: "2026-10-08T11:00:00+02:00", timeZone: "Europe/Madrid" },
        end: { dateTime: "2026-10-08T11:15:00+02:00", timeZone: "Europe/Madrid" }
    });
    fake.put({
        id: "m_20261015T070000Z",
        iCalUID: "m@google.com",
        status: "cancelled",
        recurringEventId: "m",
        originalStartTime: { dateTime: "2026-10-15T09:00:00+02:00", timeZone: "Europe/Madrid" }
    });
}

const eventsOf = (ics: string) => {
    const item = parseCalendarText(ics).items[0]!;
    if (item.component !== "VEVENT") throw new Error("not an event");
    return item;
};

describe("createGoogleProvider", () => {
    let fake: Fake;
    let provider: CalendarProvider;
    let first: ChangeSet;

    beforeEach(async () => {
        fake = createFakeGoogle({ pageSize: 3 });
        seed(fake);
        provider = createGoogleProvider({ accessToken: fake.accessToken, fetcher: fake.fetcher });
        first = await provider.pull({ remoteId: fake.calendarId, syncToken: "", ctag: "", known: new Map() });
    });

    it("lists calendars with their access, colour and zone", async () => {
        const calendars = await provider.listCalendars();
        expect(calendars.map((c) => [c.remoteId, c.name, c.color, c.readOnly, c.timezone])).toEqual([
            [fake.calendarId, "Me", "#9fe1e7", false, "Europe/Madrid"],
            ["holidays@group.v.calendar.google.com", "Festivos", "#16a765", true, "Europe/Madrid"],
            ["busy@example.test", "Busy", null, true, null]
        ]);
    });

    it("does a full sync over two pages and groups a series into one object", () => {
        const listings = fake.requests.filter((r) => r.url.pathname.endsWith("/events") && !r.url.searchParams.has("iCalUID"));
        expect(listings).toHaveLength(2);
        expect(listings[0]!.url.searchParams.get("showDeleted")).toBe("true");
        expect(listings[0]!.url.searchParams.get("singleEvents")).toBe("false");
        expect(listings[0]!.url.searchParams.get("maxResults")).toBe("2500");
        expect(listings[1]!.url.searchParams.get("pageToken")).toBe("3");
        expect(first.full).toBe(true);
        expect(first.syncToken).toBe("tok-5");
        expect(first.changed.map((o) => o.href).sort()).toEqual(["a", "b", "m"]);

        const series = first.changed.find((o) => o.href === "m")!;
        expect(series.etag).toBe([fake.get("m")!.etag, fake.get("m_20261008T070000Z")!.etag, fake.get("m_20261015T070000Z")!.etag].join(","));
        const item = eventsOf(series.ics);
        expect(item.uid).toBe("m@google.com");
        expect(item.master!.rule!.frequency).toBe("WEEKLY");
        expect(item.master!.start).toEqual({ dateTime: "2026-10-01T09:00:00", tzid: "Europe/Madrid" });
        expect(item.master!.exdates).toEqual([
            { dateTime: "2026-10-22T09:00:00", tzid: "Europe/Madrid" },
            { dateTime: "2026-10-15T09:00:00", tzid: "Europe/Madrid" }
        ]);
        expect(item.overrides).toHaveLength(1);
        expect(item.overrides[0]!.recurrenceId).toEqual({ dateTime: "2026-10-08T09:00:00", tzid: "Europe/Madrid" });
        expect(item.overrides[0]!.start).toEqual({ dateTime: "2026-10-08T11:00:00", tzid: "Europe/Madrid" });
        expect(item.overrides[0]!.summary).toBe("Standup (moved)");
    });

    it("maps an event's people, reminders, colour, visibility and kind", () => {
        const a = first.changed.find((o) => o.href === "a")!;
        const event = eventsOf(a.ics).master!;
        expect(event.classification).toBe("PRIVATE");
        expect(event.transparency).toBe("TRANSPARENT");
        expect(event.kind).toBe("focusTime");
        expect(event.color).toBe("#dc2127");
        expect(event.conference).toBe("https://meet.google.com/abc-defg-hij");
        expect(event.url).toBe("https://www.google.com/calendar/event?eid=YQ");
        expect(event.sequence).toBe(2);
        expect(event.organizer).toEqual({ email: "me@example.test", name: "Me" });
        expect(event.attendees.map((x) => [x.email, x.role, x.partstat, x.type])).toEqual([
            ["bob@example.test", "OPT-PARTICIPANT", "TENTATIVE", "INDIVIDUAL"],
            ["room-1@resource.example.test", "REQ-PARTICIPANT", "ACCEPTED", "RESOURCE"]
        ]);
        expect(event.alarms).toEqual([]);
        expect(a.ics).toContain("X-GOOGLE-COLOR-ID:11");
        expect(a.ics).toContain("X-POLARIS-GOOGLE-DEFAULT-REMINDERS:1");

        const b = eventsOf(first.changed.find((o) => o.href === "b")!.ics).master!;
        expect(b.start).toEqual({ date: "2026-10-10" });
        expect(b.alarms.map((x) => [x.action, x.trigger])).toEqual([
            ["EMAIL", { kind: "relative", minutes: -1440, related: "START" }],
            ["DISPLAY", { kind: "relative", minutes: -30, related: "START" }]
        ]);
    });

    it("pulls a changed event, a newly cancelled occurrence and a deletion incrementally", async () => {
        const known = new Map(first.changed.map((o) => [o.href, o.etag]));
        fake.put({ ...fake.get("a")!, summary: "Dentist (moved)" });
        fake.put({
            id: "m_20261029T080000Z",
            iCalUID: "m@google.com",
            status: "cancelled",
            recurringEventId: "m",
            originalStartTime: { dateTime: "2026-10-29T09:00:00+01:00", timeZone: "Europe/Madrid" }
        });
        fake.cancel("b");
        const next = await provider.pull({ remoteId: fake.calendarId, syncToken: first.syncToken, ctag: "", known });
        expect(next.full).toBe(false);
        expect(next.syncToken).toBe("tok-8");
        expect(next.removed).toEqual(["b"]);
        expect(next.changed.map((o) => o.href).sort()).toEqual(["a", "m"]);
        expect(eventsOf(next.changed.find((o) => o.href === "a")!.ics).master!.summary).toBe("Dentist (moved)");
        const series = eventsOf(next.changed.find((o) => o.href === "m")!.ics);
        expect(series.master!.exdates).toContainEqual({ dateTime: "2026-10-29T09:00:00", tzid: "Europe/Madrid" });
        expect(series.master!.exdates).toHaveLength(3);
        expect(series.overrides).toHaveLength(1);
    });

    it("throws SyncGoneError on an expired token", async () => {
        fake.expire(first.syncToken);
        await expect(provider.pull({ remoteId: fake.calendarId, syncToken: first.syncToken, ctag: "", known: new Map() })).rejects.toBeInstanceOf(SyncGoneError);
    });

    it("updates with If-Match, invites attendees, and answers a stale etag as a conflict", async () => {
        const a = first.changed.find((o) => o.href === "a")!;
        fake.put({ ...fake.get("a")!, summary: "Changed on the phone" });
        await expect(provider.put({ remoteId: fake.calendarId }, { href: "a", etag: a.etag, ics: a.ics, uid: "a@google.com" })).rejects.toBeInstanceOf(SyncConflictError);

        const current = fake.get("a")!.etag;
        const edited = a.ics.replace("SUMMARY:Dentist", "SUMMARY:Dentist, again");
        const written = await provider.put({ remoteId: fake.calendarId }, { href: "a", etag: current, ics: edited, uid: "a@google.com" });
        const patch = fake.requests.find((r) => r.method === "PATCH" && r.headers["if-match"] === current)!;
        expect(patch.url.searchParams.get("sendUpdates")).toBe("all");
        expect(patch.body).toMatchObject({
            summary: "Dentist, again",
            visibility: "private",
            transparency: "transparent",
            colorId: "11",
            reminders: { useDefault: true },
            start: { dateTime: "2026-10-05T10:00:00", timeZone: "Europe/Madrid" },
            attendees: [
                { email: "bob@example.test", displayName: "Bob", optional: true, responseStatus: "tentative" },
                { email: "room-1@resource.example.test", displayName: "Room 1", resource: true, responseStatus: "accepted" }
            ]
        });
        expect(written).toEqual({ href: "a", etag: fake.get("a")!.etag });
        expect(fake.get("a")!.summary).toBe("Dentist, again");
    });

    it("creates a series and writes its changed occurrence to the instance id", async () => {
        const ics = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Test//EN",
            "BEGIN:VEVENT",
            "UID:new-series@polaris.test",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=Europe/Madrid:20261102T100000",
            "DTEND;TZID=Europe/Madrid:20261102T110000",
            "RRULE:FREQ=DAILY;COUNT=5",
            "SUMMARY:Daily",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:new-series@polaris.test",
            "DTSTAMP:20260101T000000Z",
            "RECURRENCE-ID;TZID=Europe/Madrid:20261104T100000",
            "DTSTART;TZID=Europe/Madrid:20261104T120000",
            "DTEND;TZID=Europe/Madrid:20261104T130000",
            "SUMMARY:Daily (late)",
            "END:VEVENT",
            "END:VCALENDAR",
            ""
        ].join("\r\n");
        const written = await provider.put({ remoteId: fake.calendarId }, { href: null, etag: null, ics, uid: "new-series@polaris.test" });
        const insert = fake.requests.find((r) => r.method === "POST")!;
        expect(insert.url.searchParams.get("sendUpdates")).toBe("none");
        expect(insert.body).toMatchObject({
            iCalUID: "new-series@polaris.test",
            summary: "Daily",
            recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
            start: { dateTime: "2026-11-02T10:00:00", timeZone: "Europe/Madrid" }
        });
        const instance = fake.requests.find((r) => r.method === "PATCH")!;
        expect(instance.url.pathname).toMatch(new RegExp(`/events/${written.href}_20261104T090000Z$`));
        expect(instance.body).toMatchObject({ summary: "Daily (late)", start: { dateTime: "2026-11-04T12:00:00", timeZone: "Europe/Madrid" } });
        expect(instance.body).not.toHaveProperty("recurrence");
        expect(written.etag.split(",")).toHaveLength(2);

        const pulled = await provider.pull({ remoteId: fake.calendarId, syncToken: "", ctag: "", known: new Map() });
        const object = pulled.changed.find((o) => o.href === written.href)!;
        expect(object.etag).toBe(written.etag);
        expect(eventsOf(object.ics).overrides[0]!.summary).toBe("Daily (late)");
    });

    it("deletes with If-Match", async () => {
        const a = first.changed.find((o) => o.href === "a")!;
        await provider.remove({ remoteId: fake.calendarId }, { href: "a", etag: a.etag });
        const request = fake.requests.at(-1)!;
        expect(request.method).toBe("DELETE");
        expect(request.headers["if-match"]).toBe(a.etag.split(",")[0]);
        expect(fake.get("a")!.status).toBe("cancelled");
    });

    it("treats rate limits as retryable, not as a broken sign-in", async () => {
        fake.failWith(new Response(JSON.stringify({ error: { code: 403, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }), { status: 403 }));
        await expect(provider.listCalendars()).rejects.toBeInstanceOf(SyncUnreachableError);
        fake.failWith(new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
        const error = await provider.listCalendars().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SyncUnreachableError);
        expect((error as SyncUnreachableError).retryAfterSeconds).toBe(30);

        const signedOut = createGoogleProvider({ accessToken: async () => "revoked", fetcher: fake.fetcher });
        await expect(signedOut.listCalendars()).rejects.toBeInstanceOf(SyncAuthError);
        const failing = createGoogleProvider({ accessToken: async () => { throw new Error("invalid_grant"); }, fetcher: fake.fetcher });
        await expect(failing.listCalendars()).rejects.toBeInstanceOf(SyncAuthError);
    });
});
