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
            alarms: [{ action: "DISPLAY", trigger: { kind: "relative", minutes: -10, related: "START" }, description: "" }]
        }).id as string;
        privateId = world.storeEvent(calendar, {
            summary: "Doctor",
            location: "Clinic",
            classification: "PRIVATE",
            extraComponents: [["BEGIN:VLOCATION", "UID:loc-1", "NAME:Clinic on Main Street", "END:VLOCATION"].join("\r\n")],
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
        expect(standups.every((occurrence) => occurrence.recurring && occurrence.editable && !occurrence.busyOnly)).toBe(true);
        expect(range.occurrences.map((occurrence) => occurrence.start)).toEqual([...range.occurrences.map((occurrence) => occurrence.start)].sort());
        expect(range.unreadable).toBe(0);
    });

    it("shows a writer everything, private events included", async () => {
        world.addShare(calendar, { userId: bob.id }, "write");
        const doctor = (await read(bob)).occurrences.find((occurrence) => occurrence.objectId === privateId)!;
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
        expect(doctor).toMatchObject({ summary: "", location: "", busyOnly: true, hasAlarms: false, attendeeCount: 0, editable: false });
    });

    it("shows a free/busy sharee nothing but busy blocks, and no tasks", async () => {
        world.addShare(calendar, { userId: bob.id }, "freebusy");
        world.storeItem(calendar, engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes", due: world.at("2026-10-20T12:00:00") })));
        const range = await read(bob, true);
        expect(range.occurrences.length).toBeGreaterThan(0);
        expect(range.occurrences.every((occurrence) => occurrence.busyOnly && occurrence.summary === "" && occurrence.location === "")).toBe(true);
        expect(range.tasks).toEqual([]);
    });

    it("lists a calendar's tasks due in the window, and the reader's Tasks-app tasks", async () => {
        world.storeItem(calendar, engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes", due: world.at("2026-10-20T12:00:00") })));
        world.storeItem(calendar, engine.todoItem(engine.newTodo({ uid: "todo-2", summary: "Next year", due: world.at("2027-01-20T12:00:00") })));
        fake.tasks.push({ id: "task-1", name: "Write report", due: "2026-10-12T00:00:00.000Z", timed: false, done: false, reference: "T-1", listName: "Work" });
        const range = await read(alice, true);
        expect(range.tasks.map((task) => [task.source, task.title])).toEqual([
            ["calendar", "Taxes"],
            ["tasks", "Write report"]
        ]);
        expect(range.tasks[0]?.due).toBe("2026-10-20T10:00:00.000Z");
        expect((await read(alice, false)).tasks).toEqual([]);
    });

    it("counts a row that does not parse instead of failing the window", async () => {
        db.insert("calendarObject", { calendarId: calendar, uid: "broken", ics: "BEGIN:VCALENDAR\r\nnot a calendar at all", startsAt: null, endsAt: null });
        const range = await read(alice);
        expect(range.unreadable).toBe(1);
        expect(range.occurrences.length).toBeGreaterThan(0);
    });

    it("skips what is in the trash and calendars the reader cannot reach", async () => {
        db.byId("calendarObject", privateId)!.deletedAt = new Date();
        const hidden = world.addCalendar(bob.id);
        world.storeEvent(hidden, { summary: "Bob only", start: world.at("2026-10-10T10:00:00"), end: world.at("2026-10-10T11:00:00") });
        const range = await occurrencesIn(alice, OCTOBER, { floatingZone: ZONE, emails: [], includeTasks: false, calendarIds: [calendar, hidden] });
        expect(range.occurrences.some((occurrence) => occurrence.objectId === privateId)).toBe(false);
        expect(range.occurrences.some((occurrence) => occurrence.calendarId === hidden)).toBe(false);
    });

    it("gives the editor a private event as busy only to a read-only sharee, in full to the owner", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        const hidden = await eventDetail(bob, { objectId: privateId, recurrenceKey: null, floatingZone: ZONE, emails: [bob.email] });
        expect(hidden.busyOnly).toBe(true);
        expect(hidden.event.summary).toBe("");
        expect(hidden.event.location).toBe("");
        expect(hidden.series).toBeNull();
        expect(JSON.stringify(hidden)).not.toContain("Clinic");
        expect(hidden.writable).toBe(false);
        const full = await eventDetail(alice, { objectId: privateId, recurrenceKey: null, floatingZone: ZONE, emails: [alice.email] });
        expect(full.event.summary).toBe("Doctor");
        expect(full.writable).toBe(true);

        const occurrence = await eventDetail(alice, { objectId: publicId, recurrenceKey: "2026-10-15T08:00:00.000Z", floatingZone: ZONE, emails: [alice.email] });
        expect(occurrence.event.start).toEqual({ dateTime: "2026-10-15T10:00:00", tzid: ZONE });
    });

    it("refuses a task's detail to a free/busy reader", async () => {
        const todo = world.storeItem(calendar, engine.todoItem(engine.newTodo({ uid: "todo-1", summary: "Taxes" })));
        world.addShare(calendar, { userId: bob.id }, "freebusy");
        await expect(todoDetail(bob, String(todo.id))).rejects.toThrow(world.en("errors.eventNotFound"));
        expect((await todoDetail(alice, String(todo.id))).todo.summary).toBe("Taxes");
    });

    it("answers invitations at the account address, proved addresses and linked accounts", async () => {
        db.insert("userEmail", { userId: alice.id, email: "a.work@example.test", verifiedAt: new Date() });
        db.insert("userEmail", { userId: alice.id, email: "unproved@example.test", verifiedAt: null });
        db.insert("calendarSource", { userId: alice.id, kind: "caldav", label: "Alice@Cloud.example ", username: "alice" });
        expect((await addressesOf(alice)).sort()).toEqual(["a.work@example.test", "alice@cloud.example", "alice@example.test"]);
    });
});
