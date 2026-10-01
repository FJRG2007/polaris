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

    beforeEach(async () => {
        world.resetWorld();
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

    async function book(start: string, end: string, summary = "Review"): Promise<string> {
        const { objectId } = await objects.saveEvent(alice as never, {
            objectId: null,
            recurrenceKey: null,
            scope: "all",
            version: null,
            event: world.input(calendar, {
                summary,
                start: world.at(start),
                end: world.at(end),
                attendees: [{ email: room.email, name: room.name, type: "ROOM" }]
            }),
            floatingZone: ZONE
        });
        return objectId;
    }

    function roomAnswer(objectId: string) {
        return world.eventIn(db.byId("calendarObject", objectId)).attendees.find((attendee) => attendee.email === room.email)?.partstat;
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
            resources.createRoom(alice as never, { name: "Mine", type: "room", capacity: null, building: "", floor: "", features: [], color: "#3b82f6", description: "" })
        ).rejects.toThrow(world.en("rooms.notAllowed"));
        await expect(resources.removeRoom(alice as never, room.id)).rejects.toThrow(world.en("rooms.notAllowed"));
    });

    it("accepts a free time, holds it in its calendar, and is never mailed", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        expect(roomAnswer(id)).toBe("ACCEPTED");
        const held = world.objectsIn(room.id);
        expect(held).toHaveLength(1);
        expect(world.eventIn(held[0]).summary).toBe("Review");
        expect(fake.mails).toEqual([]);
        const rooms = await resources.roomsFor({ from: new Date("2026-10-06T08:30:00Z"), to: new Date("2026-10-06T09:30:00Z") });
        expect(rooms.find((entry) => entry.id === room.id)?.free).toBe(false);
    });

    it("declines a time it is already taken for, and holds nothing", async () => {
        await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        const clash = await book("2026-10-06T10:30:00", "2026-10-06T11:30:00", "Clash");
        expect(roomAnswer(clash)).toBe("DECLINED");
        expect(world.objectsIn(room.id).map((row) => world.eventIn(row).summary)).toEqual(["Review"]);
    });

    it("lets go of the time when the event is deleted", async () => {
        const id = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00");
        await objects.deleteEvent(alice as never, { objectId: id, recurrenceKey: null, scope: "all", floatingZone: ZONE });
        expect(world.objectsIn(room.id)[0]?.deletedAt).toBeInstanceOf(Date);
        const again = await book("2026-10-06T10:00:00", "2026-10-06T11:00:00", "Again");
        expect(roomAnswer(again)).toBe("ACCEPTED");
    });
});
