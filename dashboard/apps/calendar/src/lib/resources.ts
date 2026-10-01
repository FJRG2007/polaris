/**
 * Rooms and equipment: calendars of kind `resource` that people invite to an
 * event the way they invite a person, at the address `resource-address.ts`
 * makes for each.
 *
 * Administrators (whoever may change instance settings) keep the list. Anybody
 * with the Calendar sees when each one is taken and may book it. A room answers
 * its own invitations: free for every occurrence of the event, it accepts and
 * the event is written into its calendar; taken for any, it declines and holds
 * nothing. Either answer is recorded on the organizer's copy.
 *
 * Server-only.
 */

import { calendarT } from "./i18n";
import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { calendarBusy } from "./freebusy";
import { CalendarRefusal } from "./errors";
import { readResource } from "./calendars";
import type { SessionUser } from "./access";
import { resourceAddress } from "./resource-address";
import type { RoomInput } from "./scheduling-schemas";
import type { RoomAvailability, RoomView } from "./scheduling-wire";
import { trashObject, tryItemOf, writeItem, type StoredObject } from "./objects";

/** Rooms one instance may keep. */
const MAX_ROOMS = 500;

/** How far ahead a repeating booking is checked against a room. */
const HORIZON_MS = 366 * 86_400_000;

const ROOM_COLUMNS = { id: true, name: true, description: true, color: true, resource: true } as const;

function roomView(row: { id: string; name: string; description: string; color: string; resource: string }): RoomView {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        color: row.color,
        email: resourceAddress(row.id),
        resource: readResource(row.resource) ?? { type: "room", capacity: null, building: "", floor: "", features: [] }
    };
}

/** Whether this person keeps the room list. */
export async function mayManageRooms(user: SessionUser): Promise<boolean> {
    return host.session.sessionCan(user, "settings.manage");
}

async function requireRoomManager(user: SessionUser): Promise<void> {
    if (!(await mayManageRooms(user))) throw new CalendarRefusal((await calendarT())("rooms.notAllowed"));
}

/** Every room and piece of equipment, by name. */
export async function listRooms(): Promise<RoomView[]> {
    const rows = await prisma.calendar.findMany({
        where: { kind: "resource", trashedAt: null },
        select: ROOM_COLUMNS,
        orderBy: { name: "asc" },
        take: MAX_ROOMS
    });
    return rows.map(roomView);
}

function stored(input: RoomInput) {
    return {
        name: input.name,
        color: input.color,
        description: input.description,
        resource: JSON.stringify({
            type: input.type,
            capacity: input.capacity,
            building: input.building,
            floor: input.floor,
            features: input.features
        })
    };
}

export async function createRoom(user: SessionUser, input: RoomInput): Promise<RoomView> {
    await requireRoomManager(user);
    const count = await prisma.calendar.count({ where: { kind: "resource", trashedAt: null } });
    if (count >= MAX_ROOMS) throw new CalendarRefusal((await calendarT())("rooms.tooMany"));
    const row = await prisma.calendar.create({
        data: { ownerId: user.id, kind: "resource", components: "VEVENT", ...stored(input) },
        select: ROOM_COLUMNS
    });
    return roomView(row);
}

async function existingRoom(id: string) {
    const row = await prisma.calendar.findFirst({ where: { id, kind: "resource", trashedAt: null }, select: { id: true } });
    if (!row) throw new CalendarRefusal((await calendarT())("rooms.notFound"));
    return row;
}

export async function updateRoom(user: SessionUser, id: string, input: RoomInput): Promise<RoomView> {
    await requireRoomManager(user);
    await existingRoom(id);
    const row = await prisma.calendar.update({ where: { id }, data: stored(input), select: ROOM_COLUMNS });
    return roomView(row);
}

/** Take a room off the list. Its calendar goes to the trash of whoever made it,
 *  so a room removed by mistake comes back with its bookings. */
