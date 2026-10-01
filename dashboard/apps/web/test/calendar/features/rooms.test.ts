/**
 * Rooms: only somebody who changes instance settings keeps the list; a room
 * invited to an event answers for itself - it accepts and holds the time when
 * it is free, declines and holds nothing when it is taken - and the answer is
 * on the organizer's copy. It is never mailed, and lets go when uninvited.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import { db } from "../fixtures/fake-db";
import * as world from "../fixtures/world";
import * as engine from "@polaris-app/calendar/src/engine";
import { addUser, fake } from "../fixtures/fake-host";
import * as objects from "@polaris-app/calendar/src/lib/objects";
import * as resources from "@polaris-app/calendar/src/lib/resources";
import { resourceAddress, resourceIdOf } from "@polaris-app/calendar/src/lib/resource-address";

const ZONE = "Europe/Madrid";

describe("rooms", () => {
    let admin: ReturnType<typeof addUser>;
    let alice: ReturnType<typeof addUser>;
    let calendar: string;
    let room: Awaited<ReturnType<typeof resources.createRoom>>;
    const locks: string[] = [];
    // The CalendarLease table, as the two statements a lease is made of see it.
    const leases = new Map<string, bigint>();
    let transactions = 0;

    beforeEach(async () => {
        world.resetWorld();
        locks.length = 0;
        leases.clear();
        transactions = 0;
        // What Postgres is asked for; the fake has no raw SQL of its own.
        const client = db.prisma as unknown as Record<string, unknown>;
        client.$executeRaw = async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const sql = parts.join("?");
            locks.push(`${sql} ${values.join(" ")}`);
            if (sql.startsWith('INSERT INTO "CalendarLease"')) {
                const [key, until, now] = values as [string, bigint, bigint];
                const held = leases.get(key);
                if (held !== undefined && held >= now) return 0;
                leases.set(key, until);
                return 1;
            }
            if (sql.startsWith('DELETE FROM "CalendarLease"')) {
                const [key, until] = values as [string, bigint];
                if (leases.get(key) !== until) return 0;
                leases.delete(key);
                return 1;
            }
            throw new Error(`unexpected raw SQL: ${sql}`);
        };
        const transaction = db.prisma.$transaction.bind(db.prisma);
        client.$transaction = async (work: unknown) => {
            transactions += 1;
            return transaction(work as never);
        };
        admin = addUser({ name: "Admin", email: "admin@example.test", isAdmin: true });
        alice = addUser({ name: "Alice", email: "alice@example.test" });
        fake.granted.set(admin.id, new Set(["settings.manage"]));
        calendar = world.addCalendar(alice.id, { timezone: ZONE });
        room = await resources.createRoom(admin as never, {
            name: "Board room",
            type: "room",
            capacity: 10,
            building: "HQ",
            floor: "2",
            features: ["Screen"],
            color: "#3b82f6",
            description: ""
        });
    });

    async function book(
        start: string,
        end: string,
        summary = "Review",
        fields: Record<string, unknown> = {}
    ): Promise<string> {
        const { objectId } = await objects.saveEvent(alice as never, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, {
                summary,
                start: world.at(start),
                end: world.at(end),
                attendees: [{ email: room.email, name: room.name, type: "ROOM" }],
                ...fields
            }),
            floatingZone: ZONE
        });
        return objectId;
    }

    function roomAnswer(objectId: string) {
        return world
            .eventIn(db.byId("calendarObject", objectId))
            .attendees.find((attendee) => attendee.email === room.email)?.partstat;
    }

    it("has one address format, never deliverable, read back to its calendar", () => {
        expect(room.email).toBe(resourceAddress(room.id));
        expect(room.email.endsWith("@resource.invalid")).toBe(true);
        expect(resourceIdOf(room.email)).toBe(room.id);
        expect(resourceIdOf("room-x@resource.invalid")).toBeNull();
        expect(resourceIdOf("alice@example.test")).toBeNull();
    });

    it("is kept by administrators only", async () => {
        await expect(
            resources.createRoom(alice as never, {
                name: "Mine",
                type: "room",
                capacity: null,
                building: "",
                floor: "",
                features: [],
                color: "#3b82f6",
                description: ""
            })
        ).rejects.toThrow(world.en("rooms.notAllowed"));
        await expect(resources.removeRoom(alice as never, room.id)).rejects.toThrow(
            world.en("rooms.notAllowed")
        );
    });

    it("accepts a free time, holds it in its calendar, and is never mailed", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        expect(roomAnswer(id)).toBe("ACCEPTED");
        const held = world.objectsIn(room.id);
        expect(held).toHaveLength(1);
        expect(world.eventIn(held[0]).summary).toBe("Review");
        expect(fake.mails).toEqual([]);
        const rooms = await resources.roomsFor({
            from: new Date("2026-10-06T08:30:00Z"),
            to: new Date("2026-10-06T09:30:00Z")
        });
        expect(rooms.find((entry) => entry.id === room.id)?.free).toBe(false);
    });

    it("declines a time it is already taken for, and holds nothing", async () => {
        await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        const clash = await book("2026-10-06T10:30:00", "2026-10-06T11:30:00", "Clash");
        expect(roomAnswer(clash)).toBe("DECLINED");
        expect(world.objectsIn(room.id).map((row) => world.eventIn(row).summary)).toEqual([
            "Review"
        ]);
    });

    it("lets go of the time when the event is deleted", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        await objects.deleteEvent(alice as never, {
            objectId: id,
            recurrenceKey: null,
            scope: "all",
            floatingZone: ZONE
        });
        expect(world.objectsIn(room.id)[0]?.deletedAt).toBeInstanceOf(Date);
        const again = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00", "Again");
        expect(roomAnswer(again)).toBe("ACCEPTED");
    });

    it("accepts only one of two invitations into the same slot that arrive together", async () => {
        const [first, second] = await Promise.all([
            book("2026-10-06T10:00:00", "2026-10-06T11:00:00", "First"),
            book("2026-10-06T10:30:00", "2026-10-06T11:30:00", "Second")
        ]);
        expect([roomAnswer(first), roomAnswer(second)].sort()).toEqual(["ACCEPTED", "DECLINED"]);
        expect(world.objectsIn(room.id).filter((row) => !row.deletedAt)).toHaveLength(1);
        expect(locks.length).toBeGreaterThan(0);
        expect(
            locks.every((lock) => lock.includes("CalendarLease") && lock.includes(room.id))
        ).toBe(true);
        expect(leases.size).toBe(0);
    });

    it("answers holding no transaction open, so answers for many rooms at once cannot drain the connection pool", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        expect(roomAnswer(id)).toBe("ACCEPTED");
        expect(transactions).toBe(0);
        expect(locks.filter((lock) => lock.startsWith("INSERT"))).toHaveLength(1);
        expect(locks.filter((lock) => lock.startsWith("DELETE"))).toHaveLength(1);
    });

    it("waits for a lease another server holds, and takes it once it has run out", async () => {
        leases.set(`polaris.calendar.room:${room.id}`, BigInt(Date.now() + 5_000));
        setTimeout(() => vi.setSystemTime(Date.now() + 10_000), 300);
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        expect(roomAnswer(id)).toBe("ACCEPTED");
        expect(locks.filter((lock) => lock.startsWith("INSERT")).length).toBeGreaterThan(1);
        expect(leases.size).toBe(0);
    });

    it("keeps only the time and the organizer of a booking, and the title only when it is public", async () => {
        await book("2026-10-06T10:00:00", "2026-10-06T11:00:00", "Salaries", {
            description: "Who earns what",
            location: "Board room",
            classification: "PRIVATE",
            attendees: [
                { email: room.email, name: room.name, type: "ROOM" },
                { email: "guest@outside.test" }
            ]
        });
        const held = world.eventIn(world.objectsIn(room.id)[0]);
        expect(held).toMatchObject({ summary: "", description: "", location: "", alarms: [] });
        expect(held.organizer?.email).toBe(alice.email);
        expect(held.attendees.map((attendee) => [attendee.email, attendee.partstat])).toEqual([
            [room.email, "ACCEPTED"]
        ]);
        const rooms = await resources.roomsFor({
            from: new Date("2026-10-06T08:30:00Z"),
            to: new Date("2026-10-06T09:30:00Z")
        });
        expect(rooms.find((entry) => entry.id === room.id)?.free).toBe(false);
    });

    it("never lets somebody else's event under the same UID change or release a booking", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        const uid = String(db.byId("calendarObject", id)!.uid);
        const mallory = addUser({ name: "Mallory", email: "mallory@example.test" });
        const forged = engine.eventItem(
            world.event({
                uid,
                summary: "Mine now",
                start: world.at("2026-10-07T10:00:00"),
                end: world.at("2026-10-07T11:00:00"),
                organizer: { email: mallory.email, name: "Mallory" },
                attendees: [
                    {
                        email: room.email,
                        name: room.name,
                        role: "NON-PARTICIPANT",
                        partstat: "NEEDS-ACTION",
                        rsvp: true,
                        type: "ROOM"
                    }
                ]
            })
        );
        expect(await resources.answerForRoom(mallory.id, room.id, forged, "REQUEST")).toBe(
            "DECLINED"
        );
        await resources.answerForRoom(mallory.id, room.id, forged, "CANCEL");
        const held = world.objectsIn(room.id);
        expect(held).toHaveLength(1);
        expect(held[0]?.deletedAt ?? null).toBeNull();
        expect(world.eventIn(held[0])).toMatchObject({
            summary: "Review",
            organizer: { email: alice.email }
        });
        expect(roomAnswer(id)).toBe("ACCEPTED");
    });
});
