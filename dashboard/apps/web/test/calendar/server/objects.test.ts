/**
 * The one write path for events: creating one derives its columns from the
 * text, editing a series touches this occurrence, the following ones or all of
 * them, a stale version is refused, moving keeps the event, deleting honours the
 * scope and ends in the trash, a copy is a new event nobody was invited to, and
 * an answer sets only the reader's own PARTSTAT.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import { addUser, fake } from "../fixtures/fake-host";
import * as engine from "@polaris-app/calendar/src/engine";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import { occurrencesIn } from "@polaris-app/calendar/src/lib/occurrences";
import * as world from "../fixtures/world";

const ZONE = "Europe/Madrid";

describe("calendar objects", () => {
    let alice: ReturnType<typeof addUser>;
    let bob: ReturnType<typeof addUser>;
    let calendar: string;

    beforeEach(() => {
        world.resetWorld();
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        bob = addUser({ name: "Bob", email: "bob@example.test" });
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
    });

    async function createSeries(): Promise<string> {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, { rule: world.weekly() }),
            floatingZone: ZONE
        });
        return objectId;
    }

    async function keysOf(objectId: string): Promise<string[]> {
        const range = await occurrencesIn(
            alice,
            { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") },
            { floatingZone: ZONE, emails: [alice.email], includeTasks: false }
        );
        return range.occurrences
            .filter((occurrence) => occurrence.objectId === objectId)
            .map((occurrence) => occurrence.recurrenceKey);
    }

    function version(objectId: string): string {
        return (db.byId("calendarObject", objectId)!.updatedAt as Date).toISOString();
    }

    it("derives the indexed columns from the text it stores", async () => {
        const single = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, { summary: "  Budget review ", location: "Room 4" }),
            floatingZone: ZONE
        });
        const row = db.byId("calendarObject", single.objectId)!;
        expect(row.summary).toBe("Budget review");
        expect(row.location).toBe("Room 4");
        expect(row.startsAt).toEqual(new Date("2026-10-08T08:00:00Z"));
        expect(row.endsAt).toEqual(new Date("2026-10-08T09:00:00Z"));
        expect(row.recurring).toBe(false);
        expect(row.uid).toBe(world.eventIn(row).uid);
        // Stamped when it was written here, never the epoch.
        expect(row.ics).toMatch(/^DTSTAMP:20[0-9]{6}T[0-9]{6}Z/m);
        expect(row.ics).not.toContain("DTSTAMP:19700101");

        const series = db.byId("calendarObject", await createSeries())!;
        expect(series.recurring).toBe(true);
        expect(series.endsAt).toBeNull();
        expect(world.eventIn(series).rule?.frequency).toBe("WEEKLY");
    });

    it("edits one occurrence of a weekly series as an override", async () => {
        const id = await createSeries();
        const [, second] = await keysOf(id);
        expect(second).toBe("2026-10-15T08:00:00.000Z");
        await objects.saveEvent(alice, {
            objectId: id,
            recurrenceKey: second!,
            scope: "this",
            version: version(id),
            event: world.input(calendar, {
                summary: "Moved once",
                start: world.at("2026-10-15T12:00:00"),
                end: world.at("2026-10-15T13:00:00")
            }),
            floatingZone: ZONE
        });
        const item = world.itemIn(db.byId("calendarObject", id));
        if (item.component !== "VEVENT") throw new Error("not an event");
        expect(item.master?.summary).toBe("Planning");
        expect(item.overrides).toHaveLength(1);
        expect(item.overrides[0]?.summary).toBe("Moved once");
        expect(item.overrides[0]?.recurrenceId).toEqual({
            dateTime: "2026-10-15T10:00:00",
            tzid: ZONE
        });
        expect(world.objectsIn(calendar)).toHaveLength(1);
    });

    it("splits a series for this and the following occurrences", async () => {
        const id = await createSeries();
        const keys = await keysOf(id);
        await objects.saveEvent(alice, {
            objectId: id,
            recurrenceKey: keys[2]!,
            scope: "following",
            version: version(id),
            event: world.input(calendar, {
                summary: "Later planning",
                start: world.at("2026-10-22T16:00:00"),
                end: world.at("2026-10-22T17:00:00"),
                rule: world.weekly()
            }),
            floatingZone: ZONE
        });
        const rows = world.objectsIn(calendar);
        expect(rows).toHaveLength(2);
        const original = rows.find((row) => row.id === id)!;
        const split = rows.find((row) => row.id !== id)!;
        expect(split.uid).not.toBe(original.uid);
        expect(world.eventIn(split).summary).toBe("Later planning");
        expect(original.endsAt).not.toBeNull();
        expect((original.endsAt as Date).getTime()).toBeLessThanOrEqual(
            new Date("2026-10-22T08:00:00Z").getTime()
        );
        expect(await keysOf(id)).toEqual(["2026-10-08T08:00:00.000Z", "2026-10-15T08:00:00.000Z"]);
    });

    it("changes every occurrence with scope all", async () => {
        const id = await createSeries();
        const keys = await keysOf(id);
        await objects.saveEvent(alice, {
            objectId: id,
            recurrenceKey: keys[1]!,
            scope: "all",
            version: version(id),
            event: world.input(calendar, {
                summary: "Weekly sync",
                start: world.at("2026-10-15T10:00:00"),
                end: world.at("2026-10-15T11:00:00"),
                rule: world.weekly()
            }),
            floatingZone: ZONE
        });
        expect(world.eventIn(db.byId("calendarObject", id)).summary).toBe("Weekly sync");
        expect(db.byId("calendarObject", id)!.summary).toBe("Weekly sync");
    });

    it("refuses a save made on a version that changed meanwhile", async () => {
        const id = await createSeries();
        await expect(
            objects.saveEvent(alice, {
                objectId: id,
                recurrenceKey: null,
                scope: "all",
                version: "2026-09-01T00:00:00.000Z",
                event: world.input(calendar, { summary: "Stale" }),
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.changedMeanwhile"));
        expect(world.eventIn(db.byId("calendarObject", id)).summary).toBe("Planning");
    });

    it("moves an event to another calendar keeping its id, its UID and who was invited, without inviting them again", async () => {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, { attendees: [{ email: "guest@outside.test" }] }),
            floatingZone: ZONE
        });
        expect(fake.mails).toHaveLength(1);
        const uid = db.byId("calendarObject", objectId)!.uid;
        const other = world.addCalendar(alice.id, { name: "Home" });
        const moved = await objects.saveEvent(alice, {
            objectId,
            recurrenceKey: null,
            scope: "all",
            version: version(objectId),
            event: world.input(other, { attendees: [{ email: "guest@outside.test" }] }),
            floatingZone: ZONE
        });
        await world.settle();
        const row = db.byId("calendarObject", moved.objectId);
        expect(row?.calendarId).toBe(other);
        expect(row?.uid).toBe(uid);
        expect(row?.deletedAt).toBeNull();
        expect(world.objectsIn(calendar)).toHaveLength(0);
        expect(db.rows("calendarInvitation").map((invitation) => invitation.email)).toEqual([
            "guest@outside.test"
        ]);
        expect(fake.mails).toHaveLength(1);
    });

    it("refuses a move onto a calendar that already holds the same UID", async () => {
        const id = await createSeries();
        const other = world.addCalendar(alice.id, { name: "Home" });
        world.storeEvent(other, {
            uid: String(db.byId("calendarObject", id)!.uid),
            start: world.at("2026-10-09T10:00:00"),
            end: world.at("2026-10-09T11:00:00")
        });
        await expect(
            objects.saveEvent(alice, {
                objectId: id,
                recurrenceKey: null,
                scope: "all",
                version: version(id),
                event: world.input(other, { rule: world.weekly() }),
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.alreadyThere"));
        expect(db.byId("calendarObject", id)?.calendarId).toBe(calendar);
    });

    it("deletes one occurrence, the following ones, or the whole series into the trash", async () => {
        const id = await createSeries();
        let keys = await keysOf(id);
        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: keys[1]!,
            scope: "this",
            floatingZone: ZONE
        });
        keys = await keysOf(id);
        expect(keys).not.toContain("2026-10-15T08:00:00.000Z");
        expect(world.eventIn(db.byId("calendarObject", id)).exdates).toHaveLength(1);

        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: "2026-10-29T09:00:00.000Z",
            scope: "following",
            floatingZone: ZONE
        });
        expect(await keysOf(id)).toEqual(["2026-10-08T08:00:00.000Z", "2026-10-22T08:00:00.000Z"]);
        expect(db.byId("calendarObject", id)?.deletedAt).toBeNull();

        await objects.deleteEvent(alice, {
            objectId: id,
            recurrenceKey: keys[0]!,
            scope: "all",
            floatingZone: ZONE
        });
        expect(db.byId("calendarObject", id)?.deletedAt).toBeInstanceOf(Date);
        expect(await keysOf(id)).toEqual([]);
        await expect(objects.writableObject(alice, id)).rejects.toThrow(
            world.en("errors.eventNotFound")
        );
    });

    it("duplicates under a new UID and invites nobody", async () => {
        const { objectId } = await objects.saveEvent(alice, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, { attendees: [{ email: "guest@outside.test" }] }),
            floatingZone: ZONE
        });
        fake.mails.length = 0;
        const copy = await objects.duplicateEvent(alice, objectId, ZONE);
        const original = db.byId("calendarObject", objectId)!;
        const duplicated = db.byId("calendarObject", copy)!;
        expect(duplicated.uid).not.toBe(original.uid);
        expect(world.eventIn(duplicated).summary).toBe("Planning");
        expect(fake.mails).toEqual([]);
        expect(
            db.rows("calendarInvitation").filter((invitation) => invitation.objectId === copy)
        ).toEqual([]);
    });

    it("pastes one occurrence of a series as a single new event at another time, inviting nobody", async () => {
        const id = await createSeries();
        const shared = world.addCalendar(bob.id, { name: "Bob's" });
        world.addShare(calendar, { userId: bob.id }, "read");
        fake.mails.length = 0;
        const keys = await keysOf(id);
        // Bob reads Alice's calendar and pastes her second meeting into his own.
        const pasted = await objects.pasteEvent(bob, {
            objectId: id,
            recurrenceKey: keys[1]!,
            calendarId: shared,
            start: world.at("2026-10-20T15:00:00"),
            end: world.at("2026-10-20T16:00:00"),
            floatingZone: ZONE
        });
        const row = db.byId("calendarObject", pasted)!;
        const event = world.eventIn(row);
        expect(row.calendarId).toBe(shared);
        expect(row.uid).not.toBe(db.byId("calendarObject", id)!.uid);
        expect(event.summary).toBe("Planning");
        expect(event.rule).toBeNull();
        expect(event.recurrenceId).toBeNull();
        expect(event.start).toEqual(world.at("2026-10-20T15:00:00"));
        expect(fake.mails).toEqual([]);
    });

    it("refuses pasting into a calendar the reader cannot write", async () => {
        const id = await createSeries();
        const readOnly = world.addCalendar(bob.id, { name: "Bob's" });
        world.addShare(readOnly, { userId: alice.id }, "read");
        await expect(
            objects.pasteEvent(alice, {
                objectId: id,
                recurrenceKey: null,
                calendarId: readOnly,
                start: world.at("2026-10-20T15:00:00"),
                end: world.at("2026-10-20T16:00:00"),
                floatingZone: ZONE
            })
        ).rejects.toThrow();
        expect(world.objectsIn(readOnly)).toHaveLength(0);
    });

    it("moves a whole event to another calendar from the menu, keeping its id and UID", async () => {
        const id = await createSeries();
        const uid = db.byId("calendarObject", id)!.uid;
        const other = world.addCalendar(alice.id, { name: "Home" });
        expect(await objects.moveEvent(alice, { objectId: id, calendarId: other, floatingZone: ZONE })).toBe(id);
        await world.settle();
        expect(db.byId("calendarObject", id)?.calendarId).toBe(other);
        expect(db.byId("calendarObject", id)?.uid).toBe(uid);
        expect(await keysOf(id)).toHaveLength(4);
    });

    it("colours a whole event and gives it back the calendar's colour", async () => {
        const id = await createSeries();
        const keys = await keysOf(id);
        // One occurrence moved on its own, so the series has an override.
        await objects.shiftEvent(alice, {
            objectId: id,
            recurrenceKey: keys[1]!,
            startDeltaMs: 3_600_000,
            endDeltaMs: 3_600_000,
            scope: "this",
            version: null,
            floatingZone: ZONE
        });
        await objects.setEventColor(alice, { objectId: id, color: "#d62728", floatingZone: ZONE });
        const colored = world.itemIn(db.byId("calendarObject", id));
        expect(colored.component === "VEVENT" && colored.master?.color).toBe("#d62728");
        expect(colored.component === "VEVENT" && colored.overrides.map((event) => event.color)).toEqual(["#d62728"]);
        await objects.setEventColor(alice, { objectId: id, color: null, floatingZone: ZONE });
        expect(world.eventIn(db.byId("calendarObject", id)).color).toBeNull();
    });

    it("refuses colouring an event on a calendar shared read-only", async () => {
        const id = await createSeries();
        world.addShare(calendar, { userId: bob.id }, "read");
        await expect(
            objects.setEventColor(bob, { objectId: id, color: "#d62728", floatingZone: ZONE })
        ).rejects.toThrow();
        expect(world.eventIn(db.byId("calendarObject", id)).color).toBeNull();
    });

    it("sets the reader's own answer, on a calendar they only read", async () => {
        const shared = world.addCalendar(alice.id, { name: "Team" });
        world.addShare(shared, { userId: bob.id }, "read");
        const row = world.storeEvent(shared, {
            summary: "Review",
            start: world.at("2026-10-09T10:00:00"),
            end: world.at("2026-10-09T11:00:00"),
            organizer: { email: alice.email, name: "Alice" },
            attendees: [
                {
                    email: bob.email,
                    name: "Bob",
                    role: "REQ-PARTICIPANT",
                    partstat: "NEEDS-ACTION",
                    rsvp: true,
                    type: "INDIVIDUAL"
                },
                {
                    email: "carol@example.test",
                    name: "Carol",
                    role: "REQ-PARTICIPANT",
                    partstat: "NEEDS-ACTION",
                    rsvp: true,
                    type: "INDIVIDUAL"
                }
            ]
        });
        await objects.respondToEvent(bob, {
            objectId: String(row.id),
            recurrenceKey: null,
            partstat: "ACCEPTED",
            emails: [bob.email],
            floatingZone: ZONE
        });
        const attendees = world.eventIn(db.byId("calendarObject", String(row.id))).attendees;
        expect(attendees.find((attendee) => attendee.email === bob.email)?.partstat).toBe(
            "ACCEPTED"
        );
        expect(
            attendees.find((attendee) => attendee.email === "carol@example.test")?.partstat
        ).toBe("NEEDS-ACTION");

        await expect(
            objects.respondToEvent(bob, {
                objectId: String(row.id),
                recurrenceKey: null,
                partstat: "DECLINED",
                emails: ["other@example.test"],
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.notInvited"));
    });

    it("refuses an answer on a read-only calendar instead of leaving it waiting forever", async () => {
        const feed = world.addCalendar(bob.id, { name: "Feed", readOnly: true });
        const row = world.storeEvent(feed, {
            start: world.at("2026-10-09T10:00:00"),
            end: world.at("2026-10-09T11:00:00"),
            organizer: { email: "carol@example.test", name: "Carol" },
            attendees: [
                {
                    email: bob.email,
                    name: "Bob",
                    role: "REQ-PARTICIPANT",
                    partstat: "NEEDS-ACTION",
                    rsvp: true,
                    type: "INDIVIDUAL"
                }
            ]
        });
        const before = String(row.ics);
        await expect(
            objects.respondToEvent(bob, {
                objectId: String(row.id),
                recurrenceKey: null,
                partstat: "ACCEPTED",
                emails: [bob.email],
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.readOnly"));
        expect(db.byId("calendarObject", String(row.id))?.ics).toBe(before);
        expect(db.byId("calendarObject", String(row.id))?.pendingPush ?? "").toBe("");
    });

    it("refuses writing to a calendar shared read-only", async () => {
        const shared = world.addCalendar(alice.id, { name: "Team" });
        world.addShare(shared, { userId: bob.id }, "read");
        const row = world.storeEvent(shared, {
            start: world.at("2026-10-09T10:00:00"),
            end: world.at("2026-10-09T11:00:00")
        });
        await expect(objects.duplicateEvent(bob, String(row.id), ZONE)).rejects.toThrow(
            world.en("errors.calendarNotFound")
        );
        await expect(
            objects.saveEvent(bob, {
                objectId: null,
                recurrenceKey: null,
                scope: "all",
                version: null,
                event: world.input(shared),
                floatingZone: ZONE
            })
        ).rejects.toThrow(world.en("errors.calendarNotFound"));
        expect(engine.parseCalendarText(String(row.ics)).items).toHaveLength(1);
    });
});
