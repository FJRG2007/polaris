/**
 * Who reaches a calendar and how far: the owner, a person or a team it is
 * shared with (the strongest share wins), everybody for a room's free/busy,
 * and nobody else - with unknown and unreachable ids refused in one sentence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import { CalendarRefusal } from "@polaris-app/calendar/src/lib/errors";
import { addTeam, addUser, fake, signIn } from "../fixtures/fake-host";
import { addCalendar, addShare, en, resetWorld } from "../fixtures/world";
import {
    apiCalendarUser,
    reachableCalendars,
    reaches,
    requireCalendar,
    requireCalendarUser,
    requireWritableCalendar
} from "@polaris-app/calendar/src/lib/access";

describe("calendar access", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let carol: ReturnType<typeof addUser>;

    beforeEach(() => {
        resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        carol = addUser({ name: "Carol", email: "carol@example.test" });
    });

    it("orders the levels from free/busy to owner", () => {
        expect(reaches("owner", "manage")).toBe(true);
        expect(reaches("write", "read")).toBe(true);
        expect(reaches("read", "write")).toBe(false);
        expect(reaches("freebusy", "read")).toBe(false);
        expect(reaches(null, "freebusy")).toBe(false);
    });

    it("gives the owner their own calendar, a sharee its level, a team member the team's", async () => {
        const mine = addCalendar(alice.id);
        const toBob = addCalendar(alice.id, { name: "Shared with Bob" });
        const toTeam = addCalendar(alice.id, { name: "Team" });
        addShare(toBob, { userId: bob.id }, "write");
        const team = addTeam("Design", [bob.id, carol.id]);
        addShare(toTeam, { teamId: team }, "freebusy");

        expect((await reachableCalendars(alice.id)).get(mine)).toBe("owner");
        const bobs = await reachableCalendars(bob.id);
        expect(bobs.get(toBob)).toBe("write");
        expect(bobs.get(toTeam)).toBe("freebusy");
        expect(bobs.has(mine)).toBe(false);
        const carols = await reachableCalendars(carol.id);
        expect([...carols.keys()]).toEqual([toTeam]);
    });

    it("takes the strongest of a personal share and a team share", async () => {
        const calendar = addCalendar(alice.id);
        const team = addTeam("Ops", [bob.id]);
        addShare(calendar, { userId: bob.id }, "read");
        addShare(calendar, { teamId: team }, "manage");
        expect((await reachableCalendars(bob.id)).get(calendar)).toBe("manage");
        expect((await requireCalendar(bob.id, calendar, "manage")).reach).toBe("manage");

        const other = addCalendar(alice.id);
        addShare(other, { userId: bob.id }, "write");
        addShare(other, { teamId: team }, "freebusy");
        expect((await reachableCalendars(bob.id)).get(other)).toBe("write");
    });

    it("keeps a trashed calendar for its owner only, and refuses it to everybody on requireCalendar", async () => {
        const calendar = addCalendar(alice.id, { trashedAt: new Date("2026-09-30T10:00:00Z") });
        addShare(calendar, { userId: bob.id }, "manage");
        expect((await reachableCalendars(alice.id)).get(calendar)).toBe("owner");
        expect((await reachableCalendars(bob.id)).has(calendar)).toBe(false);
        await expect(requireCalendar(bob.id, calendar, "freebusy")).rejects.toThrow(
            en("errors.calendarNotFound")
        );
        await expect(requireCalendar(alice.id, calendar, "read")).rejects.toBeInstanceOf(
            CalendarRefusal
        );
    });

    it("lets everybody see a room as free or busy, and no further", async () => {
        const room = addCalendar(carol.id, { kind: "resource", name: "Room 1" });
        expect((await requireCalendar(bob.id, room, "freebusy")).reach).toBe("freebusy");
        await expect(requireCalendar(bob.id, room, "read")).rejects.toThrow(
            en("errors.calendarNotFound")
        );
    });

    it("refuses an unknown id and an unreachable one with the same sentence", async () => {
        const calendar = addCalendar(alice.id);
        const unknown = await requireCalendar(
            bob.id,
            "018f2b7a-0000-7000-8000-00000000dead",
            "freebusy"
        ).catch((caught: Error) => caught);
        const unreachable = await requireCalendar(bob.id, calendar, "freebusy").catch(
            (caught: Error) => caught
        );
        expect(unknown).toBeInstanceOf(CalendarRefusal);
        expect(unreachable).toBeInstanceOf(CalendarRefusal);
        expect((unknown as Error).message).toBe((unreachable as Error).message);
    });

    it("refuses a read-only calendar for writing even to its owner", async () => {
        const feed = addCalendar(alice.id, { readOnly: true });
        await expect(requireWritableCalendar(alice.id, feed)).rejects.toThrow(
            en("errors.readOnly")
        );
        const shared = addCalendar(alice.id);
        addShare(shared, { userId: bob.id }, "read");
        await expect(requireWritableCalendar(bob.id, shared)).rejects.toThrow(
            en("errors.calendarNotFound")
        );
    });

    it("asks the session for calendar.use, and answers 403 on the API without it", async () => {
        signIn(alice);
        expect((await requireCalendarUser()).id).toBe(alice.id);
        fake.denied.set(alice.id, new Set(["calendar.use"]));
        await expect(requireCalendarUser()).rejects.toThrow(/NEXT_REDIRECT/);
        const refused = await apiCalendarUser();
        expect(refused).toBeInstanceOf(Response);
        expect((refused as Response).status).toBe(403);
        signIn(null);
        expect(((await apiCalendarUser()) as Response).status).toBe(401);
        expect(db.rows("calendar")).toHaveLength(0);
    });
});
