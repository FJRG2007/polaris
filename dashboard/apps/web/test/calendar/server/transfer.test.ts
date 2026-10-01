/**
 * Files in and out: an import keeps what the calendar already has, reports what
 * it could not read, and invites nobody; an export is one VCALENDAR with each
 * time zone once that the engine reads back to the same events.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import * as transfer from "@polaris-app/calendar/src/lib/transfer";

const ZONE = "Europe/Madrid";

const MADRID = [
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Madrid",
    "BEGIN:STANDARD",
    "DTSTART:19701025T030000",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "DTSTART:19700329T020000",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "END:VTIMEZONE"
];

function vevent(uid: string, summary: string, day: string, extra: string[] = []): string[] {
    return [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260901T000000Z",
        `DTSTART;TZID=Europe/Madrid:${day}T100000`,
        `DTEND;TZID=Europe/Madrid:${day}T110000`,
        `SUMMARY:${summary}`,
        ...extra,
        "END:VEVENT"
    ];
}

function file(...events: string[][]): string {
    return `${["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Test//EN", ...MADRID, ...events.flat(), "END:VCALENDAR"].join("\r\n")}\r\n`;
}

describe("calendar import and export", () => {
    let alice: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        calendar = world.addCalendar(alice.id, {
            name: "Work, main",
            color: "#0082c9",
            timezone: ZONE
        });
    });

    it("skips events whose UID the calendar already holds, keeping the edits made since", async () => {
        world.storeEvent(calendar, {
            uid: "kept@example",
            summary: "Edited here",
            start: world.at("2026-10-05T10:00:00"),
            end: world.at("2026-10-05T11:00:00")
        });
        const result = await transfer.importCalendar(alice, {
            target: { kind: "existing", calendarId: calendar },
            text: file(
                vevent("kept@example", "Original", "20261005"),
                vevent("new@example", "Fresh", "20261006")
            ),
            floatingZone: ZONE
        });
        expect(result).toMatchObject({
            calendarId: calendar,
            imported: 1,
            skipped: 1,
            problems: []
        });
        const rows = world.objectsIn(calendar);
        expect(rows.map((row) => row.summary).sort()).toEqual(["Edited here", "Fresh"]);
        expect(rows.find((row) => row.uid === "new@example")?.startsAt).toEqual(
            new Date("2026-10-06T08:00:00Z")
        );
    });

    it("reports what it could not read, in words, and imports the rest", async () => {
        const broken = [
            "BEGIN:VEVENT",
            "UID:broken@example",
            "SUMMARY:No start",
            "RRULE:FREQ=WEEKLY",
            "END:VEVENT"
        ];
        const result = await transfer.importCalendar(alice, {
            target: { kind: "existing", calendarId: calendar },
            text: file(broken, vevent("good@example", "Good", "20261007")),
            floatingZone: ZONE
        });
        expect(result.imported).toBe(1);
        expect(result.problems.length).toBeGreaterThan(0);
        expect(
            result.problems.every((problem) => problem.length > 0 && !problem.startsWith("parse."))
        ).toBe(true);
    });

    it("refuses a file with nothing in it", async () => {
        await expect(
            transfer.importCalendar(alice, {
                target: { kind: "existing", calendarId: calendar },
                text: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.emptyImport"));
    });

    it("imports into a new calendar, with tasks switched on when the file has some, and invites nobody", async () => {
        const todo = [
            "BEGIN:VTODO",
            "UID:todo@example",
            "DTSTAMP:20260901T000000Z",
            "SUMMARY:File taxes",
            "DUE;VALUE=DATE:20261020",
            "END:VTODO"
        ];
        const invite = vevent("meeting@example", "Meeting", "20261008", [
            `ORGANIZER:mailto:${alice.email}`,
            "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@outside.test"
        ]);
        const result = await transfer.importCalendar(alice, {
            target: { kind: "new", name: "Imported", color: "#2ca02c" },
            text: file(invite, todo).replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST"),
            floatingZone: ZONE
        });
        expect(result.imported).toBe(2);
        expect(db.byId("calendar", result.calendarId)).toMatchObject({
            name: "Imported",
            color: "#2ca02c",
            components: "VEVENT,VTODO",
            ownerId: alice.id
        });
        expect(fake.mails).toEqual([]);
        expect(db.rows("calendarInvitation")).toEqual([]);
        const meeting = world
            .objectsIn(result.calendarId)
            .find((row) => row.uid === "meeting@example");
        expect(String(meeting?.ics)).not.toMatch(/METHOD:/);
    });

    it("exports every event with each time zone once, and reads back to the same events", async () => {
        const first = file(vevent("one@example", "First\\; with a semicolon", "20261005"));
        const second = file(
            vevent("two@example", "Second", "20261006", ["RRULE:FREQ=WEEKLY;COUNT=3"])
        );
        for (const [uid, text] of [
            ["one@example", first],
            ["two@example", second]
        ] as const) {
            const item = engine.parseCalendarText(text).items[0]!;
            world.storeItem(calendar, item, { uid, ics: text });
        }
        world.storeEvent(
            calendar,
            {
                uid: "gone@example",
                summary: "Deleted",
                start: world.at("2026-10-07T10:00:00"),
                end: world.at("2026-10-07T11:00:00")
            },
            { deletedAt: new Date() }
        );

        const exported = await transfer.exportCalendar(alice, calendar);
        expect(exported.name).toBe("Work, main");
        expect(exported.ics.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
        expect(exported.ics).toContain("X-WR-CALNAME:Work\\, main");
        expect(exported.ics).toContain("X-WR-TIMEZONE:Europe/Madrid");
        expect(exported.ics).not.toContain("Deleted");

        const parsed = engine.parseCalendarText(exported.ics);
        expect(parsed.errors).toEqual([]);
        const byUid = new Map(parsed.items.map((item) => [item.uid, item]));
        expect([...byUid.keys()].sort()).toEqual(["one@example", "two@example"]);
        const one = byUid.get("one@example");
        const two = byUid.get("two@example");
        if (one?.component !== "VEVENT" || two?.component !== "VEVENT")
            throw new Error("events expected");
        expect(one.master?.summary).toBe("First; with a semicolon");
        expect(one.master?.start).toEqual({
            dateTime: "2026-10-05T10:00:00",
            tzid: "Europe/Madrid"
        });
        expect(two.master?.rule?.count).toBe(3);
        expect(
            engine.expandItem(
                two,
                { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") },
                { floatingZone: ZONE }
            )
        ).toHaveLength(3);
    });

    it("exports nothing to a free/busy reader, and one event to a reader", async () => {
        const bob = addUser({ name: "Bob", email: "bob@example.test" });
        const row = world.storeEvent(calendar, {
            uid: "x@example",
            summary: "Secret",
            start: world.at("2026-10-05T10:00:00"),
            end: world.at("2026-10-05T11:00:00")
        });
        world.addShare(calendar, { userId: bob.id }, "freebusy");
        await expect(transfer.exportCalendar(bob, calendar)).rejects.toThrow(
            world.en("errors.calendarNotFound")
        );
        await expect(transfer.exportEvent(bob, String(row.id))).rejects.toThrow(
            world.en("errors.calendarNotFound")
        );
        db.rows("calendarShare")[0]!.access = "read";
        expect((await transfer.exportEvent(bob, String(row.id))).ics).toContain("Secret");
    });

    it("exports to a reader what the calendar shows them: private events as busy blocks, private tasks not at all", async () => {
        const bob = addUser({ name: "Bob", email: "bob@example.test" });
        world.storeEvent(calendar, {
            uid: "open@example",
            summary: "Launch",
            start: world.at("2026-10-05T10:00:00"),
            end: world.at("2026-10-05T11:00:00")
        });
        const hidden = world.storeEvent(calendar, {
            uid: "closed@example",
            summary: "Therapy",
            location: "Clinic",
            description: "Session notes",
            classification: "PRIVATE",
            attendees: [
                {
                    email: "doctor@outside.test",
                    name: "",
                    role: "REQ-PARTICIPANT",
                    partstat: "ACCEPTED",
                    rsvp: false,
                    type: "INDIVIDUAL"
                }
            ],
            start: world.at("2026-10-06T10:00:00"),
            end: world.at("2026-10-06T11:00:00")
        });
        const task = engine.newTodo({
            uid: "task@example",
            summary: "Lawyer",
            due: world.at("2026-10-07T12:00:00")
        });
        world.storeItem(calendar, engine.todoItem({ ...task, extra: [{ line: "CLASS:PRIVATE" }] }));
        world.addShare(calendar, { userId: bob.id }, "read");

        const file = (await transfer.exportCalendar(bob, calendar)).ics;
        expect(file).toContain("Launch");
        for (const secret of [
            "Therapy",
            "Clinic",
            "Session notes",
            "doctor@outside.test",
            "Lawyer"
        ])
            expect(file).not.toContain(secret);
        expect(
            engine
                .parseCalendarText(file)
                .items.map((item) => item.uid)
                .sort()
        ).toEqual(["closed@example", "open@example"]);
        const one = await transfer.exportEvent(bob, String(hidden.id));
        expect(one.name).toBe("event");
        expect(one.ics).not.toContain("Therapy");

        db.rows("calendarShare")[0]!.access = "write";
        expect((await transfer.exportCalendar(bob, calendar)).ics).toContain("Therapy");
        expect((await transfer.exportCalendar(alice, calendar)).ics).toContain("Lawyer");
    });

    it("names a download with safe characters only", () => {
        expect(transfer.fileName("Café / Équipe: plans", "ics")).toBe("Cafe-Equipe-plans.ics");
        expect(transfer.fileName("///", "ics")).toBe("calendar.ics");
    });
});