export async function removeRoom(user: SessionUser, id: string): Promise<void> {
    await requireRoomManager(user);
    await existingRoom(id);
    await prisma.calendar.update({ where: { id }, data: { trashedAt: new Date() } });
}

/** Every room, with whether it is free between two instants. */
export async function roomsFor(window: { from: Date; to: Date }): Promise<RoomAvailability[]> {
    const rooms = await listRooms();
    const answers: RoomAvailability[] = [];
    for (const room of rooms) {
        const busy = await calendarBusy([room.id], window);
        answers.push({ ...room, free: busy.length === 0 });
    }
    return answers;
}

/** The stretches of time an event takes, within the horizon a room checks. */
function takenBy(item: engine.CalendarItem, now: Date): { start: Date; end: Date }[] {
    const window = { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + HORIZON_MS) };
    try {
        return engine
            .expandItem(item, window, { floatingZone: "UTC", limit: 500 })
            .filter((occurrence) => occurrence.event.status !== "CANCELLED" && occurrence.event.transparency !== "TRANSPARENT")
            .map((occurrence) => ({ start: occurrence.start, end: occurrence.end }));
    } catch {
        return [];
    }
}

/** A room's own copy of an event, if it holds one (in the trash or not). */
async function roomCopy(roomId: string, uid: string): Promise<StoredObject | null> {
    return prisma.calendarObject.findUnique({
        where: { calendarId_uid: { calendarId: roomId, uid } },
        select: {
            id: true,
            calendarId: true,
            uid: true,
            component: true,
            ics: true,
            href: true,
            etag: true,
            updatedAt: true,
            deletedAt: true
        }
    });
}

/** How the organizer's copy has the room answering now. */
function answerOnCopy(item: engine.CalendarItem, email: string): engine.PartStat | null {
    if (item.component !== "VEVENT") return null;
    const event = item.master ?? item.overrides[0];
    return event?.attendees.find((attendee) => attendee.email === email)?.partstat ?? null;
}

/**
 * A room was invited to (or dropped from) an organizer's event. Answers for the
 * room: holds the time when every occurrence is free, declines otherwise, and
 * lets go of the time when it is cancelled. Returns the answer given, or null
 * for an address that is no room.
 */
export async function answerForRoom(
    organizerId: string,
    roomId: string,
    item: engine.CalendarItem,
    method: "REQUEST" | "CANCEL",
    now = new Date()
): Promise<engine.PartStat | null> {
    const room = await prisma.calendar.findFirst({
        where: { id: roomId, kind: "resource", trashedAt: null },
        select: { id: true }
    });
    if (!room || item.component !== "VEVENT") return null;
    const email = resourceAddress(room.id);
    const existing = await roomCopy(room.id, item.uid);
    const context = { actor: null, floatingZone: "UTC", fromImport: true } as const;

    const release = async () => {
        if (existing && !existing.deletedAt) {
            const held = tryItemOf(existing.ics);
            if (held) await trashObject(existing, held, context);
        }
    };

    if (method === "CANCEL") {
        await release();
        return null;
    }

    const taken = takenBy(item, now);
    let free = true;
    if (taken.length > 0) {
        const window = {
            from: new Date(Math.min(...taken.map((slot) => slot.start.getTime()))),
            to: new Date(Math.max(...taken.map((slot) => slot.end.getTime())))
        };
        const busy = await calendarBusy([room.id], window, { skipUid: item.uid });
        free = !taken.some((slot) =>
            busy.some((interval) => interval.start.getTime() < slot.end.getTime() && interval.end.getTime() > slot.start.getTime())
        );
    }

    const answer: engine.PartStat = free ? "ACCEPTED" : "DECLINED";
    if (free) {
        const copy = { ...engine.applyReply(item, email, "ACCEPTED", null), method: null };
        await writeItem(room.id, existing, copy, context);
    } else {
        await release();
    }
    if (answerOnCopy(item, email) !== answer) {
        const invitations = await import("./invitations");
        await invitations.applyAnswer(organizerId, item.uid, email, answer, null);
    }
    return answer;
}
