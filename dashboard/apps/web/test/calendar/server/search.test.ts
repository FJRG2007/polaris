/**
 * Searching across all time: the title, the place, the description and who is
 * invited, in any case; only calendars the reader may read in full, and never a
 * private event on a read-only share; a series answers with its next occurrence.
 * Also the calendar list around it: a first calendar made for a newcomer, and
 * a reader's own order and colour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import { searchEvents } from "@polaris-app/calendar/src/lib/search";
import { eventTitles } from "@polaris-app/calendar/src/lib/event-titles";
import * as calendars from "@polaris-app/calendar/src/lib/calendars";

const ZONE = "Europe/Madrid";

describe("calendar search", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { name: "Work" });
        world.storeEvent(calendar, { uid: "a", summary: "Quarterly Budget", location: "HQ", start: world.at("2026-06-01T10:00:00"), end: world.at("2026-06-01T11:00:00") });
        world.storeEvent(calendar, {
            uid: "b",
            summary: "Lunch",
            description: "Talk about the BUDGET cuts",
            start: world.at("2026-10-05T13:00:00"),
            end: world.at("2026-10-05T14:00:00")
        });
        world.storeEvent(calendar, {
            uid: "c",
            summary: "Budget therapy",
            classification: "PRIVATE",
            start: world.at("2026-10-06T09:00:00"),
            end: world.at("2026-10-06T10:00:00")
        });
        world.storeEvent(calendar, {
            uid: "d",
            summary: "Weekly budget sync",
            start: world.at("2026-01-01T09:00:00"),
            end: world.at("2026-01-01T09:30:00"),
            rule: engine.parseRule("FREQ=WEEKLY")
        });
        world.storeEvent(calendar, { uid: "e", summary: "Old budget", start: world.at("2026-02-01T09:00:00"), end: world.at("2026-02-01T10:00:00") }, { deletedAt: new Date() });
    });

    const search = (user: ReturnType<typeof addUser>, query: string) => searchEvents(user, query, { floatingZone: ZONE, now: world.NOW });

    it("finds a word in the title, the description or the place, in any case", async () => {
        const hits = await search(alice, "budget");
        expect(hits.map((hit) => hit.summary).sort()).toEqual(["Budget therapy", "Lunch", "Quarterly Budget", "Weekly budget sync"]);
        expect((await search(alice, "hq")).map((hit) => hit.summary)).toEqual(["Quarterly Budget"]);
        expect(await search(alice, "b")).toEqual([]);
    });

    it("answers a series with its next occurrence", async () => {
        const [weekly] = (await search(alice, "weekly")).filter((hit) => hit.summary === "Weekly budget sync");
        expect(weekly?.start).toBe("2026-10-08T07:00:00.000Z");
        expect(weekly?.recurring).toBe(true);
    });

    it("hides private events from a read-only sharee and searches nothing seen as free/busy", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        expect((await search(bob, "budget")).map((hit) => hit.summary).sort()).toEqual(["Lunch", "Quarterly Budget", "Weekly budget sync"]);
        db.rows("calendarShare")[0]!.access = "freebusy";
        expect(await search(bob, "budget")).toEqual([]);
    });

    it("hides a private task from a read-only sharee and shows it to a writer", async () => {
        const tasks = world.addCalendar(alice.id, { name: "Chores", components: "VEVENT,VTODO" });
        const task = engine.newTodo({ uid: "todo-private", summary: "Budget lawyer", due: world.at("2026-10-20T12:00:00") });
        world.storeItem(tasks, engine.todoItem({ ...task, extra: [{ line: "CLASS:PRIVATE" }] }));
        world.storeItem(tasks, engine.todoItem(engine.newTodo({ uid: "todo-public", summary: "Budget review", due: world.at("2026-10-21T12:00:00") })));
        const share = world.addShare(tasks, { userId: bob.id }, "read");
        expect((await search(bob, "budget")).map((hit) => hit.summary)).toEqual(["Budget review"]);
        db.byId("calendarShare", share)!.access = "write";
        expect((await search(bob, "budget")).map((hit) => hit.summary).sort()).toEqual(["Budget lawyer", "Budget review"]);
    });

    it("names events and tasks for a link only to who may use the Calendar and read them, never from the trash", async () => {
        const task = engine.newTodo({ uid: "todo-private", summary: "Lawyer", due: world.at("2026-10-20T12:00:00") });
        const privateTask = String(world.storeItem(calendar, engine.todoItem({ ...task, extra: [{ line: "CLASS:PRIVATE" }] })).id);
        const ids = db.rows("calendarObject").map((row) => String(row.id));
        const lunch = String(db.rows("calendarObject").find((row) => row.summary === "Lunch")!.id);
        world.addShare(calendar, { userId: bob.id }, "read");
        const named = await eventTitles(bob.id, ids);
        expect(named[lunch]).toBe("Lunch");
        expect(named[privateTask]).toBeUndefined();
        expect(Object.values(named)).not.toContain("Budget therapy");
        expect((await eventTitles(alice.id, ids))[privateTask]).toBe("Lawyer");

        fake.denied.set(bob.id, new Set(["calendar.use"]));
        expect(await eventTitles(bob.id, ids)).toEqual({});
        db.byId("calendar", calendar)!.trashedAt = new Date();
        expect(await eventTitles(alice.id, ids)).toEqual({});
    });

    it("makes a newcomer a calendar of their own, lists what they reach, and keeps their order and colour", async () => {
        const list = await calendars.listCalendars(bob);
        expect(list.map((entry) => [entry.name, entry.reach])).toEqual([[world.en("calendars.personal"), "owner"]]);
        world.addShare(calendar, { userId: bob.id }, "read");
        const personal = list[0]!.id;
        await calendars.reorderCalendars(bob, [calendar, personal, "018f2b7a-0000-7000-8000-00000000dead"]);
        await calendars.setDisplay(bob, calendar, { color: "#ff7f0e" });
        const again = await calendars.listCalendars(bob);
        expect(again.map((entry) => entry.id)).toEqual([calendar, personal]);
        expect(again[0]).toMatchObject({ color: "#ff7f0e", ownColor: "#3b82f6", reach: "read", writable: false, owner: { id: alice.id, name: "Alice" }, publicToken: null });
        expect((await calendars.listCalendars(alice)).map((entry) => entry.id)).toEqual([calendar]);
        await expect(calendars.updateCalendar(bob, calendar, { name: "Mine now" })).rejects.toThrow(world.en("errors.calendarNotFound"));
    });

    it("takes a shared calendar out of a sharee's list, and refuses the owner leaving their own", async () => {
        world.addShare(calendar, { userId: bob.id }, "read");
        await calendars.leaveCalendar(bob, calendar);
        expect(db.rows("calendarShare")).toEqual([]);
        await expect(calendars.leaveCalendar(alice, calendar)).rejects.toThrow(world.en("errors.ownCalendar"));
    });
});
