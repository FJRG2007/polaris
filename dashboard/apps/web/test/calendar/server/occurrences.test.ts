/**
 * What a window of the calendar draws for one reader: series expanded into
 * occurrences, busy blocks only where the reader may not see details (a
 * free/busy share, a private event on a read-only share), tasks from calendars
 * and from Tasks, and a row that no longer parses counted rather than thrown.
 * The event editor's detail follows the same rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import { eventDetail, todoDetail } from "@polaris-app/calendar/src/lib/event-detail";
import { addressesOf, occurrencesIn } from "@polaris-app/calendar/src/lib/occurrences";
import { upcomingEvents } from "@polaris-app/calendar/src/lib/upcoming";

const ZONE = "Europe/Madrid";
const OCTOBER = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };

describe("occurrences in a window", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;
    let publicId: string;
    let privateId: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { components: "VEVENT,VTODO" });
        publicId = world.storeEvent(calendar, {
            summary: "Standup",
            location: "Room 2",
            start: world.at("2026-10-08T10:00:00"),
            end: world.at("2026-10-08T10:15:00"),
            rule: engine.parseRule("FREQ=WEEKLY"),
            alarms: [
                {
                    action: "DISPLAY",
                    trigger: { kind: "relative", minutes: -10, related: "START" },
                    description: ""
                }
            ]
        }).id as string;
        privateId = world.storeEvent(calendar, {
            summary: "Doctor",
            location: "Clinic",
            classification: "PRIVATE",
            extraComponents: [
                [
                    "BEGIN:VLOCATION",
                    "UID:loc-1",
                    "NAME:Clinic on Main Street",
                    "END:VLOCATION"
                ].join("\r\n")
            ],
            start: world.at("2026-10-09T09:00:00"),
            end: world.at("2026-10-09T10:00:00")
        }).id as string;
    });

    const read = (user: ReturnType<typeof addUser>, includeTasks = false) =>
        occurrencesIn(user, OCTOBER, { floatingZone: ZONE, emails: [user.email], includeTasks });

    it("expands a weekly series across the window, in order", async () => {
        const range = await read(alice);
        const standups = range.occurrences.filter((occurrence) => occurrence.objectId === publicId);
        expect(standups.map((occurrence) => occurrence.start)).toEqual([
            "2026-10-08T08:00:00.000Z",
            "2026-10-15T08:00:00.000Z",
            "2026-10-22T08:00:00.000Z",
            "2026-10-29T09:00:00.000Z"
        ]);
        expect(
            standups.every(
                (occurrence) => occurrence.recurring && occurrence.editable && !occurrence.busyOnly
            )
        ).toBe(true);
        expect(range.occurrences.map((occurrence) => occurrence.start)).toEqual(
            [...range.occurrences.map((occurrence) => occurrence.start)].sort()
        );
        expect(range.unreadable).toBe(0);
    });

    it("shows a writer everything, private events included", async () => {
        world.addShare(calendar, { userId: bob.id }, "write");
        const doctor = (await read(bob)).occurrences.find(
            (occurrence) => occurrence.objectId === privateId
        )!;
        expect(doctor.summary).toBe("Doctor");
        expect(doctor.location).toBe("Clinic");
        expect(doctor.busyOnly).toBe(false);
        expect(doctor.editable).toBe(true);
    });

    it("shows a read-only sharee public events in full and private ones as busy blocks", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        const range = await read(bob);
        const standup = range.occurrences.find((occurrence) => occurrence.objectId === publicId)!;
        expect(standup.summary).toBe("Standup");
        expect(standup.editable).toBe(false);
        const doctor = range.occurrences.find((occurrence) => occurrence.objectId === privateId)!;
        expect(doctor).toMatchObject({
            summary: "",
            location: "",
            busyOnly: true,
            hasAlarms: false,
            attendeeCount: 0,
            editable: false
        });
        expect(doctor.uid).toBe("");
        expect(standup.uid).not.toBe("");
    });

    it("draws an all-day event saved in UTC+14 for a reader in UTC-10", async () => {
        const day = world.storeItem(
            calendar,
            engine.eventItem(
                world.event({
                    summary: "Holiday",
                    start: { date: "2026-10-20" },
                    end: { date: "2026-10-21" }
                })
            ),
            {},
            "Pacific/Kiritimati"
        );
        const honolulu = {
            from: new Date("2026-10-20T10:00:00Z"),
            to: new Date("2026-10-21T10:00:00Z")
        };
        const range = await occurrencesIn(alice, honolulu, {
            floatingZone: "Pacific/Honolulu",
            emails: [],
            includeTasks: false
        });
        expect(
            range.occurrences
                .filter((occurrence) => occurrence.objectId === day.id)
                .map((occurrence) => occurrence.startDate)
        ).toEqual(["2026-10-20"]);
    });

    it("leaves busy blocks off the Overview card", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        const upcoming = await upcomingEvents(bob.id, 20, world.NOW);
        expect(upcoming.length).toBeGreaterThan(0);
        expect(upcoming.some((entry) => entry.id === privateId)).toBe(false);
        expect(upcoming.every((entry) => entry.title !== "")).toBe(true);
        expect(
            (await upcomingEvents(alice.id, 20, world.NOW)).some((entry) => entry.id === privateId)
        ).toBe(true);
    });

    it("hides a private task from a read-only sharee and shows it to a writer", async () => {
        const task = engine.newTodo({
            uid: "todo-private",
            summary: "Lawyer",
            due: world.at("2026-10-20T12:00:00")
        });
        world.storeItem(calendar, engine.todoItem({ ...task, extra: [{ line: "CLASS:PRIVATE" }] }));
        world.addShare(calendar, { userId: bob.id }, "read");
        expect(
            (await read(bob, true)).tasks.filter((entry) => entry.source === "calendar")
        ).toEqual([]);
        expect((await read(alice, true)).tasks.map((entry) => entry.title)).toContain("Lawyer");
    });

    it("shows a free/busy sharee nothing but busy blocks, and no tasks", async () => {
        world.addShare(calendar, { userId: bob.id }, "freebusy");
        world.storeItem(
            calendar,
            engine.todoItem(
                engine.newTodo({
                    uid: "todo-1",
                    summary: "Taxes",
                    due: world.at("2026-10-20T12:00:00")
                })
            )
        );
        const range = await read(bob, true);
        expect(range.occurrences.length).toBeGreaterThan(0);
        expect(
            range.occurrences.every(
                (occurrence) =>
                    occurrence.busyOnly && occurrence.summary === "" && occurrence.location === ""
            )
        ).toBe(true);
        expect(range.tasks).toEqual([]);
    });

    it("lists a calendar's tasks due in the window, and the reader's Tasks-app tasks", async () => {
        world.storeItem(
            calendar,
            engine.todoItem(
                engine.newTodo({
                    uid: "todo-1",
                    summary: "Taxes",
                    due: world.at("2026-10-20T12:00:00")
                })
            )
        );
        world.storeItem(
            calendar,
            engine.todoItem(
                engine.newTodo({
                    uid: "todo-2",
                    summary: "Next year",
                    due: world.at("2027-01-20T12:00:00")
                })
            )
        );
        fake.tasks.push({
            id: "task-1",
            name: "Write report",
            due: "2026-10-12T00:00:00.000Z",
            timed: false,
            done: false,
            reference: "T-1",
            listName: "Work"
        });
        const range = await read(alice, true);
        expect(range.tasks.map((task) => [task.source, task.title])).toEqual([
            ["calendar", "Taxes"],
            ["tasks", "Write report"]
        ]);
        expect(range.tasks[0]?.due).toBe("2026-10-20T10:00:00.000Z");
        // Each carries the state it is in, the way Tasks draws it: a calendar's
        // task as not started or done, a Tasks task as its own status.
        expect(range.tasks.map((task) => [task.statusType, task.statusColor])).toEqual([
            ["open", null],
            ["open", "#64748b"]
        ]);
        expect((await read(alice, false)).tasks).toEqual([]);
    });

    it("counts a row that does not parse instead of failing the window", async () => {
        db.insert("calendarObject", {
            calendarId: calendar,
            uid: "broken",
            ics: "BEGIN:VCALENDAR\r\nnot a calendar at all",
            startsAt: null,
            endsAt: null
        });
        const range = await read(alice);
        expect(range.unreadable).toBe(1);
        expect(range.occurrences.length).toBeGreaterThan(0);
    });

    it("skips what is in the trash and calendars the reader cannot reach", async () => {
        db.byId("calendarObject", privateId)!.deletedAt = new Date();
        const hidden = world.addCalendar(bob.id);
        world.storeEvent(hidden, {
            summary: "Bob only",
            start: world.at("2026-10-10T10:00:00"),
            end: world.at("2026-10-10T11:00:00")
        });
        const range = await occurrencesIn(alice, OCTOBER, {
            floatingZone: ZONE,
            emails: [],
            includeTasks: false,
            calendarIds: [calendar, hidden]
        });
        expect(range.occurrences.some((occurrence) => occurrence.objectId === privateId)).toBe(
            false
        );
        expect(range.occurrences.some((occurrence) => occurrence.calendarId === hidden)).toBe(
            false
        );
    });

    it("gives the editor a private event as busy only to a read-only sharee, in full to the owner", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        const hidden = await eventDetail(bob, {
            objectId: privateId,
            recurrenceKey: null,
            floatingZone: ZONE,
            emails: [bob.email]
        });
        expect(hidden.busyOnly).toBe(true);
        expect(hidden.event.summary).toBe("");
        expect(hidden.event.location).toBe("");
        expect(hidden.series).toBeNull();
        expect(JSON.stringify(hidden)).not.toContain("Clinic");
        expect(hidden.writable).toBe(false);
        const full = await eventDetail(alice, {
            objectId: privateId,
            recurrenceKey: null,
            floatingZone: ZONE,
            emails: [alice.email]
        });
        expect(full.event.summary).toBe("Doctor");
        expect(full.writable).toBe(true);

        const occurrence = await eventDetail(alice, {
            objectId: publicId,
            recurrenceKey: "2026-10-15T08:00:00.000Z",
            floatingZone: ZONE,
            emails: [alice.email]
        });
        expect(occurrence.event.start).toEqual({ dateTime: "2026-10-15T10:00:00", tzid: ZONE });
    });

    it("refuses a task's detail to a free/busy reader", async () => {
        const todo = world.storeItem(
            calendar,
            engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes" }))
        );
        world.addShare(calendar, { userId: bob.id }, "freebusy");
        await expect(todoDetail(bob, String(todo.id))).rejects.toThrow(
            world.en("errors.eventNotFound")
        );
        expect((await todoDetail(alice, String(todo.id))).todo.summary).toBe("Taxes");
    });

    it("reads the earliest objects of an overfull window and says it left some out", async () => {
        const stored = db.byId("calendarObject", publicId)!;
        const late = world.storeEvent(calendar, {
            uid: "late",
            summary: "Late",
            start: world.at("2026-10-30T09:00:00"),
            end: world.at("2026-10-30T10:00:00")
        });
        const crowd = Array.from({ length: 5000 }, (_, index) => ({
            ...stored,
            id: `018f2b7a-0000-7000-8000-${String(index).padStart(12, "0")}`
        }));
        const findMany = vi
            .spyOn(db.prisma.calendarObject, "findMany")
            .mockResolvedValueOnce([...crowd, late] as never);
        const range = await read(alice);
        expect(findMany.mock.calls[0]?.[0]).toMatchObject({
            orderBy: [{ startsAt: "asc" }, { id: "asc" }],
            take: 5001
        });
        expect(range.truncated).toBe(true);
        expect(range.occurrences.some((occurrence) => occurrence.objectId === late.id)).toBe(false);
        findMany.mockRestore();
        const whole = await read(alice);
        expect(whole.truncated).toBe(false);
        expect(whole.occurrences.some((occurrence) => occurrence.objectId === late.id)).toBe(true);
    });

    it("reads a floating time on the Overview card in the account's zone when the calendar follows it", async () => {
        const floating = world.storeEvent(calendar, {
            uid: "floating",
            summary: "Gym",
            start: world.at("2026-10-12T10:00:00", null),
            end: world.at("2026-10-12T11:00:00", null)
        });
        fake.timeZones.set(alice.id, "America/New_York");
        const gym = (await upcomingEvents(alice.id, 50, world.NOW)).find(
            (entry) => entry.id === floating.id
        );
        expect(gym?.start).toBe("2026-10-12T14:00:00.000Z");
    });

    it("answers invitations at the account address and proved addresses only", async () => {
        db.insert("userEmail", {
            userId: alice.id,
            email: "a.work@example.test",
            verifiedAt: new Date()
        });
        db.insert("userEmail", {
            userId: alice.id,
            email: "unproved@example.test",
            verifiedAt: null
        });
        db.insert("calendarSource", {
            userId: alice.id,
            kind: "caldav",
            label: "Alice@Cloud.example ",
            username: "alice"
        });
        expect((await addressesOf(alice)).sort()).toEqual([
            "a.work@example.test",
            "alice@example.test"
        ]);
    });

    it("does not let a source's label or username stand in for an address", async () => {
        db.insert("calendarSource", {
            userId: alice.id,
            kind: "ics",
            label: "ceo@corp.example",
            username: "cfo@corp.example"
        });
        expect(await addressesOf(alice)).toEqual(["alice@example.test"]);
        const board = world.storeEvent(calendar, {
            summary: "Board",
            organizer: { email: "ceo@corp.example", name: "CEO" },
            attendees: [
                {
                    email: "alice@example.test",
                    name: "",
                    partstat: "NEEDS-ACTION",
                    role: "REQ-PARTICIPANT",
                    rsvp: true,
                    type: "INDIVIDUAL"
                }
            ],
            start: world.at("2026-10-12T09:00:00"),
            end: world.at("2026-10-12T10:00:00")
        }).id as string;
        const opened = await eventDetail(alice, {
            objectId: board,
            recurrenceKey: null,
            floatingZone: ZONE,
            emails: await addressesOf(alice)
        });
        expect(opened.isOrganizer).toBe(false);
    });
});
